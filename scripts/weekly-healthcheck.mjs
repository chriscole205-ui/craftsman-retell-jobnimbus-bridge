#!/usr/bin/env node
// Weekly health check for the Retell AI -> JobNimbus bridge.
// Runs a battery of live checks and prints a compact PASS/FAIL report.
// Any created JobNimbus test records are marked "ZZDELETE-TESTLEAD" / Inactive.
//
// Usage: node scripts/weekly-healthcheck.mjs
// Requires .env in the parent dir (RETELL_API_KEY, JOBNIMBUS_API_KEY).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Retell from 'retell-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BRIDGE_URL = 'https://craftsman-retell-jobnimbus-bridge.onrender.com';
const AGENT_ID = 'agent_d52c7de504ded82183df06abcc';
const PHONE = '+12055610485';
const JN_BASE = 'https://app.jobnimbus.com/api1';

// --- load .env manually (no dep) ---
async function loadEnv() {
  try {
    const raw = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* env may be provided externally */ }
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function jn(path, opts = {}) {
  const res = await fetch(`${JN_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.JOBNIMBUS_API_KEY}`,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
}

async function main() {
  await loadEnv();
  const RK = process.env.RETELL_API_KEY;
  const JK = process.env.JOBNIMBUS_API_KEY;
  if (!RK || !JK) { record('credentials present', false, 'RETELL_API_KEY or JOBNIMBUS_API_KEY missing'); return finish(); }
  record('credentials present', true);

  // 1. Bridge health endpoint
  try {
    const r = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(30000) });
    const h = await r.json();
    record('bridge /health reachable', r.ok && h.ok === true, `startupMissing=${JSON.stringify(h.missingStartupConfig || [])}`);
  } catch (e) { record('bridge /health reachable', false, e.message); }

  // 2. Retell phone number still bound to agent
  try {
    const r = await fetch('https://api.retellai.com/list-phone-numbers', { headers: { Authorization: `Bearer ${RK}` } });
    const nums = await r.json();
    const mine = (nums || []).find((n) => n.phone_number === PHONE);
    const bound = mine?.inbound_agents?.some((a) => a.agent_id === AGENT_ID);
    record('Retell phone bound to agent', !!bound, mine ? `agent_version=${mine.inbound_agents?.[0]?.agent_version}` : 'phone not found');
  } catch (e) { record('Retell phone bound to agent', false, e.message); }

  // 3. Agent webhook URL points at the bridge
  try {
    const r = await fetch(`https://api.retellai.com/get-agent/${AGENT_ID}`, { headers: { Authorization: `Bearer ${RK}` } });
    const a = await r.json();
    const ok = (a.webhook_url || '').startsWith(BRIDGE_URL);
    record('agent webhook_url -> bridge', ok, a.webhook_url || 'none');
  } catch (e) { record('agent webhook_url -> bridge', false, e.message); }

  // 4. JobNimbus API key works
  try {
    const r = await jn('/contacts?size=1');
    record('JobNimbus API auth', r.status === 200, `http ${r.status}`);
  } catch (e) { record('JobNimbus API auth', false, e.message); }

  // 5. Recent call volume (sanity: is the line getting calls?)
  try {
    const r = await fetch('https://api.retellai.com/v2/list-calls', {
      method: 'POST', headers: { Authorization: `Bearer ${RK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 30, sort_order: 'descending' }),
    });
    const calls = await r.json();
    const weekAgo = Date.now() - 7 * 864e5;
    const recent = (calls || []).filter((c) => (c.start_timestamp || 0) >= weekAgo);
    record('calls in last 7 days', true, `${recent.length} calls (informational)`);
  } catch (e) { record('calls in last 7 days', false, e.message); }

  // 6. END-TO-END: signed webhook -> JobNimbus contact + task (the real test)
  let createdId = null;
  try {
    const uniq = Date.now().toString().slice(-7);
    const event = {
      event: 'call_analyzed',
      call: {
        call_id: `zzt_weeklycheck_${Date.now()}`,
        from_number: `+1870555${uniq.slice(0, 4)}`,
        call_analysis: {
          call_successful: true,
          custom_analysis_data: {
            full_name: `ZZ Weekly Check ${uniq}`,
            best_callback_number: `870-555-${uniq.slice(0, 4)}`,
            property_address: '100 Test Ln', city: 'Hoover', state: 'AL', zip: '35226',
            issue_type: 'Automated weekly health check',
            detailed_call_summary: 'Synthetic lead from weekly cron health check.',
          },
        },
      },
    };
    const raw = JSON.stringify(event);
    const sig = Retell.verify ? Retell.sign(raw, RK) : Retell.sign(raw, RK);
    const r = await fetch(`${BRIDGE_URL}/webhooks/retell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-retell-signature': sig },
      body: raw,
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    createdId = j.contactId || null;
    const ok = r.status === 200 && !!j.contactId && !!j.taskId;
    record('END-TO-END webhook -> lead+task', ok, ok ? `contact=${j.contactId} task=${j.taskId}` : `http ${r.status} ${j.error || ''}`);
  } catch (e) { record('END-TO-END webhook -> lead+task', false, e.message); }

  // 7. cleanup: mark the synthetic contact for deletion
  if (createdId) {
    try {
      await jn(`/contacts/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({ first_name: 'ZZDELETE-TESTLEAD', last_name: 'Ignore', status_name: 'Inactive' }),
      });
      record('cleanup synthetic lead', true, `${createdId} -> ZZDELETE-TESTLEAD/Inactive`);
    } catch (e) { record('cleanup synthetic lead', false, e.message); }
  }

  finish();
}

function finish() {
  const fails = results.filter((r) => !r.ok && !r.name.startsWith('calls in last'));
  console.log('\n==== SUMMARY ====');
  console.log(`${results.length - fails.length}/${results.length} checks passed`);
  if (fails.length) {
    console.log('OVERALL: FAIL');
    console.log('Failing:', fails.map((f) => f.name).join('; '));
    process.exitCode = 1;
  } else {
    console.log('OVERALL: PASS — pipeline healthy');
  }
}

main().catch((e) => { console.error('healthcheck crashed:', e); process.exitCode = 1; });
