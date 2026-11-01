# Implementation spec: AI Lead Intake → GoHighLevel (n8n + OpenAI + Meta lead ads)

> The reasoning behind this project lives in internal planning notes that are not part of this repo. This file is the spec to build from. It starts from the Salesforce version (`2026-10-30_n8n-lead-intake-salesforce/demo/docs/SPEC.md`) and only covers **what's different**, plus the full acceptance checklist. If the real API behaves differently, log it in `docs/VERIFICATION.md` and make the smallest change that keeps the original intent.
> Code, comments, README, commit messages, and every file under `docs/` are in English.

---

## 0. Prerequisites and the trial clock
- The GoHighLevel account is a **14-day trial**. Everything that doesn't need it (code, offline tests, a full n8n run against the local mocks in §7.3) is finished **before** the user opens the trial. The trial is opened only when §9.2-M passes.
- `demo/.env`: `GHL_TOKEN` (Private Integration Token), `GHL_LOCATION_ID`, `META_APP_ID`, `META_APP_SECRET`, `META_PAGE_ID`, `META_PAGE_TOKEN`, `META_VERIFY_TOKEN`, `META_FORM_ID`, plus `GMAIL_*`, `SLACK_WEBHOOK_URL`, `OPENAI_*`, `REPLY_REDIRECT_TO` as before. `GHL_BASE_URL` and `META_GRAPH_URL` default to the real APIs and point at the mocks when `MOCK_PLATFORMS=1`.
- Docker Desktop running; n8n at http://localhost:5681 (compose project `lead-intake-ghl-demo`, own volumes).
- Meta webhooks need a public HTTPS URL: a tunnel started only on live days (ngrok, already installed on the user's machine, was used; `cloudflared` works the same). The tunnel points at `scripts/meta_relay.py` (port 5691), which forwards only `/webhook/meta-leads` to n8n, so the editor and the review page are never public.

## 1. Hard rules
1. No package installs without the user's OK. Python standard library, Node built-ins.
2. Secrets are never printed, logged or committed; tokens in errors become `***`. Meta `access_token` query params are masked too.
3. No paid resources beyond the trial. No GHL add-ons, phone numbers, LC Email. No Meta ads.
4. No `git push`, no repo creation.
5. Development runs with `LLM_MODE=mock`. Live rounds only in §9.3, each with the user's OK, at most 3.
6. **GHL write scope:** only contacts whose email ends in `@example.com` / `@example.org` (or phone-only in 555-0100–0199), and the opportunities, notes and tasks under them. Reset deletes only those.
7. Outgoing email: with `DEMO_MODE=1`, everything goes to `REPLY_REDIRECT_TO` with `[demo → <original recipient>]` in the subject.
8. Meta: development-mode app, the user's own test Page, leads created only with Meta's test lead API or the Lead Ads Testing Tool.

## 2. File layout (differences from the Salesforce version)
- `scripts/ghl_client.py` replaces `salesforce_client.py`: bearer token + `Version: 2021-07-28` header, retries on 429/5xx with `Retry-After`, masking.
- `scripts/ghl_setup.py` replaces `salesforce_setup.py`: checks the location, creates missing custom fields, reads the `Inquiries` pipeline and its stage ids (the user creates the pipeline by hand; the API for creating pipelines isn't relied on), writes ids to `output/ghl-ids.json`.
- `scripts/meta_setup.py` (new): `token` exchanges a short-lived user token (`META_USER_TOKEN`) for a long-lived one and reads the non-expiring Page token into `.env`; `forms` lists the Page's lead forms and question keys; `subscribe` registers the app webhook (`POST /{app-id}/subscriptions`) and subscribes the Page to `leadgen` (`POST /{page-id}/subscribed_apps`).
- `scripts/meta_relay.py` (new): the only thing the tunnel reaches (§0).
- `scripts/mock_platforms.mjs` (new, Node built-ins): one local HTTP server that fakes the GHL endpoints in §4, the Graph lead endpoint in §3.2 and a Slack webhook, with in-memory state and a `/__state` dump. It runs as the compose service `mock` (profile `mock`) on the n8n image, so nothing extra is downloaded. Used in §9.2-M only. **Never shown as evidence.** Restarting it clears its state; run `ghl_setup.py` again after a restart.
- `n8n-src/code/ghl.js` replaces `match.js`; `meta.js` (new) handles signature check and Graph lead → inquiry.
- `workflows/wfMetaLeadIntake.json` (new, WF6).
- `results/salesforce-live-round-1.json` (copied from the Salesforce version) next to `hubspot-live-round-2.json`; `compare_results.py` makes three columns.

## 3. Data formats
### 3.1 Inquiry: same shape as before. New source value `meta_lead`; `source_id` = `meta:<leadgen_id>`.

### 3.2 Meta lead → inquiry (`meta.js`)
- Webhook `GET /webhook/meta-leads`: answer `hub.challenge` only when `hub.verify_token` matches `META_VERIFY_TOKEN`, else 403.
- Webhook `POST`: verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `META_APP_SECRET`); bad or missing signature → 401 + Slack alert, nothing written. Respond 200 fast, then process each `entry[].changes[]` with `field == "leadgen"`.
- Fetch `GET {graph}/v21.0/{leadgen_id}?fields=created_time,field_data,form_id,ad_id&access_token=<page token>`.
- `field_data` names map: `full_name` → name, `email`, `phone_number` → phone (E.164 via `normalize.js`), custom question `what_do_you_need_cleaned,_and_how_often?` (match by prefix `what_do_you_need`) → message. Unknown fields are appended to the message as `name: value` lines. Then it enters WF3 like any other inquiry.
- Graph fetch failure (expired token, 4xx/5xx) → Slack alert with the leadgen_id so nobody loses the lead; nothing written.

### 3.3 GHL custom fields (contact, created by `ghl_setup.py`, skipped if present)
| Name | Key | Type | Values |
|---|---|---|---|
| Lead Tier | `contact.lead_tier` | SINGLE_OPTIONS | `qualified` / `needs_review` / `not_qualified` |
| Inquiry Topic | `contact.inquiry_topic` | SINGLE_OPTIONS | same 7 as before |
| Inquiry Urgency | `contact.inquiry_urgency` | SINGLE_OPTIONS | `high` / `normal` / `low` |
| Inquiry Source | `contact.inquiry_source` | SINGLE_OPTIONS | `form` / `email` / `meta_lead` (latest) |
| AI Reason | `contact.ai_reason` | LARGE_TEXT | reason + `Quote: "…"` |
| Inquiry Source IDs | `contact.inquiry_source_ids` | LARGE_TEXT | newline-separated source ids |

Writes use custom field **ids** from `ghl-ids.json`. Contact `source` = `Website form` / `Email` / `Facebook lead form`; tag `ai-intake` on every contact the workflow touches.

### 3.4 Pipeline `Inquiries`
Stages (by name, ids resolved at setup): `New – qualified`, `Needs review`, `Contacted`, `Won`, `Lost`.
- qualified → open opportunity in `New – qualified` + follow-up task `Call <name> about <topic>` due next business day 10:00 location time.
- needs_review → open opportunity in `Needs review`, no task.
- not_qualified → no opportunity.
- One open opportunity per contact in this pipeline. A later inquiry moves it only upward (`Needs review` → `New – qualified`), never down, and never touches it once it's past those two stages.
- Opportunity name: `<name or email> – <topic>`.

## 4. Matching, dedup, idempotency (`ghl.js`)
1. Lookup: `GET /contacts/search/duplicate?locationId=…&email=…`; if none and there's a phone, again with `number=<E.164>`. A failed lookup throws (error workflow alerts) instead of counting as "no match".
2. Found contact whose `inquiry_source_ids` contains `source_id` → stop as `duplicate_submission`: no AI call, no note, no draft.
3. Found → `PUT /contacts/{id}`: fill identity fields only when empty, AI fields take latest, tier never downgraded, append source id. Not found → `POST /contacts/`.
4. Create rejected because the location blocks duplicates (the error body names the existing contact) → read that contact and take the update path. Built for the race with GHL's search; log if triggered.
5. Every inquiry adds a note (`POST /contacts/{id}/notes`): `Inquiry via <source> at <time>` + subject + original text + `AI: tier / topic / urgency — reason`.
6. Then opportunity per §3.4 (`GET /opportunities/search?location_id&contact_id&pipeline_id&status=open`, then create or `PUT`), then task.
7. Record link: `https://app.gohighlevel.com/v2/location/<loc>/contacts/detail/<id>`.
8. Measure in the first mock-vs-real check whether `/contacts/search/duplicate` sees a contact created seconds earlier. If it lags, record it and rely on step 4.
9. `POST /contacts/upsert` is tested once against the real API and compared; switch only if it gives the same results with fewer calls. Note the outcome either way.

## 5. LLM: identical to before (prompt, schema, `gpt-4.1-mini`, quote check, failure → needs_review, mock).

## 6. Human approval: same, wording `Open contact in GoHighLevel`; the decision is a note `AI reply approved by <reviewer>` / `rejected by` / `review timed out`, with sent subject and body.

## 7. n8n environment
### 7.1 Image `2.44.7`, port 5681, `WEBHOOK_URL` = the tunnel URL on live days, `http://localhost:5681/` otherwise.
### 7.2 Credentials (fixed ids, imported by `n8n_setup.py`): `ghlTokenCred01` (httpHeaderAuth `Authorization: Bearer …`), `openAiCred01`, `gmailImapCred01`, `gmailSmtpCred01`. Meta page token and app secret are env vars read only inside the Meta nodes.
### 7.3 Mock run: `docker compose --profile mock up -d` starts the mock; `.env` sets `GHL_BASE_URL` and `META_GRAPH_URL` to `http://mock:5690` (n8n reaches it inside Docker; host scripts translate that to `http://localhost:5690`) and `SLACK_WEBHOOK_URL` to `http://mock:5690/__slack`. Meta webhooks are posted by `send_fixtures.py` with a correctly signed body. Without `GMAIL_ADDRESS`, `n8n_setup.py` skips the Gmail credentials and the email intake, and `send_fixtures.py --review --reject-all` rejects every draft, so a mock run can't send email.

## 8. Workflows and scripts
### 8.1 Workflows (6)
- WF1 `wfFormIntake`, WF2 `wfEmailIntake`, WF4 `wfErrorHandler`, WF5 `wfReviewPage`: as before, wording and port changed.
- **WF6 `wfMetaLeadIntake`**: verify GET / signed POST → respond 200 → per leadgen: Graph fetch → map → call WF3.
- WF3 `wfProcessInquiry`: Start → GHL lookup (email, then phone) → duplicate? → qualify → create or update contact → note → opportunity → task → draft → review → send or not → decision note → run log.
- Run log: `{source_id, fixture_id, contact_id, matched_by, action, tier, opportunity_id, stage, task_id, llm_ok, llm_error, draft, reviewer, edited, sent_to, alerts[]}`.

### 8.2 Scripts
- `send_fixtures.py`: form → POST, email → SMTP to the demo inbox, `meta_lead` fixtures → in mock mode the lead is seeded into the mock Graph and announced with a signed webhook POST; in live mode it is created with Meta's test lead API (`POST /{form_id}/test_leads` with the fixture's `field_data` mapped to the form's question keys; Meta keeps one test lead per form, so the previous one is deleted first) and Meta should call the webhook itself. It didn't for this development-mode app (VERIFICATION §9.2), so `--self-notify` sends the signed event Meta would send right after creating the lead; n8n still reads the real lead from Graph. In a live replay the Facebook items re-post the leadgen ids from the first batch instead of creating new leads. T11 re-posts T10's event, signed with the app secret, using the leadgen id Meta assigned (read from the send log or the run log): that is what a Meta redelivery looks like, and it is described that way, not as Meta redelivering.
- `reset_demo.py`: dry run by default; `--apply` deletes demo contacts (their notes, tasks, opportunities go with them; opportunities are deleted explicitly first in case they don't) and clears local output.
- `collect_results.py`: run log + GHL + demo inbox → `output/results.md/json`. T1–T8 count toward "N / 8"; T9–T11 listed separately.
- `compare_results.py`: three columns HubSpot / Salesforce / GoHighLevel.

## 9. Acceptance checklist (`docs/VERIFICATION.md`, PASS / FAIL / NOT RUN)
### 9.1 Offline
- O1 `node --test` all pass, including `ghl.js` (lookup order, duplicate source id, fill-only-empty, no tier downgrade, stage only moves up, duplicate-create recovery, failed lookup throws) and `meta.js` (verify handshake, signature good/bad/missing, field mapping, unknown fields appended)
- O2 `python -m unittest discover tests_scripts` all pass (client retries and masking incl. `access_token`, setup creates only missing fields, reset deletes only demo domains, results, three-column table)
- O3 `build-workflows.mjs` → 6 JSON, identical across two runs, no secrets, no "HubSpot"/"Salesforce" text
- O4 `send_fixtures.py --dry-run` lists T1–T11, no secrets

### 9.2-M n8n against the local mocks (before the trial)
- M1 T1–T11 → `collect_results.py` against the mock state: T1–T8 8/8, T9–T11 PASS
- M2 resend everything → all `duplicate_submission`, T6 still 400
- M3 bad signature → 401 + alert; Graph error → alert with leadgen_id

### 9.2 n8n against real GHL and Meta (mock LLM)
- N1 `ghl_setup.py` creates 6 fields, finds 5 stages; second run changes nothing
- N2 `meta_setup.py` subscribes the Page; Meta's webhook verify succeeds through the tunnel
- N3 after reset, 0 demo contacts
- N4 T1–T11 → T1–T8 8/8, T9–T11 PASS (T9–T10 via Meta's test lead API; T11 as described in §8.2)
- N5 resend → all duplicate, contact and opportunity counts unchanged
- N6 search lag check (§4.8) and upsert comparison (§4.9) recorded

### 9.3 E2E (real OpenAI; ask the user before each round)
- E1 reset, T1–T11 live → record what comes out; don't change fixture expectations to match
- E2 three-column table
- E3 demo inbox has exactly 2 approved replies
- E4 user screenshots: contact list (only one Dana), Dana's contact (notes from form, email and Facebook), Opportunities board, Tasks, Lead Ads Testing Tool after creating a lead — **all before the trial is cancelled**

### 9.4 Expected results (`expect` in `fixtures.json`)
| # | Expected |
|---|---|
| T1 | created, qualified, opportunity in `New – qualified`, task, draft edited then approved |
| T2 | updated same contact, 2 notes, still qualified, same opportunity, no second task, approved unedited |
| T3 | duplicate_submission, T1 has 1 draft |
| T4 | created, not_qualified, no opportunity, no draft |
| T5 | created, needs_review, opportunity in `Needs review`, draft rejected, nothing sent |
| T6 | HTTP 400, Slack alert, nothing in GHL |
| T7 | created, needs_review, llm_ok=false, opportunity in `Needs review`, no draft, alert |
| T8 | incomplete review 422; T1 approved + edited; T2 approved unedited; T5 rejected; 2 emails |
| T9 | Dana via Facebook lead form → same contact as T1, third note, no new contact, same opportunity, no second task; draft created and rejected |
| T10 | new person via Facebook lead form → created, source `Facebook lead form`, qualified → `New – qualified` + task; draft rejected |
| T11 | T10's leadgen delivered again → duplicate_submission |

## 10. Documentation
- `README.md` (English, humanizer): what it does, diagram, what was tested, **not included** (WhatsApp, Instagram DMs, GHL workflows/AI bots, Marketplace OAuth app, multi-location), link to HubSpot and Salesforce versions, `## Running this for your own team`, License line (DESIGN.md §15.2).
- `docs/SETUP.md`: from scratch, including the Private Integration, pipeline, Meta app, tunnel.
- `docs/OPERATIONS.md`: change tier rules, add options (GHL and schema), add a source, read the run log, handle alerts, rotate the PIT and page token.
- `docs/FIELD-MAPPING.md`, `docs/VERIFICATION.md`.
