import test from 'node:test';
import assert from 'node:assert/strict';
import { freshState, handle } from './mock_platforms.mjs';

const auth = { authorization: 'Bearer pit-test', version: '2021-07-28' };
const call = (state, method, url, body = null, headers = auth) => handle(state, method, url, headers, body);

test('GoHighLevel calls need the bearer token and the Version header', () => {
  const state = freshState('loc1');
  assert.equal(call(state, 'GET', '/locations/loc1', null, {}).status, 401);
  assert.equal(call(state, 'GET', '/locations/loc1', null, { authorization: 'Bearer x' }).status, 400);
  assert.equal(call(state, 'GET', '/locations/loc1').status, 200);
});

test('a second contact with the same email or phone is refused and named, like a location without duplicates', () => {
  const state = freshState('loc1');
  const first = call(state, 'POST', '/contacts/', { locationId: 'loc1', email: 'dana@example.com', phone: '+15105550142', customFields: [{ id: 'f1', field_value: 'qualified' }] });
  assert.equal(first.status, 201);
  const byPhone = call(state, 'POST', '/contacts/', { locationId: 'loc1', email: 'other@example.com', phone: '+15105550142' });
  assert.equal(byPhone.status, 400);
  assert.equal(byPhone.body.meta.contactId, first.body.contact.id);
  assert.equal(call(state, 'GET', '/contacts/search/duplicate?locationId=loc1&email=DANA%40example.com').body.contact.id, first.body.contact.id);
  assert.equal(call(state, 'GET', '/contacts/search/duplicate?locationId=loc1&email=nobody%40example.com').body.contact, null);
  assert.deepEqual(call(state, 'GET', `/contacts/${first.body.contact.id}`).body.contact.customFields, [{ id: 'f1', value: 'qualified' }]);
});

test('PUT refuses locationId and tags, and merges custom fields', () => {
  const state = freshState('loc1');
  const id = call(state, 'POST', '/contacts/', { locationId: 'loc1', email: 'a@example.com', customFields: [{ id: 'f1', field_value: 'x' }] }).body.contact.id;
  assert.equal(call(state, 'PUT', `/contacts/${id}`, { tags: ['a'] }).status, 422);
  call(state, 'PUT', `/contacts/${id}`, { customFields: [{ id: 'f2', field_value: 'y' }] });
  assert.deepEqual(state.contacts[id].customFields, [{ id: 'f1', value: 'x' }, { id: 'f2', value: 'y' }]);
});

test('opportunities, notes, tasks and the Graph lead read', () => {
  const state = freshState('loc1');
  const id = call(state, 'POST', '/contacts/', { locationId: 'loc1', email: 'a@example.com' }).body.contact.id;
  const opp = call(state, 'POST', '/opportunities/', { contactId: id, pipelineId: 'mockPipeline01', pipelineStageId: 'mockStage02', status: 'open' }).body.opportunity;
  assert.equal(call(state, 'GET', `/opportunities/search?contact_id=${id}&pipeline_id=mockPipeline01&status=open`).body.opportunities[0].id, opp.id);
  assert.equal(call(state, 'GET', `/opportunities/search?contact_id=${id}&pipeline_id=mockPipeline01&status=all`).body.opportunities.length, 1);
  assert.equal(call(state, 'POST', `/contacts/${id}/notes`, { body: 'hi' }).status, 201);
  assert.equal(call(state, 'GET', `/contacts/${id}/notes`).body.notes.length, 1);
  call(state, 'POST', '/__seed/lead', { id: '900', field_data: [] }, {});
  assert.equal(call(state, 'GET', '/v21.0/900?fields=field_data', null, {}).status, 400);
  assert.equal(call(state, 'GET', '/v21.0/900?fields=field_data&access_token=EAAx', null, {}).body.id, '900');
  assert.equal(call(state, 'GET', '/v21.0/901?access_token=EAAx', null, {}).status, 400);
});
