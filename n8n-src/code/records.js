// Slack texts and the run log; every number here comes from code, not the AI.

function maskSecrets(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '***')
    .replace(/\bpit-[A-Za-z0-9-]+/g, '***')
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, '***')
    .replace(/access_token=[^&\s"']+/g, 'access_token=***')
    .replace(/https:\/\/hooks\.slack\.com\/[^\s"']+/g, 'https://hooks.slack.com/***');
}

function formatAlert(payload = {}, baseUrl = 'http://localhost:5681') {
  const workflow = payload.workflow || {};
  const execution = payload.execution || {};
  const message = maskSecrets((execution.error && execution.error.message) || 'Unknown error');
  const url = `${baseUrl}/workflow/${workflow.id || ''}/executions/${execution.id || ''}`;
  return { text: `:rotating_light: Lead intake workflow error\nWorkflow: ${workflow.name || workflow.id || 'unknown'}\nNode: ${execution.lastNodeExecuted || 'unknown'}\nError: ${message}\n${url}`, url };
}

function rejectedInputAlert(inquiry, reason) {
  const who = inquiry.email || inquiry.phone || inquiry.name || 'unknown sender';
  return `:warning: Inquiry not accepted (${reason}) from ${who} via ${inquiry.source}. Nothing was written to GoHighLevel; please follow up by hand if needed.`;
}

function llmFailureAlert(inquiry, qualification, link) {
  return `:warning: AI classification failed for ${inquiry.email || inquiry.phone} (${qualification.llm_error}). The lead was saved in GoHighLevel as Needs review with no draft reply: ${link}`;
}

function reviewAlert(inquiry, qualification, reviewUrl) {
  return `:incoming_envelope: New lead: ${inquiry.name || inquiry.email} (${qualification.tier}, ${qualification.urgency} urgency) — review the draft reply: ${reviewUrl}`;
}

function signatureAlert(reason) {
  return `:no_entry: A request to the Facebook lead webhook was refused (${reason}). Nothing was written. If this repeats, check META_APP_SECRET and who is calling the webhook.`;
}

function buildRunLog({ inquiry, fixtureId = null, contactId = null, matchedBy = null, action, qualification = null, opportunityId = null, stage = null, taskId = null, draft = 'none', sentTo = null, reviewer = null, edited = null, alerts = [], executionId = null }) {
  return {
    ts: new Date().toISOString(),
    execution_id: executionId,
    source_id: inquiry.source_id,
    source: inquiry.source,
    fixture_id: fixtureId,
    email: inquiry.email,
    contact_id: contactId,
    matched_by: matchedBy,
    action,
    tier: qualification ? qualification.tier : null,
    llm_ok: qualification ? qualification.llm_ok : null,
    llm_error: qualification ? qualification.llm_error : null,
    opportunity_id: opportunityId,
    stage,
    task_id: taskId,
    draft,
    reviewer,
    edited,
    sent_to: sentTo,
    alerts: alerts.map(maskSecrets),
  };
}

if (typeof module !== 'undefined') module.exports = { maskSecrets, formatAlert, rejectedInputAlert, llmFailureAlert, reviewAlert, signatureAlert, buildRunLog };
