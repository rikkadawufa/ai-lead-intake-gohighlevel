// Meta lead ads: webhook handshake, signature check and Graph lead → inquiry (SPEC §3.2).

// GET /webhook/meta-leads: Meta subscribes by asking us to echo hub.challenge.
function verifyHandshake(query = {}, verifyToken) {
  const ok = query['hub.mode'] === 'subscribe' && Boolean(verifyToken) && query['hub.verify_token'] === verifyToken;
  return ok ? { status: 200, body: String(query['hub.challenge'] || '') } : { status: 403, body: 'Forbidden' };
}

// X-Hub-Signature-256 is HMAC-SHA256 of the raw body with the app secret. Re-serialized JSON does not match Meta's bytes.
function verifySignature(rawBody, header, appSecret) {
  const crypto = require('crypto');
  const match = /^sha256=([0-9a-f]{64})$/i.exec(String(header || '').trim());
  if (!match || !appSecret) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function leadgenEvents(payload = {}) {
  const events = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen' || !change.value || !change.value.leadgen_id) continue;
      events.push({ leadgenId: String(change.value.leadgen_id), pageId: String(change.value.page_id || entry.id || ''), formId: String(change.value.form_id || '') });
    }
  }
  return events;
}

const KNOWN = { full_name: 'name', email: 'email', phone_number: 'phone', company_name: 'company' };
const MESSAGE_PREFIX = 'what_do_you_need';

// GET /{leadgen_id}?fields=created_time,field_data,form_id → the shared inquiry shape. Unknown questions are kept in the message.
function normalizeMetaLead(lead = {}, { toE164, now = new Date().toISOString() } = {}) {
  const values = {};
  const extra = [];
  let message = '';
  for (const item of lead.field_data || []) {
    const value = (item.values || []).map((part) => String(part).trim()).filter(Boolean).join(', ');
    if (!value) continue;
    if (KNOWN[item.name]) values[KNOWN[item.name]] = value;
    else if (String(item.name).startsWith(MESSAGE_PREFIX)) message = value;
    else extra.push(`${item.name}: ${value}`);
  }
  const created = lead.created_time ? new Date(String(lead.created_time).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : null;
  return {
    source: 'meta_lead',
    source_id: `meta:${lead.id}`,
    received_at: created && !Number.isNaN(created.getTime()) ? created.toISOString() : now,
    name: values.name || null,
    email: values.email ? values.email.toLowerCase() : null,
    phone: values.phone ? toE164(values.phone) : null,
    company: values.company || null,
    subject: 'Facebook lead form',
    message: [message, ...extra].filter(Boolean).join('\n'),
    meta: { leadgen_id: String(lead.id || ''), form_id: String(lead.form_id || '') },
    demo_flags: { break_llm: false },
  };
}

function graphFailureAlert(event, status, body) {
  return `:warning: Facebook lead ${event.leadgenId} (form ${event.formId || 'unknown'}) could not be read from Meta (${status}): ${String(JSON.stringify(body)).slice(0, 200)}. Nothing was written to GoHighLevel; open the lead in Meta Business Suite and enter it by hand.`;
}

if (typeof module !== 'undefined') module.exports = { verifyHandshake, verifySignature, leadgenEvents, normalizeMetaLead, graphFailureAlert };
