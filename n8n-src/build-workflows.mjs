// Generates workflows/*.json. Code-node logic lives in n8n-src/code/*.js so it can be unit tested.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const outputDir = join(root, '..', 'workflows');

const CREDS = {
  ghl: { httpHeaderAuth: { id: 'ghlTokenCred01', name: 'GoHighLevel (private integration)' } },
  metaPage: { httpQueryAuth: { id: 'metaPageCred01', name: 'Meta Page token' } },
  openai: { httpHeaderAuth: { id: 'openAiCred01', name: 'OpenAI' } },
  imap: { imap: { id: 'gmailImapCred01', name: 'Gmail IMAP (demo inbox)' } },
  smtp: { smtp: { id: 'gmailSmtpCred01', name: 'Gmail SMTP (demo inbox)' } },
};

const id = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// n8n registers production webhooks by webhookId; derive a stable UUID from the path.
const stableUuid = (value) => createHash('sha1').update(value).digest('hex').slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const at = (node, x, y) => ({ ...node, position: [x, y] });
const edge = (node, index = 0) => ({ node, type: 'main', index });
const note = (name, content, x, y, width, height, color) => ({ id: `note-${id(name)}`, name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y], parameters: { content, width, height, color } });

// Strip the CommonJS export line so the module bodies can be inlined into a Code node.
const source = (...names) => names.map((name) => readFileSync(join(root, 'code', `${name}.js`), 'utf8').replace(/^if \(typeof module !== 'undefined'\).*$/m, '').trim()).join('\n\n');

function loadPrompt(name) {
  const text = readFileSync(join(root, '..', 'prompts', `${name}.md`), 'utf8');
  const section = (title) => (text.split(/^## /m).find((part) => part.startsWith(title)) || '').slice(title.length).trim();
  const schema = section('JSON schema').match(/```json\s*([\s\S]*?)```/);
  return { system: section('System'), userTemplate: section('User template'), schema: schema ? JSON.parse(schema[1]) : null };
}

const code = (name, jsCode) => ({ id: id(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { jsCode } });
const ifNode = (name, leftValue, operator, rightValue = '') => ({
  id: id(name), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [0, 0],
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: `${id(name)}-condition`, leftValue, rightValue, operator }], combinator: 'and' }, options: {} },
});
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };
const equals = { type: 'string', operation: 'equals' };
const notEmpty = { type: 'string', operation: 'notEmpty', singleValue: true };
const greater = { type: 'number', operation: 'gt' };

const webhook = (name, path, method = 'POST') => ({ id: id(name), name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: stableUuid(method === 'POST' ? path : `${method}:${path}`), parameters: { httpMethod: method, path, responseMode: 'responseNode', options: {} } });
const respond = (name, { body, code: status = 200, html = false, json = false }) => ({
  id: id(name), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0],
  parameters: {
    respondWith: json ? 'json' : 'text', responseBody: body,
    options: { responseCode: status, ...(html ? { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } : {}) },
  },
});

const fullResponse = { response: { response: { fullResponse: true, neverError: true, responseFormat: 'autodetect' } } };
// GoHighLevel API v2: Private Integration Token as a bearer header, plus the Version header every call needs.
// Responses come back as { statusCode, body } so Code nodes decide what counts as failure.
const ghl = (name, method, pathExpression, bodyExpression) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, credentials: CREDS.ghl,
  parameters: {
    method, url: `={{ $env.GHL_BASE_URL + ${pathExpression} }}`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'Version', value: '2021-07-28' }, { name: 'Accept', value: 'application/json' }] },
    ...(bodyExpression ? { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${bodyExpression}) }}` } : {}),
    options: fullResponse,
  },
});
// Graph API lead read; the Page token is sent as the access_token query parameter by the credential.
const graph = (name) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, credentials: CREDS.metaPage,
  parameters: { method: 'GET', url: '={{ $env.META_GRAPH_URL + $json.path }}', authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth', options: fullResponse },
});
// Errors continue as an item with `error`, so a failed AI call still ends in a saved lead.
const openai = (name) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput', credentials: CREDS.openai,
  parameters: {
    method: 'POST', url: 'https://api.openai.com/v1/chat/completions', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ model: $env.OPENAI_MODEL, ...$json.request }) }}', options: { timeout: 60000 },
  },
});
const slack = (name, textExpression) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
  parameters: { method: 'POST', url: '={{ $env.SLACK_WEBHOOK_URL }}', sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify({ text: ${textExpression} }) }}`, options: {} },
});
const callProcess = (name) => ({
  id: id(name), name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [0, 0],
  parameters: {
    source: 'database', workflowId: { __rl: true, value: 'wfProcessInquiry', mode: 'id' }, mode: 'each',
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    options: { waitForSubWorkflow: false },
  },
});

const workflow = (wfId, name, nodes, connections, errorWorkflow = true) => ({
  id: wfId, name, active: false,
  settings: { executionOrder: 'v1', ...(errorWorkflow ? { errorWorkflow: 'wfErrorHandler' } : {}) },
  nodes, connections, pinData: {}, versionId: '1',
});

