import http from 'node:http';
import { URL, pathToFileURL } from 'node:url';
import Retell from 'retell-sdk';

const config = {
  port: Number(process.env.PORT || 8787),
  retellApiKey: process.env.RETELL_API_KEY || '',
  jobNimbusApiKey: process.env.JOBNIMBUS_API_KEY || '',
  jobNimbusBaseUrl: (process.env.JOBNIMBUS_BASE_URL || 'https://app.jobnimbus.com/api1').replace(/\/$/, ''),
  jobNimbusActor: process.env.JOBNIMBUS_ACTOR || '',
  contactRecordTypeName: process.env.JOBNIMBUS_CONTACT_RECORD_TYPE_NAME || 'Customer',
  contactStatusName: process.env.JOBNIMBUS_CONTACT_STATUS_NAME || 'Lead',
  sourceName: process.env.JOBNIMBUS_SOURCE_NAME || 'Retell AI',
  createJob: String(process.env.JOBNIMBUS_CREATE_JOB || 'false').toLowerCase() === 'true',
  jobRecordTypeName: process.env.JOBNIMBUS_JOB_RECORD_TYPE_NAME || 'Job',
  jobStatusName: process.env.JOBNIMBUS_JOB_STATUS_NAME || 'Lead',
  taskRecordTypeName: process.env.JOBNIMBUS_TASK_RECORD_TYPE_NAME || 'Phone Call',
  taskOwnerIds: splitCsv(process.env.JOBNIMBUS_TASK_OWNER_IDS || process.env.JOBNIMBUS_TASK_OWNER_ID || ''),
  scheduleOwnerIds: splitCsv(process.env.JOBNIMBUS_SCHEDULE_OWNER_IDS || process.env.JOBNIMBUS_SCHEDULE_OWNER_ID || process.env.JOBNIMBUS_TASK_OWNER_IDS || process.env.JOBNIMBUS_TASK_OWNER_ID || ''),
  slotMinutes: Number(process.env.JOBNIMBUS_SLOT_MINUTES || 60),
  workdayStartHour: Number(process.env.JOBNIMBUS_WORKDAY_START_HOUR || 8),
  workdayEndHour: Number(process.env.JOBNIMBUS_WORKDAY_END_HOUR || 17),
  lookaheadDays: Number(process.env.JOBNIMBUS_LOOKAHEAD_DAYS || 14),
  scheduleBufferMinutes: Number(process.env.JOBNIMBUS_SCHEDULE_BUFFER_MINUTES || 30),
  querySize: Number(process.env.JOBNIMBUS_QUERY_SIZE || 250),
};

const requiredForStartup = ['retellApiKey', 'jobNimbusApiKey'];
const missingStartupConfig = requiredForStartup.filter((key) => !config[key]);

function splitCsv(value = '') {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function splitName(fullName = '') {
  const clean = String(fullName).trim().replace(/\s+/g, ' ');
  if (!clean) return { firstName: '', lastName: '' };
  const pieces = clean.split(' ');
  if (pieces.length === 1) return { firstName: pieces[0], lastName: '' };
  return {
    firstName: pieces.slice(0, -1).join(' '),
    lastName: pieces.at(-1),
  };
}

function firstDefined(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(normalized)) return true;
    if (['false', 'no', 'n', '0'].includes(normalized)) return false;
  }
  return undefined;
}

function parseCityZip(value) {
  if (!value || typeof value !== 'string') {
    return { city: undefined, state: undefined, zip: undefined };
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^(.*?)(?:,\s*([A-Z]{2}))?(?:\s+(\d{5}(?:-\d{4})?))?$/i);
  if (!match) {
    return { city: normalized, state: undefined, zip: undefined };
  }

  return {
    city: match[1]?.trim() || undefined,
    state: match[2]?.trim() || undefined,
    zip: match[3]?.trim() || undefined,
  };
}

