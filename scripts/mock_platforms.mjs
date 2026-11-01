// Local stand-in for the GoHighLevel and Meta Graph endpoints this demo calls (SPEC §2, §7.3).
// Used only to run the whole n8n flow before the GoHighLevel trial starts; never shown as evidence.
// Runs in the n8n image with Node built-ins: `docker compose --profile mock up -d`.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const STAGE_NAMES = ['New – qualified', 'Needs review', 'Contacted', 'Won', 'Lost'];

export function freshState(locationId = 'mockLocation01') {
  return {
    locationId,
    location: { id: locationId, name: 'Tidewell Commercial Cleaning (demo)', timezone: 'America/Los_Angeles' },
    customFields: [],
    pipelines: [{ id: 'mockPipeline01', name: 'Inquiries', stages: STAGE_NAMES.map((name, index) => ({ id: `mockStage0${index + 1}`, name, position: index })) }],
    contacts: {},
    notes: {},
    tasks: {},
    opportunities: {},
    leads: {},
    calls: [],
  };
}

const newId = (prefix) => `${prefix}${randomBytes(6).toString('hex')}`;
const json = (status, body) => ({ status, body });
const sameEmail = (a, b) => Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();

function setFields(contact, list = []) {
  const current = new Map((contact.customFields || []).map((item) => [item.id, item.value]));
  for (const item of list) current.set(item.id, item.field_value !== undefined ? item.field_value : item.value);
  contact.customFields = [...current].map(([id, value]) => ({ id, value }));
}

function duplicateOf(state, { email, phone }, exceptId = null) {
  return Object.values(state.contacts).find((contact) => contact.id !== exceptId && ((email && sameEmail(contact.email, email)) || (phone && contact.phone === phone)));
}