const loadFixtures = "JSON.parse(require('fs').readFileSync('/files/sample-data/fixtures.json', 'utf8')).fixtures";
const runLogShape = (fields) => `[{ json: { runLog: ${fields} } }]`;
const recordLog = 'contactId: ctx.contactId, matchedBy: ctx.matchedBy, opportunityId: ctx.opportunityId, stage: ctx.stage, taskId: ctx.taskId';
// Custom field, pipeline and stage ids, written by scripts/ghl_setup.py.
const loadIds = "const ids = JSON.parse(require('fs').readFileSync('/files/output/ghl-ids.json', 'utf8'));";

// Shared tail: write the run log, then post any alerts to Slack.
function runLogTail(x, y) {
  return [
    at(code('Write run log', `${source('review', 'records', 'llm')}

const fs = require('fs');
const entry = $input.first().json.runLog;
const fixtures = ${loadFixtures};
const log = buildRunLog({ ...entry, fixtureId: fixtureIdFor(entry.inquiry.source_id, fixtures, entry.inquiry.email), executionId: $execution.id });
const name = safeId(entry.inquiry.source_id);
fs.mkdirSync('/files/output/run-log', { recursive: true });
fs.writeFileSync('/files/output/run-log/' + Date.now() + '-' + name + '.json', JSON.stringify(log, null, 2), 'utf8');
const reviewFile = '/files/output/review/' + name + '.json';
if (log.draft !== 'none' && fs.existsSync(reviewFile)) {
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  fs.writeFileSync(reviewFile, JSON.stringify({ ...review, status: log.draft, closed_at: log.ts }, null, 2), 'utf8');
}
return [{ json: log }];`), x, y),
    at(ifNode('Any alerts?', '={{ $json.alerts.length }}', greater, 0), x + 220, y),
    at(slack('Send alert', "$json.alerts.join('\\n')"), x + 440, y - 100),
  ];
}
const tailConnections = {
  'Write run log': { main: [[edge('Any alerts?')]] },
  'Any alerts?': { main: [[edge('Send alert')], []] },
};

function formIntake() {
  const nodes = [
    note('About', '## Form intake\n`POST /webhook/inquiry` from the website form. Bad input gets a 400 and a Slack alert; good input gets a 202 and goes to **Process inquiry**.', -80, -60, 1240, 140, 7),
    at(webhook('Receive form inquiry', 'inquiry'), 0, 200),
    at(code('Normalize form', `${source('normalize')}

const item = $input.first().json;
const demoMode = $env.DEMO_MODE === '1';
const inquiry = normalizeForm(item.body || {}, item.headers || {}, { demoMode });
return [{ json: { ...inquiry, validation: validateInquiry(inquiry, { demoOnly: demoMode }) } }];`), 220, 200),
    at(ifNode('Valid inquiry?', '={{ $json.validation.valid }}', isTrue), 440, 200),
    at(respond('Respond 202 accepted', { json: true, code: 202, body: '={{ JSON.stringify({ accepted: true, source_id: $json.source_id }) }}' }), 680, 100),
    at(callProcess('Process inquiry'), 900, 100),
    at(respond('Respond 400 rejected', { json: true, code: 400, body: "={{ JSON.stringify({ accepted: false, error: 'invalid_inquiry', reason: $json.validation.reason }) }}" }), 680, 320),
    at(code('Log rejected input', `${source('records')}

const inquiry = $('Normalize form').first().json;
return ${runLogShape("{ inquiry, action: 'rejected_input', alerts: [rejectedInputAlert(inquiry, inquiry.validation.reason)] }")};`), 900, 320),
    ...runLogTail(1120, 320),
  ];
  return workflow('wfFormIntake', 'Lead intake: website form', nodes, {
    'Receive form inquiry': { main: [[edge('Normalize form')]] },
    'Normalize form': { main: [[edge('Valid inquiry?')]] },
    'Valid inquiry?': { main: [[edge('Respond 202 accepted')], [edge('Respond 400 rejected')]] },
    'Respond 202 accepted': { main: [[edge('Process inquiry')]] },
    'Respond 400 rejected': { main: [[edge('Log rejected input')]] },
    'Log rejected input': { main: [[edge('Write run log')]] },
    ...tailConnections,
  });
}

function emailIntake() {
  const nodes = [
    note('About', '## Email intake\nWatches the demo inbox over IMAP (unread only, marked read after). The sender comes from Reply-To when present. Our own outgoing replies are skipped.', -80, -60, 1240, 140, 7),
    at({ id: 'watch-inbox', name: 'Watch inbox', type: 'n8n-nodes-base.emailReadImap', typeVersion: 2, position: [0, 0], credentials: CREDS.imap, parameters: { mailbox: 'INBOX', postProcessAction: 'read', format: 'resolved', options: { customEmailConfig: '["UNSEEN"]' } } }, 0, 200),
    at(code('Normalize email', `${source('normalize')}

// In demo mode, mail from real senders (for example Google's welcome emails) is skipped without an alert.
const demoMode = $env.DEMO_MODE === '1';
return $input.all()
  .map((item) => normalizeEmail(item.json, { selfAddress: $env.GMAIL_ADDRESS }))
  .filter((inquiry) => !inquiry.skip && !(demoMode && inquiry.email && !isDemoAddress(inquiry.email)))
  .map((inquiry) => ({ json: { ...inquiry, validation: validateInquiry(inquiry, { demoOnly: demoMode }) } }));`), 220, 200),
    at(ifNode('Valid inquiry?', '={{ $json.validation.valid }}', isTrue), 440, 200),
    at(callProcess('Process inquiry'), 680, 100),
    at(code('Log rejected input', `${source('records')}

return $input.all().map((item) => ({ json: { runLog: { inquiry: item.json, action: 'rejected_input', alerts: [rejectedInputAlert(item.json, item.json.validation.reason)] } } }));`), 680, 320),
    ...runLogTail(900, 320),
  ];
  return workflow('wfEmailIntake', 'Lead intake: email inbox', nodes, {
    'Watch inbox': { main: [[edge('Normalize email')]] },
    'Normalize email': { main: [[edge('Valid inquiry?')]] },
    'Valid inquiry?': { main: [[edge('Process inquiry')], [edge('Log rejected input')]] },
    'Log rejected input': { main: [[edge('Write run log')]] },
    ...tailConnections,
  });
}