function extractLead(call) {
  const analysis = call?.call_analysis || {};
  const cityZip = parseCityZip(firstDefined(analysis, ['city', 'City and Zip', 'city_and_zip']));
  const emergency = toBoolean(firstDefined(analysis, ['active_leak', 'water_coming_in_now', 'Emergency', 'emergency']));

  return {
    fullName: firstDefined(analysis, ['full_name', 'customer_name', 'caller_name', 'name', 'Caller Name']),
    callbackNumber: firstDefined(analysis, ['best_callback_number', 'phone_number', 'phone', 'Call Back Number']) || call?.from_number,
    propertyAddress: firstDefined(analysis, ['property_address', 'street_address', 'address', 'Property Address']),
    city: firstDefined(analysis, ['city']) || cityZip.city,
    state: firstDefined(analysis, ['state']) || cityZip.state,
    zip: firstDefined(analysis, ['zip', 'postal_code']) || cityZip.zip,
    issueType: firstDefined(analysis, ['issue_type', 'reason_for_call', 'roof_issue_type', 'Service Needed']),
    issueStarted: firstDefined(analysis, ['issue_started', 'problem_started']),
    activeLeak: emergency,
    stormDamage: toBoolean(firstDefined(analysis, ['storm_damage'])),
    insuranceClaimOpened: toBoolean(firstDefined(analysis, ['insurance_claim_opened', 'insurance_claim', 'Insurnace Claim'])),
    bestCallbackTime: firstDefined(analysis, ['best_callback_time', 'callback_window', 'Best Call Back Time & Availability']),
    detailedCallSummary: firstDefined(analysis, ['detailed_call_summary', 'summary', 'call_summary', 'Summarize Callers Issue']),
    userReached: toBoolean(firstDefined(analysis, ['user_reached', 'answered_call', 'call_successful'])),
  };
}

function requireValue(name, value) {
  if (!value) {
    throw new Error(`Missing required value: ${name}`);
  }
}

