const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyHandshake, verifySignature, leadgenEvents, normalizeMetaLead, graphFailureAlert } = require('./meta');
const { toE164, validateInquiry } = require('./normalize');

test('handshake echoes the challenge only with the right verify token', () => {
  const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1158201444' };
  assert.deepEqual(verifyHandshake(query, 'tok'), { status: 200, body: '1158201444' });
  assert.equal(verifyHandshake({ ...query, 'hub.verify_token': 'nope' }, 'tok').status, 403);
  assert.equal(verifyHandshake(query, '').status, 403);
});

test('signature is checked against the raw bytes Meta sent', () => {
  // Meta escapes "/" and non-ASCII in its JSON, so re-serializing the parsed body would not match.
  const raw = Buffer.from('{"object":"page","entry":[{"changes":[{"field":"leadgen","value":{"leadgen_id":"1","note":"caf\\u00e9 \\/"}}]}]}');
  const header = 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
  assert.equal(verifySignature(raw, header, 'secret'), true);
  assert.equal(verifySignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), header, 'secret'), false);
  assert.equal(verifySignature(raw, header, 'other'), false);
  assert.equal(verifySignature(raw, '', 'secret'), false);
  assert.equal(verifySignature(raw, 'sha1=abc', 'secret'), false);
});

test('only leadgen changes become events', () => {
  const events = leadgenEvents({ object: 'page', entry: [{ id: 'page1', changes: [{ field: 'feed', value: {} }, { field: 'leadgen', value: { leadgen_id: 555, page_id: 'page1', form_id: 'form9' } }] }] });
  assert.deepEqual(events, [{ leadgenId: '555', pageId: 'page1', formId: 'form9' }]);
  assert.deepEqual(leadgenEvents({}), []);
});

test('a Graph lead becomes the shared inquiry shape', () => {
  const lead = {
    id: '987654321', form_id: 'form9', created_time: '2026-11-03T17:20:11+0000',
    field_data: [
      { name: 'full_name', values: ['Dana Whitfield'] },
      { name: 'email', values: ['Dana.Whitfield@Example.com'] },
      { name: 'phone_number', values: ['+15105550142'] },
      { name: 'what_do_you_need_cleaned,_and_how_often?', values: ['Weekly after-hours cleaning, 3,200 sq ft dental office'] },
      { name: 'preferred_contact_time', values: ['Evenings'] },
    ],
  };
  const inquiry = normalizeMetaLead(lead, { toE164 });
  assert.equal(inquiry.source, 'meta_lead');
  assert.equal(inquiry.source_id, 'meta:987654321');
  assert.equal(inquiry.received_at, '2026-11-03T17:20:11.000Z');
  assert.deepEqual([inquiry.name, inquiry.email, inquiry.phone], ['Dana Whitfield', 'dana.whitfield@example.com', '+15105550142']);
  assert.equal(inquiry.message, 'Weekly after-hours cleaning, 3,200 sq ft dental office\npreferred_contact_time: Evenings');
  assert.equal(inquiry.subject, 'Facebook lead form');
  assert.equal(validateInquiry(inquiry, { demoOnly: true }).valid, true);
});

test('a lead from a real address is kept out in demo mode', () => {
  const inquiry = normalizeMetaLead({ id: '1', field_data: [{ name: 'email', values: ['someone@gmail.com'] }, { name: 'what_do_you_need', values: ['Office cleaning please'] }] }, { toE164 });
  assert.equal(validateInquiry(inquiry, { demoOnly: true }).reason, 'non_demo_address');
});

test('a Graph failure alert names the lead so it is not lost', () => {
  assert.match(graphFailureAlert({ leadgenId: '42', formId: 'f' }, 400, { error: { message: 'Session has expired' } }), /Facebook lead 42 .*\(400\).*Session has expired.*by hand/);
});