function processInquiry() {
  const qualifyPrompt = loadPrompt('qualify');
  const draftPrompt = loadPrompt('draft-reply');
  const mockLoader = (kind) => `${source('llm')}

const fs = require('fs');
const ctx = $input.first().json;
const id = fixtureIdFor(ctx.inquiry.source_id, ${loadFixtures}, ctx.inquiry.email);
const file = '/files/sample-data/mock-llm/' + id + '.${kind}.json';
const content = id && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
return [{ json: mockResponse(content, ${kind === 'qualify' ? 'Boolean(ctx.inquiry.demo_flags && ctx.inquiry.demo_flags.break_llm)' : 'false'}) }];`;
  const link = 'contactUrl($env.GHL_LOCATION_ID, ctx.contactId)';

  const nodes = [
    note('Find contact', '## 1. Find the contact\nDuplicate search by email, then by phone. A contact whose **Inquiry Source IDs** already holds this source id is a repeat: stop here, no AI call.', -80, -120, 1840, 160, 7),
    note('Classify', '## 2. Classify\nOpenAI (or a stored mock answer) sorts the lead. Code checks the enums and that the quote is really in the message. Any failure becomes **Needs review** with no draft and a Slack alert.', 1820, -120, 1320, 160, 5),
    note('Write GoHighLevel', '## 3. Write to GoHighLevel\nUpdate the matched contact or create one (if GoHighLevel refuses it as a duplicate, update the contact it names). Add a note with the original message, then put the lead in the **Inquiries** pipeline: one open opportunity per contact, moved only upward, plus a follow-up task for Qualified.', 3200, -120, 3080, 160, 4),
    note('Review', '## 4. Human review\nDraft a reply, post the review link to Slack and wait. Nothing is sent until a named reviewer approves; the decision is saved as a note.', 6340, -120, 4520, 160, 6),

    at({ id: 'start', name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0], parameters: { inputSource: 'passthrough' } }, 0, 200),
    at(code('Build lookup', `${source('ghl')}

const inquiry = $input.first().json;
return lookupRequests(inquiry, $env.GHL_LOCATION_ID).map((request) => ({ json: { inquiry, ...request } }));`), 220, 200),
    at(ghl('GHL lookup', 'GET', '$json.path', null), 440, 200),
    at(code('Resolve match', `${source('ghl')}

const asked = $('Build lookup').all();
const responses = $input.all().map((item, index) => ({ by: asked[index].json.by, ...item.json }));
const match = resolveLookups(responses);
return [{ json: { inquiry: asked[0].json.inquiry, ...match, contact: null, duplicate: false } }];`), 660, 200),
    at(ifNode('Known contact?', '={{ $json.contactId }}', notEmpty), 880, 200),
    at(ghl('Get contact', 'GET', "'/contacts/' + $json.contactId", null), 1100, 60),
    at(code('Read contact', `${source('ghl')}

${loadIds}
const ctx = $('Resolve match').first().json;
const contact = readContact($input.first().json, ids);
return [{ json: { ...ctx, contact, duplicate: isRepeat(contact, ctx.inquiry.source_id) } }];`), 1320, 60),
    at(ifNode('Repeat submission?', '={{ $json.duplicate }}', isTrue), 1540, 200),
    at(code('Log repeat submission', `const ctx = $input.first().json;
return ${runLogShape("{ inquiry: ctx.inquiry, contactId: ctx.contactId, matchedBy: ctx.matchedBy, action: 'duplicate_submission', alerts: [] }")};`), 1760, 420),

    at(code('Build qualify request', `${source('llm')}

const PROMPT = ${JSON.stringify(qualifyPrompt)};
const ctx = $input.first().json;
return [{ json: { ...ctx, request: buildQualifyRequest(ctx.inquiry, PROMPT) } }];`), 1760, 200),
    at(ifNode('Use live LLM?', '={{ $env.LLM_MODE }}', equals, 'live'), 1980, 200),
    at(openai('Qualify (OpenAI)'), 2200, 100),
    at(code('Load mock qualification', mockLoader('qualify')), 2200, 320),
    at(code('Apply qualification', `${source('llm', 'ghl')}

${loadIds}
const ctx = $('Build qualify request').first().json;
const qualification = qualificationFromLlm($input.first().json, ctx.inquiry.message);
const write = contactRequest(ctx.inquiry, qualification, ctx.contact, ids, $env.GHL_LOCATION_ID);
return [{ json: { inquiry: ctx.inquiry, contact: ctx.contact, contactId: ctx.contactId, matchedBy: ctx.matchedBy, qualification, tier: write.tier, write } }];`), 2420, 200),

    at(ghl('Write contact', '={{ $json.write.method }}', '$json.write.path', '$json.write.body'), 3280, 200),
    at(code('Read write result', `${source('ghl')}

const res = $input.first().json;
const ctx = $('Apply qualification').first().json;
if (ctx.write.method === 'PUT') {
  if (res.statusCode !== 200) throw new Error('GoHighLevel update contact failed: ' + res.statusCode + ' ' + JSON.stringify(res.body).slice(0, 300));
  return [{ json: { ...ctx, action: 'updated', conflict: false } }];
}
const created = createdContactId(res);
if (created) return [{ json: { ...ctx, contactId: created, action: 'created', conflict: false } }];
const existing = parseDuplicateCreate(res);
if (!existing) throw new Error('GoHighLevel create contact failed: ' + res.statusCode + ' ' + JSON.stringify(res.body).slice(0, 300));
return [{ json: { ...ctx, contactId: existing, matchedBy: 'duplicateRefused', action: 'updated', conflict: true } }];`), 3500, 200),
    at(ifNode('Refused as duplicate?', '={{ $json.conflict }}', isTrue), 3720, 200),
    at(ghl('Get existing contact', 'GET', "'/contacts/' + $json.contactId", null), 3940, 360),
    at(code('Rebuild update', `${source('ghl')}

${loadIds}
const ctx = $('Read write result').first().json;
const contact = readContact($input.first().json, ids);
return [{ json: { ...ctx, contact, write: contactRequest(ctx.inquiry, ctx.qualification, contact, ids, $env.GHL_LOCATION_ID) } }];`), 4160, 360),
    at(ghl('Update existing contact', 'PUT', '$json.write.path', '$json.write.body'), 4380, 360),
    at(code('Contact saved', `const update = $('Update existing contact').isExecuted ? $('Update existing contact').first().json : null;
if (update && update.statusCode !== 200) throw new Error('GoHighLevel update contact failed: ' + update.statusCode + ' ' + JSON.stringify(update.body).slice(0, 300));
const ctx = update ? $('Rebuild update').first().json : $('Read write result').first().json;
${loadIds}
const search = '/opportunities/search?location_id=' + encodeURIComponent($env.GHL_LOCATION_ID) + '&contact_id=' + encodeURIComponent(ctx.contactId) + '&pipeline_id=' + encodeURIComponent(ids.pipelineId) + '&status=open';
const { write, conflict, ...rest } = ctx;
return [{ json: { ...rest, opportunitySearch: search } }];`), 4600, 200),
    at(code('Prepare inquiry note', `${source('ghl')}

const ctx = $input.first().json;
return [{ json: { ...ctx, note: inquiryNote(ctx.inquiry, ctx.qualification) } }];`), 4820, 200),
    at(ghl('Add inquiry note', 'POST', "'/contacts/' + $json.contactId + '/notes'", '$json.note'), 5040, 200),
    at(ghl('Find open opportunity', 'GET', "$('Prepare inquiry note').first().json.opportunitySearch", null), 5260, 200),
    at(code('Plan opportunity', `${source('ghl')}

${loadIds}
const noteRes = $('Add inquiry note').first().json;
if (![200, 201].includes(noteRes.statusCode)) throw new Error('GoHighLevel add note failed: ' + noteRes.statusCode + ' ' + JSON.stringify(noteRes.body).slice(0, 300));
const { note, opportunitySearch, ...ctx } = $('Prepare inquiry note').first().json;
const existing = readOpenOpportunity($input.first().json, ids);
const label = ctx.inquiry.name || ctx.inquiry.email || ctx.inquiry.phone;
const plan = planOpportunity({ tier: ctx.tier, contactId: ctx.contactId, label, topic: ctx.qualification.topic.replace(/_/g, ' '), existing, ids, locationId: $env.GHL_LOCATION_ID });
const task = plan.needsTask ? followUpTask(ctx.inquiry, ctx.qualification, { now: new Date().toISOString(), timeZone: ids.timezone }) : null;
return [{ json: { ...ctx, plan, task, opportunityId: plan.opportunityId, stage: plan.stage } }];`), 5480, 200),
    at(ifNode('Change opportunity?', '={{ !!$json.plan.request }}', isTrue), 5700, 200),
    at(ghl('Write opportunity', '={{ $json.plan.request.method }}', '$json.plan.request.path', '$json.plan.request.body'), 5920, 100),
    at(code('Opportunity saved', `const ctx = $('Plan opportunity').first().json;
let opportunityId = ctx.opportunityId;
if ($('Write opportunity').isExecuted) {
  const res = $('Write opportunity').first().json;
  if (![200, 201].includes(res.statusCode)) throw new Error('GoHighLevel opportunity write failed: ' + res.statusCode + ' ' + JSON.stringify(res.body).slice(0, 300));
  opportunityId = (res.body.opportunity && res.body.opportunity.id) || opportunityId;
}
return [{ json: { ...ctx, opportunityId } }];`), 6140, 200),
    at(ifNode('Follow-up task?', '={{ !!$json.task }}', isTrue), 6360, 200),
    at(ghl('Create follow-up task', 'POST', "'/contacts/' + $json.contactId + '/tasks'", '$json.task'), 6580, 100),
    at(code('Task saved', `const ctx = $('Opportunity saved').first().json;
let taskId = null;
if ($('Create follow-up task').isExecuted) {
  const res = $('Create follow-up task').first().json;
  if (![200, 201].includes(res.statusCode)) throw new Error('GoHighLevel create task failed: ' + res.statusCode + ' ' + JSON.stringify(res.body).slice(0, 300));
  taskId = (res.body.task && res.body.task.id) || res.body.id || null;
}
const { plan, task, ...rest } = ctx;
return [{ json: { ...rest, taskId } }];`), 6800, 200),
    at(ifNode('Draft a reply?', "={{ $json.qualification.llm_ok && $json.qualification.tier !== 'not_qualified' }}", isTrue), 7020, 200),
    at(code('Log without draft', `${source('records', 'ghl')}

const ctx = $input.first().json;
const alerts = ctx.qualification.llm_ok ? [] : [llmFailureAlert(ctx.inquiry, ctx.qualification, ${link})];
return ${runLogShape(`{ inquiry: ctx.inquiry, ${recordLog}, action: ctx.action, qualification: ctx.qualification, draft: 'none', alerts }`)};`), 7240, 420),

    at(code('Build draft request', `${source('llm')}

const PROMPT = ${JSON.stringify(draftPrompt)};
const ctx = $input.first().json;
return [{ json: { ...ctx, request: buildDraftRequest(ctx.inquiry, ctx.qualification, PROMPT) } }];`), 7240, 100),
    at(ifNode('Use live LLM? (draft)', '={{ $env.LLM_MODE }}', equals, 'live'), 7460, 100),
    at(openai('Draft reply (OpenAI)'), 7680, 0),
    at(code('Load mock draft', mockLoader('draft')), 7680, 200),
    at(code('Check draft', `${source('llm')}

const ctx = $('Build draft request').first().json;
const { request, ...rest } = ctx;
return [{ json: { ...rest, draft: draftFromLlm($input.first().json) } }];`), 7900, 100),
    at(ifNode('Draft usable?', '={{ $json.draft.ok }}', isTrue), 8120, 100),
    at(code('Log draft failure', `${source('ghl')}

const ctx = $input.first().json;
const alert = ':warning: AI reply draft failed (' + ctx.draft.error + ') for ' + (ctx.inquiry.email || ctx.inquiry.phone) + '. The lead is in GoHighLevel; please write the reply by hand: ' + ${link};
return ${runLogShape(`{ inquiry: ctx.inquiry, ${recordLog}, action: ctx.action, qualification: ctx.qualification, draft: 'none', alerts: [alert] }`)};`), 8340, 320),
    at(code('Build review page', `${source('review', 'records', 'ghl')}

const fs = require('fs');
const ctx = $input.first().json;
const reviewId = safeId(ctx.inquiry.source_id);
const resumeUrl = $execution.resumeUrl;
const page = buildReviewPage({ inquiry: ctx.inquiry, qualification: ctx.qualification, draft: ctx.draft, recordUrl: ${link}, resumeUrl });
fs.mkdirSync('/files/output/review', { recursive: true });
fs.writeFileSync('/files/output/review/' + reviewId + '.html', page, 'utf8');
fs.writeFileSync('/files/output/review/' + reviewId + '.json', JSON.stringify({ source_id: ctx.inquiry.source_id, resume_url: resumeUrl, execution_id: $execution.id, status: 'pending', created_at: new Date().toISOString() }, null, 2), 'utf8');
const reviewUrl = ($env.WEBHOOK_URL || 'http://localhost:5681/') + 'webhook/review?id=' + encodeURIComponent(reviewId);
return [{ json: { ...ctx, reviewId, reviewUrl, slackText: reviewAlert(ctx.inquiry, ctx.qualification, reviewUrl) } }];`), 8340, 0),
    at(slack('Notify reviewer', '$json.slackText'), 8560, 0),
    at({ id: 'wait-for-review', name: 'Wait for review', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [0, 0], webhookId: stableUuid('wait-for-review'), parameters: { resume: 'webhook', httpMethod: 'POST', responseMode: 'responseNode', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 72, resumeUnit: 'hours', options: {} } }, 8780, 0),
    at(code('Read decision', `${source('review')}

const ctx = $('Build review page').first().json;
const input = $input.first().json;
const body = Object.prototype.hasOwnProperty.call(input, 'body') ? input.body : undefined;
const result = parseDecision(body, ctx.draft);
return [{ json: { ...ctx, result, errorHtml: errorPage(result.errors || []), receiptHtml: receiptPage(result.decision === 'approve' ? 'Review received: approved and sent' : 'Review received: rejected, nothing sent') } }];`), 9000, 0),
    at(ifNode('Timed out?', '={{ $json.result.timedOut }}', isTrue), 9220, 0),
    at(ifNode('Review complete?', '={{ $json.result.errors.length }}', { type: 'number', operation: 'equals' }, 0), 9440, 100),
    at(respond('Respond: fix the form', { html: true, code: 422, body: '={{ $json.errorHtml }}' }), 9660, 320),
    at(ifNode('Approved?', '={{ $json.result.decision }}', equals, 'approve'), 9660, 100),
    at(code('Prepare email', `${source('review')}

const ctx = $input.first().json;
const email = outgoingEmail({ to: ctx.inquiry.email, subject: ctx.result.subject, body: ctx.result.body, demoMode: $env.DEMO_MODE === '1', redirectTo: $env.REPLY_REDIRECT_TO });
return [{ json: { ...ctx, email } }];`), 9880, 0),
    at({ id: 'send-reply', name: 'Send reply', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [0, 0], credentials: CREDS.smtp, parameters: { fromEmail: '={{ "Tidewell Commercial Cleaning <" + $env.GMAIL_ADDRESS + ">" }}', toEmail: '={{ $json.email.to }}', subject: '={{ $json.email.subject }}', emailFormat: 'text', text: '={{ $json.email.body }}', options: { appendAttribution: false } } }, 10100, 0),
    at(code('Mark sent', "return [{ json: $('Prepare email').first().json }];"), 10320, 0),
    at(respond('Respond: sent', { html: true, body: '={{ $json.receiptHtml }}' }), 10540, 0),
    at(respond('Respond: rejected', { html: true, body: '={{ $json.receiptHtml }}' }), 9880, 200),
    at(code('Prepare decision note', `${source('ghl')}

const ctx = $input.first().json;
const r = ctx.result;
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const approved = !r.timedOut && r.decision === 'approve';
const sentTo = approved ? ctx.email.to : null;
const draft = r.timedOut ? 'timeout' : approved ? 'approved' : 'rejected';
const runLog = { inquiry: ctx.inquiry, ${recordLog}, action: ctx.action, qualification: ctx.qualification, draft, sentTo, reviewer: r.reviewer || null, edited: r.timedOut ? null : r.edited, alerts: [] };
return [{ json: { contactId: ctx.contactId, note: decisionNote(r, { date, sentTo }), runLog } }];`), 10760, 200),
    at(ghl('Add decision note', 'POST', "'/contacts/' + $json.contactId + '/notes'", '$json.note'), 10980, 200),
    at(code('Restore run log', `const res = $input.first().json;
if (![200, 201].includes(res.statusCode)) throw new Error('GoHighLevel add decision note failed: ' + res.statusCode + ' ' + JSON.stringify(res.body).slice(0, 300));
return [{ json: { runLog: $('Prepare decision note').first().json.runLog } }];`), 11200, 200),
    ...runLogTail(11420, 420),
  ];
  const connections = {
    Start: { main: [[edge('Build lookup')]] },
    'Build lookup': { main: [[edge('GHL lookup')]] },
    'GHL lookup': { main: [[edge('Resolve match')]] },
    'Resolve match': { main: [[edge('Known contact?')]] },
    'Known contact?': { main: [[edge('Get contact')], [edge('Repeat submission?')]] },
    'Get contact': { main: [[edge('Read contact')]] },
    'Read contact': { main: [[edge('Repeat submission?')]] },
    'Repeat submission?': { main: [[edge('Log repeat submission')], [edge('Build qualify request')]] },
    'Log repeat submission': { main: [[edge('Write run log')]] },
    'Build qualify request': { main: [[edge('Use live LLM?')]] },
    'Use live LLM?': { main: [[edge('Qualify (OpenAI)')], [edge('Load mock qualification')]] },
    'Qualify (OpenAI)': { main: [[edge('Apply qualification')]] },
    'Load mock qualification': { main: [[edge('Apply qualification')]] },
    'Apply qualification': { main: [[edge('Write contact')]] },
    'Write contact': { main: [[edge('Read write result')]] },
    'Read write result': { main: [[edge('Refused as duplicate?')]] },
    'Refused as duplicate?': { main: [[edge('Get existing contact')], [edge('Contact saved')]] },
    'Get existing contact': { main: [[edge('Rebuild update')]] },
    'Rebuild update': { main: [[edge('Update existing contact')]] },
    'Update existing contact': { main: [[edge('Contact saved')]] },
    'Contact saved': { main: [[edge('Prepare inquiry note')]] },
    'Prepare inquiry note': { main: [[edge('Add inquiry note')]] },
    'Add inquiry note': { main: [[edge('Find open opportunity')]] },
    'Find open opportunity': { main: [[edge('Plan opportunity')]] },
    'Plan opportunity': { main: [[edge('Change opportunity?')]] },
    'Change opportunity?': { main: [[edge('Write opportunity')], [edge('Opportunity saved')]] },
    'Write opportunity': { main: [[edge('Opportunity saved')]] },
    'Opportunity saved': { main: [[edge('Follow-up task?')]] },
    'Follow-up task?': { main: [[edge('Create follow-up task')], [edge('Task saved')]] },
    'Create follow-up task': { main: [[edge('Task saved')]] },
    'Task saved': { main: [[edge('Draft a reply?')]] },
    'Draft a reply?': { main: [[edge('Build draft request')], [edge('Log without draft')]] },
    'Log without draft': { main: [[edge('Write run log')]] },
    'Build draft request': { main: [[edge('Use live LLM? (draft)')]] },
    'Use live LLM? (draft)': { main: [[edge('Draft reply (OpenAI)')], [edge('Load mock draft')]] },
    'Draft reply (OpenAI)': { main: [[edge('Check draft')]] },
    'Load mock draft': { main: [[edge('Check draft')]] },
    'Check draft': { main: [[edge('Draft usable?')]] },
    'Draft usable?': { main: [[edge('Build review page')], [edge('Log draft failure')]] },
    'Log draft failure': { main: [[edge('Write run log')]] },
    'Build review page': { main: [[edge('Notify reviewer')]] },
    'Notify reviewer': { main: [[edge('Wait for review')]] },
    'Wait for review': { main: [[edge('Read decision')]] },
    'Read decision': { main: [[edge('Timed out?')]] },
    'Timed out?': { main: [[edge('Prepare decision note')], [edge('Review complete?')]] },
    'Review complete?': { main: [[edge('Approved?')], [edge('Respond: fix the form')]] },
    'Respond: fix the form': { main: [[edge('Wait for review')]] },
    'Approved?': { main: [[edge('Prepare email')], [edge('Respond: rejected')]] },
    'Prepare email': { main: [[edge('Send reply')]] },
    'Send reply': { main: [[edge('Mark sent')]] },
    'Mark sent': { main: [[edge('Respond: sent')]] },
    'Respond: sent': { main: [[edge('Prepare decision note')]] },
    'Respond: rejected': { main: [[edge('Prepare decision note')]] },
    'Prepare decision note': { main: [[edge('Add decision note')]] },
    'Add decision note': { main: [[edge('Restore run log')]] },
    'Restore run log': { main: [[edge('Write run log')]] },
    ...tailConnections,
  };
  return workflow('wfProcessInquiry', 'Lead intake: process inquiry', nodes, connections);
}

