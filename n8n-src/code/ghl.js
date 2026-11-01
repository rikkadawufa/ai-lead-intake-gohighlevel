// Contact matching, repeat detection, and the contact, note, opportunity and task bodies written to GoHighLevel (SPEC §3.3–§4).

const TIER_RANK = { not_qualified: 0, needs_review: 1, qualified: 2 };
// The custom fields this workflow owns; ids are resolved by ghl_setup.py into output/ghl-ids.json.
const FIELD_KEYS = ['lead_tier', 'inquiry_topic', 'inquiry_urgency', 'inquiry_source', 'ai_reason', 'inquiry_source_ids'];
const STAGES = { qualified: 'New – qualified', needs_review: 'Needs review' };
const SOURCE_LABEL = { form: 'Website form', email: 'Email', meta_lead: 'Facebook lead form' };
const TAG = 'ai-intake';

// Email first, then phone; each is one duplicate-search call.
function lookupRequests(inquiry, locationId) {
  const query = (key, value) => `/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&${key}=${encodeURIComponent(value)}`;
  const requests = [];
  if (inquiry.email) requests.push({ by: 'email', path: query('email', inquiry.email) });
  if (inquiry.phone) requests.push({ by: 'phone', path: query('number', inquiry.phone) });
  return requests;
}

// Input: [{ by, statusCode, body }] in lookup order (HTTP node with fullResponse + neverError).
function resolveLookups(responses) {
  for (const response of responses) {
    if (!response || response.statusCode !== 200) {
      // A failed search must not look like "no match": stop so the error workflow alerts.
      throw new Error(`GoHighLevel lookup by ${response && response.by} failed: ${response ? response.statusCode : 'no response'} ${JSON.stringify(response && response.body).slice(0, 300)}`);
    }
  }
  for (const response of responses) {
    const contact = response.body && response.body.contact;
    if (contact && contact.id) return { contactId: contact.id, matchedBy: response.by };
  }
  return { contactId: null, matchedBy: null };
}

function fieldValue(contact, fieldId) {
  const list = contact.customFields || contact.customField || [];
  const found = list.find((item) => item.id === fieldId);
  if (!found) return null;
  const value = found.value !== undefined ? found.value : found.field_value;
  return value === undefined || value === '' ? null : value;
}

// GET /contacts/{id} → the parts this workflow reads back.
function readContact(response, ids) {
  if (!response || response.statusCode !== 200 || !response.body || !response.body.contact) {
    throw new Error(`GoHighLevel get contact failed: ${response ? response.statusCode : 'no response'} ${JSON.stringify(response && response.body).slice(0, 300)}`);
  }
  const contact = response.body.contact;
  const sourceIds = String(fieldValue(contact, ids.fields.inquiry_source_ids) || '').split('\n').map((item) => item.trim()).filter(Boolean);
  return {
    id: contact.id,
    firstName: contact.firstName || null,
    lastName: contact.lastName || null,
    email: contact.email || null,
    phone: contact.phone || null,
    companyName: contact.companyName || null,
    tier: fieldValue(contact, ids.fields.lead_tier),
    sourceIds,
  };
}

function isRepeat(contact, sourceId) {
  return Boolean(contact) && contact.sourceIds.includes(sourceId);
}