function buildDescription(lead, call) {
  const lines = [
    config.sourceName ? `Lead source: ${config.sourceName}` : null,
    lead.detailedCallSummary ? `Summary: ${lead.detailedCallSummary}` : null,
    lead.issueType ? `Issue type: ${lead.issueType}` : null,
    lead.issueStarted ? `Issue started: ${lead.issueStarted}` : null,
    lead.activeLeak !== undefined ? `Active leak: ${lead.activeLeak ? 'Yes' : 'No'}` : null,
    lead.stormDamage !== undefined ? `Storm damage: ${lead.stormDamage ? 'Yes' : 'No'}` : null,
    lead.insuranceClaimOpened !== undefined ? `Insurance claim opened: ${lead.insuranceClaimOpened ? 'Yes' : 'No'}` : null,
    lead.bestCallbackTime ? `Preferred callback time: ${lead.bestCallbackTime}` : null,
    call?.call_id ? `Retell call ID: ${call.call_id}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

async function jobNimbusRequest(path, { method = 'GET', body, query = {} } = {}) {
  const url = new URL(`${config.jobNimbusBaseUrl}${path}`);
  const queryEntries = { ...query };
  if (config.jobNimbusActor && !queryEntries.actor) {
    queryEntries.actor = config.jobNimbusActor;
  }

  for (const [key, value] of Object.entries(queryEntries)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${config.jobNimbusApiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  const parsed = raw ? safeJsonParse(raw) : null;

  if (!response.ok) {
    throw new Error(`JobNimbus ${method} ${path} failed (${response.status}): ${raw}`);
  }

  return parsed;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

async function findExisting(endpoint, externalId) {
  if (!externalId) return null;
  const filter = JSON.stringify({ must: [{ term: { external_id: externalId } }] });
  const result = await jobNimbusRequest(endpoint, {
    query: {
      size: 1,
      filter,
    },
  });

  return asArray(result)[0] || null;
}

async function createContactLead(lead, call) {
  const externalId = call.call_id;
  const existing = await findExisting('/contacts', externalId);
  if (existing) return existing;

  const { firstName, lastName } = splitName(lead.fullName);
  const payload = {
    first_name: firstName,
    last_name: lastName,
    mobile_phone: lead.callbackNumber,
    address_line1: lead.propertyAddress,
    city: lead.city,
    state_text: lead.state,
    zip: lead.zip,
    record_type_name: config.contactRecordTypeName,
    status_name: config.contactStatusName,
    description: buildDescription(lead, call),
    external_id: externalId,
  };

  if (config.sourceName) {
    payload.source_name = config.sourceName;
  }

  try {
    return await jobNimbusRequest('/contacts', {
      method: 'POST',
      body: payload,
    });
  } catch (error) {
    if (!String(error.message || '').includes('Invalid source_name')) {
      throw error;
    }

    delete payload.source_name;
    return jobNimbusRequest('/contacts', {
      method: 'POST',
      body: payload,
    });
  }
}

async function createJobRecord(lead, call, contact) {
  if (!config.createJob) return null;
  const externalId = `${call.call_id}:job`;
  const existing = await findExisting('/jobs', externalId);
  if (existing) return existing;

  const payload = {
    name: [lead.fullName, lead.issueType].filter(Boolean).join(' - ') || `Retell lead ${call.call_id}`,
    record_type_name: config.jobRecordTypeName,
    status_name: config.jobStatusName,
    address_line1: lead.propertyAddress,
    city: lead.city,
    state_text: lead.state,
    zip: lead.zip,
    description: buildDescription(lead, call),
    related: contact?.jnid ? [{ id: contact.jnid }] : undefined,
    external_id: externalId,
  };

  return jobNimbusRequest('/jobs', {
    method: 'POST',
    body: payload,
  });
}

function overlaps(slotStart, slotEnd, busyStart, busyEnd) {
  return slotStart < busyEnd && slotEnd > busyStart;
}

function roundUpToSlot(date, slotMinutes) {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  const minutes = rounded.getMinutes();
  const remainder = minutes % slotMinutes;
  if (remainder !== 0) {
    rounded.setMinutes(minutes + (slotMinutes - remainder));
  }
  return rounded;
}

async function fetchScheduledTasks(ownerId, startDate, endDate) {
  const filter = {
    must: [
      { range: { date_start: { gte: Math.floor(startDate.getTime() / 1000), lte: Math.floor(endDate.getTime() / 1000) } } },
    ],
    must_not: [{ term: { is_completed: true } }],
  };

  if (ownerId) {
    filter.must.push({ term: { 'owners.id': ownerId } });
  }

  const result = await jobNimbusRequest('/tasks', {
    query: {
      size: config.querySize,
      sort_field: 'date_start',
      sort_direction: 'asc',
      fields: 'jnid,title,date_start,date_end,estimated_time,is_completed,owners',
      filter: JSON.stringify(filter),
    },
  });

  return asArray(result);
}

async function findNextAvailableSlotForOwner(ownerId, earliest, horizonEnd) {
  const tasks = await fetchScheduledTasks(ownerId, earliest, horizonEnd);

  const busyWindows = tasks
    .filter((task) => task?.date_start)
    .map((task) => {
      const start = new Date(Number(task.date_start) * 1000);
      const estimatedMinutes = Number(task.estimated_time || config.slotMinutes);
      const endSeconds = Number(task.date_end || 0);
      const end = endSeconds > Number(task.date_start)
        ? new Date(endSeconds * 1000)
        : new Date(start.getTime() + estimatedMinutes * 60_000);
      return { start, end };
    })
    .sort((a, b) => a.start - b.start);

  for (let dayOffset = 0; dayOffset <= config.lookaheadDays; dayOffset += 1) {
    const baseDay = new Date(earliest);
    baseDay.setDate(baseDay.getDate() + dayOffset);

    const dayStart = new Date(baseDay.getFullYear(), baseDay.getMonth(), baseDay.getDate(), config.workdayStartHour, 0, 0, 0);
    const dayEnd = new Date(baseDay.getFullYear(), baseDay.getMonth(), baseDay.getDate(), config.workdayEndHour, 0, 0, 0);

    let cursor = dayOffset === 0 && earliest > dayStart ? new Date(earliest) : dayStart;
    cursor = roundUpToSlot(cursor, config.slotMinutes);

    while (cursor.getTime() + config.slotMinutes * 60_000 <= dayEnd.getTime()) {
      const slotEnd = new Date(cursor.getTime() + config.slotMinutes * 60_000);
      const conflict = busyWindows.some((window) => overlaps(cursor, slotEnd, window.start, window.end));
      if (!conflict) {
        return { ownerId, start: cursor, end: slotEnd };
      }
      cursor = slotEnd;
    }
  }

  return null;
}

async function findNextAvailableSlot() {
  const now = new Date();
  const earliest = roundUpToSlot(new Date(now.getTime() + config.scheduleBufferMinutes * 60_000), config.slotMinutes);
  const horizonEnd = new Date(now.getTime() + config.lookaheadDays * 24 * 60 * 60_000);
  const candidateOwners = unique(config.scheduleOwnerIds.length ? config.scheduleOwnerIds : config.taskOwnerIds);
  const ownersToCheck = candidateOwners.length ? candidateOwners : [null];

  const slots = [];
  for (const ownerId of ownersToCheck) {
    const slot = await findNextAvailableSlotForOwner(ownerId, earliest, horizonEnd);
    if (slot) {
      slots.push(slot);
    }
  }

  slots.sort((a, b) => a.start - b.start);
  if (slots[0]) {
    return slots[0];
  }

  throw new Error(`No open scheduling slot found within ${config.lookaheadDays} days.`);
}

function buildTaskTitle(lead) {
  const name = lead.fullName || 'New lead';
  const reason = lead.issueType || 'Roof callback';
  return `Call ${name} - ${reason}`;
}

async function createCallbackTask(lead, call, relatedRecord) {
  requireValue('JOBNIMBUS_TASK_OWNER_IDS or JOBNIMBUS_SCHEDULE_OWNER_IDS', config.taskOwnerIds[0] || config.scheduleOwnerIds[0]);
  requireValue('relatedRecord.jnid', relatedRecord?.jnid);

  const externalId = `${call.call_id}:callback`;
  const existing = await findExisting('/tasks', externalId);
  if (existing) return existing;

  const slot = await findNextAvailableSlot();
  const payload = {
    title: buildTaskTitle(lead),
    description: buildDescription(lead, call),
    record_type_name: config.taskRecordTypeName,
    related: [{ id: relatedRecord.jnid }],
    date_start: Math.floor(slot.start.getTime() / 1000),
    date_end: Math.floor(slot.end.getTime() / 1000),
    estimated_time: config.slotMinutes,
    external_id: externalId,
  };

  const ownerIds = unique(config.taskOwnerIds.length ? config.taskOwnerIds : [slot.ownerId]);
  if (ownerIds.length) {
    payload.owners = ownerIds.map((id) => ({ id }));
  }

  return jobNimbusRequest('/tasks', {
    method: 'POST',
    body: payload,
  });
}

async function processRetellWebhook(event) {
  if (event?.event !== 'call_analyzed') {
    return { ignored: true, reason: `Unhandled event ${event?.event || 'unknown'}` };
  }

  const call = event.call;
  const lead = extractLead(call);

  if (lead.userReached === false) {
    return { ignored: true, reason: 'Call analysis says no user was reached.' };
  }

  if (!lead.callbackNumber && !lead.fullName) {
    return { ignored: true, reason: 'Not enough lead data to create a contact.' };
  }

  const contact = await createContactLead(lead, call);
  const job = await createJobRecord(lead, call, contact);
  const relatedRecord = job || contact;
  const task = await createCallbackTask(lead, call, relatedRecord);

  return {
    success: true,
    contactId: contact?.jnid,
    jobId: job?.jnid || null,
    taskId: task?.jnid,
  };
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: missingStartupConfig.length === 0,
      missingStartupConfig,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/retell') {
    try {
      const rawBody = await readRawBody(req);
      const signature = req.headers['x-retell-signature'];

      if (!signature) {
        return json(res, 401, { error: 'Missing X-Retell-Signature header.' });
      }

      if (!Retell.verify(rawBody, config.retellApiKey, signature)) {
        return json(res, 401, { error: 'Invalid Retell signature.' });
      }

      const event = safeJsonParse(rawBody);
      const result = await processRetellWebhook(event);
      return json(res, 200, result);
    } catch (error) {
      console.error(error);
      return json(res, 500, { error: error.message || 'Unexpected error.' });
    }
  }

  return text(res, 404, 'Not found');
}

export function createServer() {
  return http.createServer(requestHandler);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen(config.port, () => {
    console.log(`Retell -> JobNimbus bridge listening on http://localhost:${config.port}`);
    if (missingStartupConfig.length > 0) {
      console.warn(`Missing startup config: ${missingStartupConfig.join(', ')}`);
    }
  });
}