function metaLeadIntake() {
  const nodes = [
    note('About', '## Facebook lead form intake\nMeta calls `GET /webhook/meta-leads` once to subscribe, then `POST`s each new lead. The POST is accepted only with a valid `X-Hub-Signature-256` (HMAC of the raw body with the app secret). The lead itself is read from the Graph API with the Page token, mapped to the same inquiry shape as the form and email, and sent to **Process inquiry**.', -80, -60, 2000, 160, 7),
    at(webhook('Meta verify', 'meta-leads', 'GET'), 0, 600),
    at(code('Check verify token', `${source('meta')}

const result = verifyHandshake(($input.first().json.query || {}), $env.META_VERIFY_TOKEN);
return [{ json: result }];`), 220, 600),
    at({ ...respond('Respond to verify', { body: '={{ $json.body }}' }), parameters: { respondWith: 'text', responseBody: '={{ $json.body }}', options: { responseCode: '={{ $json.status }}' } } }, 440, 600),

    at({ ...webhook('Receive Meta lead', 'meta-leads', 'POST'), parameters: { httpMethod: 'POST', path: 'meta-leads', responseMode: 'responseNode', options: { rawBody: true } } }, 0, 200),
    at(code('Check signature', `${source('meta')}

const item = $input.first();
const headers = item.json.headers || {};
const raw = item.binary && item.binary.data ? await this.helpers.getBinaryDataBuffer(0, 'data') : Buffer.from('');
const valid = verifySignature(raw, headers['x-hub-signature-256'], $env.META_APP_SECRET);
return [{ json: { valid, reason: headers['x-hub-signature-256'] ? 'bad_signature' : 'missing_signature', events: valid ? leadgenEvents(item.json.body || {}) : [] } }];`), 220, 200),
    at(ifNode('Signed by Meta?', '={{ $json.valid }}', isTrue), 440, 200),
    at(respond('Respond 200', { body: 'EVENT_RECEIVED' }), 660, 100),
    at(code('Split leadgen events', "return $('Check signature').first().json.events.map((event) => ({ json: { ...event, path: '/v21.0/' + encodeURIComponent(event.leadgenId) + '?fields=created_time,field_data,form_id' } }));"), 880, 100),
    at(graph('Fetch lead from Meta'), 1100, 100),
    at(code('Map lead', `${source('normalize', 'meta', 'records')}

const events = $('Split leadgen events').all();
const demoMode = $env.DEMO_MODE === '1';
return $input.all().map((item, index) => {
  const event = events[index].json;
  const res = item.json;
  if (res.statusCode !== 200) {
    const inquiry = { source: 'meta_lead', source_id: 'meta:' + event.leadgenId, email: null };
    return { json: { read: false, runLog: { inquiry, action: 'lead_unreadable', alerts: [graphFailureAlert(event, res.statusCode, res.body)] } } };
  }
  const inquiry = normalizeMetaLead(res.body, { toE164 });
  return { json: { read: true, ...inquiry, validation: validateInquiry(inquiry, { demoOnly: demoMode }) } };
});`), 1320, 100),
    at(ifNode('Lead read?', '={{ $json.read }}', isTrue), 1540, 100),
    at(ifNode('Valid inquiry?', '={{ $json.validation.valid }}', isTrue), 1760, 0),
    at(callProcess('Process inquiry'), 1980, -80),
    at(code('Log rejected input', `${source('records')}

return $input.all().map((item) => ({ json: { runLog: { inquiry: item.json, action: 'rejected_input', alerts: [rejectedInputAlert(item.json, item.json.validation.reason)] } } }));`), 1980, 120),
    at(respond('Respond 401', { code: 401, body: 'Invalid signature' }), 660, 360),
    at(code('Log refused webhook', `${source('records')}

const reason = $('Check signature').first().json.reason;
return ${runLogShape("{ inquiry: { source: 'meta_lead', source_id: 'meta:refused-' + Date.now(), email: null }, action: 'refused_webhook', alerts: [signatureAlert(reason)] }")};`), 880, 360),
    ...runLogTail(2200, 360),
  ];
  return workflow('wfMetaLeadIntake', 'Lead intake: Facebook lead form', nodes, {
    'Meta verify': { main: [[edge('Check verify token')]] },
    'Check verify token': { main: [[edge('Respond to verify')]] },
    'Receive Meta lead': { main: [[edge('Check signature')]] },
    'Check signature': { main: [[edge('Signed by Meta?')]] },
    'Signed by Meta?': { main: [[edge('Respond 200')], [edge('Respond 401')]] },
    'Respond 200': { main: [[edge('Split leadgen events')]] },
    'Split leadgen events': { main: [[edge('Fetch lead from Meta')]] },
    'Fetch lead from Meta': { main: [[edge('Map lead')]] },
    'Map lead': { main: [[edge('Lead read?')]] },
    'Lead read?': { main: [[edge('Valid inquiry?')], [edge('Write run log')]] },
    'Valid inquiry?': { main: [[edge('Process inquiry')], [edge('Log rejected input')]] },
    'Log rejected input': { main: [[edge('Write run log')]] },
    'Respond 401': { main: [[edge('Log refused webhook')]] },
    'Log refused webhook': { main: [[edge('Write run log')]] },
    ...tailConnections,
  });
}