function mergeTier(existing, incoming) {
  if (!existing || !(existing in TIER_RANK)) return incoming;
  return existing === 'qualified' ? 'qualified' : incoming;
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

function customFields(ids, values) {
  return Object.entries(values).map(([key, value]) => ({ id: ids.fields[key], field_value: value }));
}

// Create (POST /contacts/) or update (PUT /contacts/{id}). Existing contacts keep their identity; only empty fields are filled.
// PUT replaces tags, so tags are only sent on create.
function contactRequest(inquiry, qualification, contact, ids, locationId) {
  const name = splitName(inquiry.name);
  const tier = mergeTier(contact && contact.tier, qualification.tier);
  const sourceIds = [...((contact && contact.sourceIds) || []), inquiry.source_id];
  const fields = customFields(ids, {
    lead_tier: tier,
    inquiry_topic: qualification.topic,
    inquiry_urgency: qualification.urgency,
    inquiry_source: inquiry.source,
    ai_reason: qualification.reason,
    inquiry_source_ids: sourceIds.join('\n'),
  });
  if (!contact) {
    const body = { locationId, source: SOURCE_LABEL[inquiry.source] || inquiry.source, tags: [TAG], customFields: fields };
    if (name.first) body.firstName = name.first;
    if (name.last) body.lastName = name.last;
    if (inquiry.email) body.email = inquiry.email;
    if (inquiry.phone) body.phone = inquiry.phone;
    if (inquiry.company) body.companyName = inquiry.company;
    return { method: 'POST', path: '/contacts/', body, tier };
  }
  const body = { customFields: fields };
  if (name.first && !contact.firstName) body.firstName = name.first;
  if (name.last && !contact.lastName) body.lastName = name.last;
  if (inquiry.email && !contact.email) body.email = inquiry.email;
  if (inquiry.phone && !contact.phone) body.phone = inquiry.phone;
  if (inquiry.company && !contact.companyName) body.companyName = inquiry.company;
  return { method: 'PUT', path: `/contacts/${contact.id}`, body, tier };
}

// With "Allow Duplicate Contact" off, a create that collides with an existing contact is refused and names it.
function parseDuplicateCreate(response) {
  if (!response || response.statusCode !== 400 || !response.body) return null;
  const body = response.body;
  const meta = body.meta || {};
  const id = meta.contactId || meta.contact_id || (meta.contact && meta.contact.id) || body.contactId || null;
  return /duplicat/i.test(String(body.message || '')) && id ? id : null;
}

function createdContactId(response) {
  if (!response || ![200, 201].includes(response.statusCode)) return null;
  const contact = response.body && (response.body.contact || response.body);
  return contact && contact.id ? contact.id : null;
}

function oneLine(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function inquiryNote(inquiry, qualification) {
  const header = [`Inquiry via ${SOURCE_LABEL[inquiry.source] || inquiry.source} at ${inquiry.received_at}`, ...(inquiry.subject ? [inquiry.subject] : [])];
  const ai = `AI: ${qualification.tier} / ${qualification.topic} / ${qualification.urgency} — ${qualification.reason}`;
  return { body: [...header, '', inquiry.message, '', ai, '', `Source id: ${inquiry.source_id}`].join('\n') };
}

function decisionNote(result, { date, sentTo }) {
  if (result.timedOut) return { body: 'AI reply review timed out. Reply drafted by AI; nothing sent.' };
  if (result.decision === 'approve') {
    return { body: `AI reply approved by ${result.reviewer}\nReply drafted by AI, edited: ${result.edited ? 'yes' : 'no'}, approved on ${date}, sent to ${sentTo}.\n\nSubject: ${result.subject}\n\n${result.body}` };
  }
  return { body: `AI reply rejected by ${result.reviewer}\nReply drafted by AI, rejected on ${date}, nothing sent.` };
}

function stageRank(stageId, ids) {
  if (stageId === ids.stages[STAGES.qualified]) return 2;
  if (stageId === ids.stages[STAGES.needs_review]) return 1;
  return null; // Contacted, Won, Lost or unknown: a person already owns it.
}

// One open opportunity per contact in the Inquiries pipeline; it only moves up, and never once it's past the two intake stages.
function planOpportunity({ tier, contactId, label, topic, existing, ids, locationId }) {
  const target = STAGES[tier];
  const targetId = target ? ids.stages[target] : null;
  if (!existing) {
    if (!targetId) return { request: null, stage: null, opportunityId: null, needsTask: false };
    const body = { pipelineId: ids.pipelineId, locationId, name: oneLine(`${label} – ${topic}`, 120), pipelineStageId: targetId, status: 'open', contactId, source: 'AI lead intake' };
    return { request: { method: 'POST', path: '/opportunities/', body }, stage: target, opportunityId: null, needsTask: tier === 'qualified' };
  }
  const current = stageRank(existing.pipelineStageId, ids);
  const currentName = Object.keys(ids.stages).find((name) => ids.stages[name] === existing.pipelineStageId) || null;
  if (current === null || !targetId || stageRank(targetId, ids) <= current) {
    return { request: null, stage: currentName, opportunityId: existing.id, needsTask: false };
  }
  return { request: { method: 'PUT', path: `/opportunities/${existing.id}`, body: { pipelineId: ids.pipelineId, pipelineStageId: targetId } }, stage: target, opportunityId: existing.id, needsTask: tier === 'qualified' };
}

function readOpenOpportunity(response, ids) {
  if (!response || response.statusCode !== 200) {
    throw new Error(`GoHighLevel opportunity search failed: ${response ? response.statusCode : 'no response'} ${JSON.stringify(response && response.body).slice(0, 300)}`);
  }
  const list = (response.body && response.body.opportunities) || [];
  return list.find((item) => item.pipelineId === ids.pipelineId && (item.status || 'open') === 'open') || null;
}

// Offset of a time zone at a given instant, in minutes (Intl only, no libraries).
function tzOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime()) / 60000;
}

// Next business day at 10:00 in the location's time zone.
function nextBusinessDay10(nowIso, timeZone = 'America/Los_Angeles') {
  const now = new Date(nowIso);
  const local = new Date(now.getTime() + tzOffsetMinutes(now, timeZone) * 60000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 10, 0, 0));
  while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
  return new Date(day.getTime() - tzOffsetMinutes(day, timeZone) * 60000).toISOString();
}

function followUpTask(inquiry, qualification, { now, timeZone }) {
  const who = inquiry.name || inquiry.email || inquiry.phone;
  return {
    title: oneLine(`Call ${who} about ${qualification.topic.replace(/_/g, ' ')}`, 120),
    body: `Qualified by AI (${qualification.urgency} urgency): ${qualification.reason}\nCheck the inquiry note before calling.`,
    dueDate: nextBusinessDay10(now, timeZone),
    completed: false,
  };
}

function contactUrl(locationId, contactId) {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}

if (typeof module !== 'undefined') module.exports = { lookupRequests, resolveLookups, readContact, isRepeat, mergeTier, contactRequest, parseDuplicateCreate, createdContactId, inquiryNote, decisionNote, planOpportunity, readOpenOpportunity, nextBusinessDay10, followUpTask, contactUrl, FIELD_KEYS, STAGES, SOURCE_LABEL, TAG };
