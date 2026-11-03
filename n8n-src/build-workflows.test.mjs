import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkflows } from './build-workflows.mjs';

const workflows = buildWorkflows(mkdtempSync(join(tmpdir(), 'wf-')));

test('builds the six workflows and every connection points at a real node', () => {
  assert.deepEqual(workflows.map((item) => item.id), ['wfFormIntake', 'wfEmailIntake', 'wfMetaLeadIntake', 'wfProcessInquiry', 'wfReviewPage', 'wfErrorHandler']);
  for (const workflow of workflows) {
    const names = new Set(workflow.nodes.map((node) => node.name));
    assert.equal(names.size, workflow.nodes.length, `${workflow.id} has duplicate node names`);
    for (const [from, value] of Object.entries(workflow.connections)) {
      assert.ok(names.has(from), `${workflow.id}: unknown source ${from}`);
      for (const branch of value.main) for (const target of branch) assert.ok(names.has(target.node), `${workflow.id}: unknown target ${target.node}`);
    }
  }
});

test('output is deterministic', () => {
  const again = buildWorkflows(mkdtempSync(join(tmpdir(), 'wf-')));
  assert.equal(JSON.stringify(again), JSON.stringify(workflows));
});

test('code nodes never use $json in run-once-for-all-items mode', () => {
  for (const workflow of workflows) {
    for (const node of workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.code')) {
      assert.ok(!/(^|[^.\w])\$json\b/.test(node.parameters.jsCode), `${workflow.id} / ${node.name} uses $json`);
    }
  }
});

test('no secret values or leftover HubSpot or Salesforce calls are baked into the workflows', () => {
  const text = JSON.stringify(workflows);
  assert.ok(!/sk-[A-Za-z0-9]{10,}|pit-[A-Za-z0-9-]{10,}|EAA[A-Za-z0-9]{20,}|hooks\.slack\.com\/services/.test(text));
  assert.ok(!/hubspot|hubapi|salesforce|SF_INSTANCE_URL/i.test(text));
});

test('every GoHighLevel call sends the token credential and the Version header', () => {
  const calls = workflows.flatMap((item) => item.nodes).filter((node) => String(node.parameters.url || '').includes('GHL_BASE_URL'));
  assert.ok(calls.length >= 10);
  for (const node of calls) {
    assert.equal(node.credentials.httpHeaderAuth.id, 'ghlTokenCred01', node.name);
    assert.deepEqual(node.parameters.headerParameters.parameters[0], { name: 'Version', value: '2021-07-28' }, node.name);
    assert.equal(node.parameters.options.response.response.neverError, true, node.name);
  }
});

test('the Meta webhook answers 200 only after the signature check and reads leads with the Page credential', () => {
  const meta = workflows.find((item) => item.id === 'wfMetaLeadIntake');
  const [signed, unsigned] = meta.connections['Signed by Meta?'].main;
  assert.equal(signed[0].node, 'Respond 200');
  assert.equal(unsigned[0].node, 'Respond 401');
  const post = meta.nodes.find((node) => node.name === 'Receive Meta lead');
  const get = meta.nodes.find((node) => node.name === 'Meta verify');
  assert.equal(post.parameters.options.rawBody, true);
  assert.notEqual(post.webhookId, get.webhookId);
  assert.equal(meta.nodes.find((node) => node.name === 'Fetch lead from Meta').credentials.httpQueryAuth.id, 'metaPageCred01');
  assert.equal(meta.connections['Valid inquiry?'].main[0][0].node, 'Process inquiry');
});

test('a repeat submission stops before the AI call and GoHighLevel writes', () => {
  const process = workflows.find((item) => item.id === 'wfProcessInquiry');
  const [repeat, fresh] = process.connections['Repeat submission?'].main;
  assert.equal(repeat[0].node, 'Log repeat submission');
  assert.equal(fresh[0].node, 'Build qualify request');
  assert.equal(process.connections['Log repeat submission'].main[0][0].node, 'Write run log');
  const [refused, saved] = process.connections['Refused as duplicate?'].main;
  assert.equal(refused[0].node, 'Get existing contact');
  assert.equal(saved[0].node, 'Contact saved');
});

test('the review page and the form it posts to both ask for the review login', () => {
  const page = workflows.find((item) => item.id === 'wfReviewPage').nodes.find((node) => node.name === 'Open review page');
  const wait = workflows.find((item) => item.id === 'wfProcessInquiry').nodes.find((node) => node.name === 'Wait for review');
  assert.equal(page.parameters.authentication, 'basicAuth');
  assert.equal(wait.parameters.incomingAuthentication, 'basicAuth');
  assert.equal(page.credentials.httpBasicAuth.id, 'reviewLoginCred01');
  assert.equal(wait.credentials.httpBasicAuth.id, 'reviewLoginCred01');
});

test('only the reply node sends email, and it uses the redirect-aware fields', () => {
  const process = workflows.find((item) => item.id === 'wfProcessInquiry');
  const senders = process.nodes.filter((node) => node.type === 'n8n-nodes-base.emailSend');
  assert.equal(senders.length, 1);
  assert.equal(senders[0].parameters.toEmail, '={{ $json.email.to }}');
  assert.equal(process.connections['Prepare email'].main[0][0].node, 'Send reply');
});