function reviewPageServer() {
  const nodes = [
    note('About', '## Review page\n`GET /webhook/review?id=…` serves the saved review page so the Slack link opens in the browser.', -80, -60, 700, 140, 7),
    at(webhook('Open review page', 'review', 'GET'), 0, 200),
    at(code('Load review page', `const fs = require('fs');
const id = String(($input.first().json.query || {}).id || '');
const file = '/files/output/review/' + id + '.html';
if (!/^[A-Za-z0-9._-]{1,80}$/.test(id) || !fs.existsSync(file)) return [{ json: { status: 404, html: '<!doctype html><meta charset="utf-8"><p>Review page not found.</p>' } }];
const meta = JSON.parse(fs.readFileSync('/files/output/review/' + id + '.json', 'utf8'));
const html = fs.readFileSync(file, 'utf8');
const banner = meta.status === 'pending' ? '' : '<p style="font:600 16px system-ui;background:#fff4d6;padding:.75rem;border-radius:6px;max-width:860px;margin:1rem auto">Already reviewed: ' + meta.status + '. Submitting again has no effect.</p>';
return [{ json: { status: 200, html: html.replace('<body>', '<body>' + banner) } }];`), 220, 200),
    at({ ...respond('Respond with page', { html: true, body: '={{ $json.html }}' }), parameters: { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: '={{ $json.status }}', responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } } }, 440, 200),
  ];
  return workflow('wfReviewPage', 'Lead intake: review page', nodes, {
    'Open review page': { main: [[edge('Load review page')]] },
    'Load review page': { main: [[edge('Respond with page')]] },
  });
}

