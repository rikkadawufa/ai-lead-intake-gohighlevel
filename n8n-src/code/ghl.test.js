const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupRequests, resolveLookups, readContact, isRepeat, contactRequest, parseDuplicateCreate, createdContactId, inquiryNote, decisionNote, planOpportunity, readOpenOpportunity, nextBusinessDay10, followUpTask, contactUrl } = require('./ghl');

const ids = {
  fields: { lead_tier: 'f-tier', inquiry_topic: 'f-topic', inquiry_urgency: 'f-urg', inquiry_source: 'f-src', ai_reason: 'f-reason', inquiry_source_ids: 'f-ids' },
  pipelineId: 'p1',
  stages: { 'New – qualified': 's-q', 'Needs review': 's-r', Contacted: 's-c', Won: 's-w', Lost: 's-l' },
};
const inquiry = { source: 'email', source_id: 'email:<t2@example.com>', received_at: '2026-11-03T01:00:00Z', email: 'dana@example.com', phone: '+15105550142', name: 'Dana Whitfield', company: 'Harborview Dental Group', subject: 'Re: walkthrough', message: 'Is Tuesday possible?' };
const qualification = { tier: 'needs_review', topic: 'regular_cleaning', urgency: 'high', reason: 'Asks about a date. Quote: "Tuesday"', llm_ok: true };
const field = (id, value) => ({ id, value });
const contactResponse = (extra = {}) => ({ statusCode: 200, body: { contact: { id: 'c1', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.com', phone: '+15105550142', customFields: [field('f-tier', 'qualified'), field('f-ids', 'form:tw-demo-0001')], ...extra } } });

test('lookup asks by email first, then by phone, and skips what the inquiry lacks', () => {
  const requests = lookupRequests(inquiry, 'loc 1');
  assert.deepEqual(requests.map((item) => item.by), ['email', 'phone']);
  assert.equal(requests[0].path, '/contacts/search/duplicate?locationId=loc%201&email=dana%40example.com');
  assert.equal(requests[1].path, '/contacts/search/duplicate?locationId=loc%201&number=%2B15105550142');
  assert.deepEqual(lookupRequests({ ...inquiry, email: null }, 'l').map((item) => item.by), ['phone']);
});

test('an email match wins over a phone match', () => {
  const result = resolveLookups([{ by: 'email', statusCode: 200, body: { contact: { id: 'c-email' } } }, { by: 'phone', statusCode: 200, body: { contact: { id: 'c-phone' } } }]);
  assert.deepEqual(result, { contactId: 'c-email', matchedBy: 'email' });
  assert.deepEqual(resolveLookups([{ by: 'email', statusCode: 200, body: { contact: null } }, { by: 'phone', statusCode: 200, body: { contact: { id: 'c-phone' } } }]), { contactId: 'c-phone', matchedBy: 'phone' });
  assert.deepEqual(resolveLookups([{ by: 'email', statusCode: 200, body: {} }]), { contactId: null, matchedBy: null });
});

test('a failed lookup throws instead of counting as no match', () => {
  assert.throws(() => resolveLookups([{ by: 'email', statusCode: 401, body: { message: 'Invalid JWT' } }]), /lookup by email failed: 401/);
});

test('contact read-back finds the tier and the source ids by custom field id', () => {
  const contact = readContact(contactResponse(), ids);
  assert.equal(contact.tier, 'qualified');
  assert.deepEqual(contact.sourceIds, ['form:tw-demo-0001']);
  assert.equal(isRepeat(contact, 'form:tw-demo-0001'), true);
  assert.equal(isRepeat(contact, 'email:<t2@example.com>'), false);
  assert.equal(readContact({ statusCode: 200, body: { contact: { id: 'c2', customFields: [{ id: 'f-tier', field_value: 'needs_review' }] } } }, ids).tier, 'needs_review');
  assert.throws(() => readContact({ statusCode: 404, body: {} }, ids), /get contact failed/);
});

test('a new contact gets identity, source label, tag and every custom field', () => {
  const request = contactRequest({ ...inquiry, source: 'meta_lead', source_id: 'meta:123' }, qualification, null, ids, 'loc1');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/contacts/');
  assert.equal(request.body.locationId, 'loc1');
  assert.equal(request.body.source, 'Facebook lead form');
  assert.deepEqual(request.body.tags, ['ai-intake']);
  assert.deepEqual([request.body.firstName, request.body.lastName, request.body.companyName], ['Dana', 'Whitfield', 'Harborview Dental Group']);
  const values = Object.fromEntries(request.body.customFields.map((item) => [item.id, item.field_value]));
  assert.deepEqual(values, { 'f-tier': 'needs_review', 'f-topic': 'regular_cleaning', 'f-urg': 'high', 'f-src': 'meta_lead', 'f-reason': qualification.reason, 'f-ids': 'meta:123' });
});

test('an existing contact keeps its identity, never drops from qualified, and keeps earlier source ids', () => {
  const existing = readContact(contactResponse({ companyName: '' }), ids);
  const request = contactRequest({ ...inquiry, name: 'D. W.' }, qualification, existing, ids, 'loc1');
  assert.equal(request.method, 'PUT');
  assert.equal(request.path, '/contacts/c1');
  assert.equal(request.tier, 'qualified');
  assert.equal('firstName' in request.body || 'email' in request.body || 'phone' in request.body || 'tags' in request.body || 'locationId' in request.body, false);
  assert.equal(request.body.companyName, 'Harborview Dental Group');
  const values = Object.fromEntries(request.body.customFields.map((item) => [item.id, item.field_value]));
  assert.equal(values['f-tier'], 'qualified');
  assert.equal(values['f-ids'], 'form:tw-demo-0001\nemail:<t2@example.com>');
});

test('without AI sorting only the source fields are written, there is no tier, and the note has no AI line', () => {
  const intakeOnly = { tier: null, topic: null, urgency: null, reason: null, llm_ok: false, llm_error: null, ai: false };
  const created = contactRequest(inquiry, intakeOnly, null, ids, 'loc1');
  assert.equal(created.tier, null);
  assert.deepEqual(Object.fromEntries(created.body.customFields.map((item) => [item.id, item.field_value])), { 'f-src': 'email', 'f-ids': 'email:<t2@example.com>' });
  // A contact that was Qualified before keeps its fields untouched, and this inquiry opens no pipeline work.
  const updated = contactRequest(inquiry, intakeOnly, readContact(contactResponse(), ids), ids, 'loc1');
  assert.equal(updated.tier, null);
  assert.deepEqual(updated.body.customFields.map((item) => item.id), ['f-src', 'f-ids']);
  assert.equal(planOpportunity({ tier: updated.tier, contactId: 'c1', label: 'Dana', topic: 'inquiry', existing: null, ids, locationId: 'loc1' }).request, null);
  const note = inquiryNote(inquiry, intakeOnly).body;
  assert.doesNotMatch(note, /AI/);
  assert.match(note, /Is Tuesday possible\?\n\nSource id: email:<t2@example\.com>$/);
});

test('a create refused as a duplicate gives back the existing contact', () => {
  assert.equal(parseDuplicateCreate({ statusCode: 400, body: { statusCode: 400, message: 'This location does not allow duplicated contacts.', meta: { contactId: 'c9', matchingField: 'email' } } }), 'c9');
  assert.equal(parseDuplicateCreate({ statusCode: 400, body: { message: 'email is invalid' } }), null);
  assert.equal(parseDuplicateCreate({ statusCode: 201, body: { contact: { id: 'c1' } } }), null);
  assert.equal(createdContactId({ statusCode: 201, body: { contact: { id: 'c1' } } }), 'c1');
  assert.equal(createdContactId({ statusCode: 422, body: {} }), null);
});

test('inquiry and decision notes carry what a coordinator needs', () => {
  const note = inquiryNote(inquiry, qualification).body;
  assert.match(note, /^Inquiry via Email at 2026-11-03T01:00:00Z\nRe: walkthrough\n\nIs Tuesday possible\?\n\nAI: needs_review \/ regular_cleaning \/ high — Asks about a date/);
  assert.match(note, /Source id: email:<t2@example\.com>$/);
  assert.match(decisionNote({ decision: 'approve', reviewer: 'Morgan', edited: true, subject: 's', body: 'b' }, { date: '2026-11-03', sentTo: 'x@gmail.com' }).body, /^AI reply approved by Morgan\n.*edited: yes, approved on 2026-11-03, sent to x@gmail\.com/);
  assert.match(decisionNote({ decision: 'reject', reviewer: 'Morgan' }, { date: '2026-11-03' }).body, /^AI reply rejected by Morgan\n.*nothing sent/);
  assert.match(decisionNote({ timedOut: true }, {}).body, /timed out/);
});

test('opportunity: qualified opens one in New – qualified with a task, not qualified opens none', () => {
  const base = { contactId: 'c1', label: 'Dana Whitfield', topic: 'regular_cleaning', ids, locationId: 'loc1' };
  const created = planOpportunity({ ...base, tier: 'qualified', existing: null });
  assert.equal(created.request.method, 'POST');
  assert.deepEqual([created.request.body.pipelineId, created.request.body.pipelineStageId, created.request.body.contactId, created.request.body.status], ['p1', 's-q', 'c1', 'open']);
  assert.equal(created.needsTask, true);
  const review = planOpportunity({ ...base, tier: 'needs_review', existing: null });
  assert.deepEqual([review.request.body.pipelineStageId, review.needsTask], ['s-r', false]);
  assert.deepEqual(planOpportunity({ ...base, tier: 'not_qualified', existing: null }), { request: null, stage: null, opportunityId: null, needsTask: false });
});

test('opportunity only moves up, and is left alone once a person moved it on', () => {
  const base = { contactId: 'c1', label: 'Dana', topic: 'regular_cleaning', ids, locationId: 'loc1' };
  const up = planOpportunity({ ...base, tier: 'qualified', existing: { id: 'o1', pipelineStageId: 's-r' } });
  assert.deepEqual([up.request.method, up.request.path, up.request.body.pipelineStageId, up.needsTask], ['PUT', '/opportunities/o1', 's-q', true]);
  const same = planOpportunity({ ...base, tier: 'qualified', existing: { id: 'o1', pipelineStageId: 's-q' } });
  assert.deepEqual([same.request, same.stage, same.opportunityId, same.needsTask], [null, 'New – qualified', 'o1', false]);
  assert.equal(planOpportunity({ ...base, tier: 'needs_review', existing: { id: 'o1', pipelineStageId: 's-q' } }).request, null);
  assert.equal(planOpportunity({ ...base, tier: 'qualified', existing: { id: 'o1', pipelineStageId: 's-c' } }).request, null);
});

test('open opportunity search keeps only this pipeline', () => {
  const response = { statusCode: 200, body: { opportunities: [{ id: 'x', pipelineId: 'other', status: 'open' }, { id: 'o1', pipelineId: 'p1', status: 'open', pipelineStageId: 's-r' }] } };
  assert.equal(readOpenOpportunity(response, ids).id, 'o1');
  assert.equal(readOpenOpportunity({ statusCode: 200, body: { opportunities: [] } }, ids), null);
  assert.throws(() => readOpenOpportunity({ statusCode: 500, body: {} }, ids), /opportunity search failed/);
});

test('follow-up is due the next business day at 10:00 location time', () => {
  // Friday 2026-11-06 16:00 in Los Angeles (PST, UTC-8) → Monday 2026-11-09 10:00 PST.
  assert.equal(nextBusinessDay10('2026-11-07T00:00:00Z', 'America/Los_Angeles'), '2026-11-09T18:00:00.000Z');
  // Tuesday → Wednesday 10:00 in Taipei (UTC+8).
  assert.equal(nextBusinessDay10('2026-11-03T03:00:00Z', 'Asia/Taipei'), '2026-11-04T02:00:00.000Z');
  const task = followUpTask(inquiry, { ...qualification, tier: 'qualified' }, { now: '2026-11-03T03:00:00Z', timeZone: 'Asia/Taipei' });
  assert.equal(task.title, 'Call Dana Whitfield about regular cleaning');
  assert.equal(task.completed, false);
  assert.equal(contactUrl('loc1', 'c1'), 'https://app.gohighlevel.com/v2/location/loc1/contacts/detail/c1');
});