// Returns { status, body } for one request; `state` is mutated in place.
export function handle(state, method, url, headers = {}, body = null) {
  const { pathname, searchParams } = new URL(url, 'http://mock');
  const q = Object.fromEntries(searchParams);
  state.calls.push({ method, path: pathname, query: q });

  if (pathname === '/__state') return json(200, state);
  if (pathname === '/__reset' && method === 'POST') { Object.assign(state, freshState(state.locationId)); return json(200, { ok: true }); }
  if (pathname === '/__seed/lead' && method === 'POST') { state.leads[String(body.id)] = body; return json(201, { ok: true }); }
  // Stand-in Slack incoming webhook for mock runs.
  if (pathname === '/__slack' && method === 'POST') { (state.slack = state.slack || []).push(body && body.text); return { status: 200, body: 'ok', text: true }; }

  // Meta Graph: GET /v21.0/{leadgen_id}?fields=…&access_token=…
  const graph = pathname.match(/^\/v\d+\.\d+\/([^/]+)$/);
  if (graph && method === 'GET') {
    if (!q.access_token) return json(400, { error: { message: 'An access token is required to request this resource.', type: 'OAuthException', code: 104 } });
    const lead = state.leads[decodeURIComponent(graph[1])];
    return lead ? json(200, lead) : json(400, { error: { message: `Unsupported get request. Object with ID '${graph[1]}' does not exist`, type: 'GraphMethodException', code: 100 } });
  }

  // GoHighLevel API v2
  if (!/^Bearer\s+\S+/.test(headers.authorization || '')) return json(401, { statusCode: 401, message: 'Invalid JWT' });
  if (headers.version !== '2021-07-28') return json(400, { statusCode: 400, message: 'version header was not found' });
  const loc = state.locationId;
  let m;

  if (method === 'GET' && pathname === `/locations/${loc}`) return json(200, { location: state.location });
  if (pathname === `/locations/${loc}/customFields`) {
    if (method === 'GET') return json(200, { customFields: state.customFields });
    if (method === 'POST') {
      const key = `contact.${String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
      const field = { id: newId('cf'), name: body.name, fieldKey: key, dataType: body.dataType, picklistOptions: body.options || [], model: body.model || 'contact' };
      state.customFields.push(field);
      return json(201, { customField: field });
    }
  }
  if (method === 'GET' && pathname === '/opportunities/pipelines') return json(200, { pipelines: q.locationId === loc ? state.pipelines : [] });

  if (method === 'GET' && pathname === '/contacts/search/duplicate') {
    if (q.locationId !== loc) return json(400, { statusCode: 400, message: 'locationId is invalid' });
    const found = duplicateOf(state, { email: q.email, phone: q.number });
    return json(200, { contact: found || null });
  }
  if (method === 'POST' && pathname === '/contacts/search') {
    const query = String((body && body.query) || '').toLowerCase();
    const contacts = Object.values(state.contacts).filter((contact) => !query || JSON.stringify(contact).toLowerCase().includes(query));
    return json(200, { contacts, total: contacts.length });
  }
  if (method === 'POST' && pathname === '/contacts/') {
    if (body.locationId !== loc) return json(400, { statusCode: 400, message: 'locationId is invalid' });
    const existing = duplicateOf(state, body);
    if (existing) return json(400, { statusCode: 400, message: 'This location does not allow duplicated contacts.', meta: { contactId: existing.id, matchingField: sameEmail(existing.email, body.email) ? 'email' : 'phone' } });
    const { customFields, ...rest } = body;
    const contact = { id: newId('ct'), ...rest, dateAdded: new Date().toISOString() };
    setFields(contact, customFields);
    state.contacts[contact.id] = contact;
    return json(201, { contact });
  }
  if ((m = pathname.match(/^\/contacts\/([^/]+)$/))) {
    const contact = state.contacts[m[1]];
    if (!contact) return json(404, { statusCode: 404, message: 'Contact not found' });
    if (method === 'GET') return json(200, { contact });
    if (method === 'PUT') {
      if ('locationId' in body || 'tags' in body) return json(422, { statusCode: 422, message: ['property locationId should not exist'] });
      const { customFields, ...rest } = body;
      Object.assign(contact, rest);
      setFields(contact, customFields);
      return json(200, { succeded: true, contact });
    }
    if (method === 'DELETE') {
      delete state.contacts[m[1]];
      delete state.notes[m[1]];
      delete state.tasks[m[1]];
      return json(200, { succeded: true });
    }
  }
  if ((m = pathname.match(/^\/contacts\/([^/]+)\/(notes|tasks)$/))) {
    if (!state.contacts[m[1]]) return json(404, { statusCode: 404, message: 'Contact not found' });
    const bucket = state[m[2]];
    if (method === 'GET') return json(200, { [m[2]]: bucket[m[1]] || [] });
    if (method === 'POST') {
      const item = { id: newId(m[2] === 'notes' ? 'nt' : 'tk'), contactId: m[1], ...body, dateAdded: new Date().toISOString() };
      (bucket[m[1]] = bucket[m[1]] || []).push(item);
      return json(201, m[2] === 'notes' ? { note: item } : { task: item });
    }
  }
  if (method === 'GET' && pathname === '/opportunities/search') {
    const list = Object.values(state.opportunities).filter((item) => (!q.contact_id || item.contactId === q.contact_id) && (!q.pipeline_id || item.pipelineId === q.pipeline_id) && (!q.status || q.status === 'all' || item.status === q.status));
    return json(200, { opportunities: list, meta: { total: list.length } });
  }
  if (method === 'POST' && pathname === '/opportunities/') {
    if (!state.contacts[body.contactId]) return json(400, { statusCode: 400, message: 'Contact not found' });
    const opportunity = { id: newId('op'), ...body };
    state.opportunities[opportunity.id] = opportunity;
    return json(201, { opportunity });
  }
  if ((m = pathname.match(/^\/opportunities\/([^/]+)$/))) {
    const opportunity = state.opportunities[m[1]];
    if (!opportunity) return json(404, { statusCode: 404, message: 'Opportunity not found' });
    if (method === 'PUT') { Object.assign(opportunity, body); return json(200, { opportunity }); }
    if (method === 'DELETE') { delete state.opportunities[m[1]]; return json(200, { succeded: true }); }
  }
  return json(404, { statusCode: 404, message: `Cannot ${method} ${pathname}` });
}

export function serve(port = 5690, host = '0.0.0.0', state = freshState(process.env.GHL_LOCATION_ID || undefined)) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const result = handle(state, req.method, req.url, req.headers, body);
      // Slack answers plain text "ok"; everything else here is JSON.
      res.writeHead(result.status, { 'Content-Type': result.text ? 'text/plain' : 'application/json' });
      res.end(result.text ? result.body : JSON.stringify(result.body));
    });
  });
  server.listen(port, host);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  serve(Number(process.env.MOCK_PORT || 5690));
  console.log(`Mock GoHighLevel + Graph listening on ${process.env.MOCK_PORT || 5690}`);
}