function errorHandler() {
  const nodes = [
    note('About', '## Error handler\nAny failed node in the lead intake workflows posts a masked alert to Slack and keeps a local error log.', -80, -60, 900, 140, 1),
    at({ id: 'error-trigger', name: 'Error trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], parameters: {} }, 0, 200),
    at(code('Format alert', `${source('records')}

return [{ json: formatAlert($input.first().json) }];`), 220, 200),
    at(slack('Send alert', '$json.text'), 440, 200),
    at(code('Write error log', `const fs = require('fs');
const alert = $('Format alert').first().json;
fs.mkdirSync('/files/output/run-log', { recursive: true });
fs.appendFileSync('/files/output/run-log/errors.jsonl', JSON.stringify({ ts: new Date().toISOString(), ...alert }) + '\\n', 'utf8');
return [{ json: alert }];`), 660, 200),
  ];
  return workflow('wfErrorHandler', 'Lead intake: error handler', nodes, {
    'Error trigger': { main: [[edge('Format alert')]] },
    'Format alert': { main: [[edge('Send alert')]] },
    'Send alert': { main: [[edge('Write error log')]] },
  }, false);
}

function buildWorkflows(destination = outputDir) {
  const workflows = [formIntake(), emailIntake(), metaLeadIntake(), processInquiry(), reviewPageServer(), errorHandler()];
  mkdirSync(destination, { recursive: true });
  for (const item of workflows) writeFileSync(join(destination, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
  return workflows;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = buildWorkflows();
  console.log(`Wrote ${built.length} workflows: ${built.map((item) => item.id).join(', ')}`);
}
export { buildWorkflows };
