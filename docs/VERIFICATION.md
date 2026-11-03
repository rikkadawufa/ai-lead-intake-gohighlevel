# Verification log

Environment: local Docker n8n 2.44.7 (port 5681, compose project `lead-intake-ghl-demo`). Check IDs follow `SPEC.md` §9. Dates are Taiwan time.

## 9.1 Offline (2026-11-01)
| ID | Command | Result |
|---|---|---|
| O1 | `node --test "n8n-src/code/*.test.js" "n8n-src/*.test.mjs" "scripts/*.test.mjs"` | **PASS**: 61 tests (ghl.js, meta.js, review, records, llm, normalize, fixtures, workflow builder, mock platforms) |
| O2 | `python -m unittest discover tests_scripts` | **PASS**: 24 tests (client headers, retries, masking; setup creates only missing fields; reset deletes only demo contacts; results, replay, three-column table; Meta field mapping) |
| O3 | `node n8n-src/build-workflows.mjs` | **PASS**: 6 workflows, deterministic, no secrets, no HubSpot or Salesforce text |
| O4 | `python scripts/send_fixtures.py --dry-run` | **PASS**: lists T1–T11, no secrets |

## 9.2-M n8n against the local mocks (2026-11-01, before the trial)
Real n8n in Docker; GoHighLevel, the Graph lead endpoint and Slack were the local mock (`scripts/mock_platforms.mjs`). No Gmail in this round, so the email fixtures (T2, T4) were not sent and every draft was rejected (`--review --reject-all`): nothing could be emailed. Output kept in `output/archive-mock-1/`. **Mock results are not evidence for the portfolio.**

| ID | Result |
|---|---|
| setup | `ghl_setup.py` created the 6 fields and found the 5 stages; a second run created nothing |
| M1 (partial) | Sent T1, T3, T5, T6, T7, T9, T10, T11. Each one did what §9.4 expects for the parts this round could test: T1 new contact, Qualified, opportunity in `New – qualified`, follow-up task; T3 stopped as a repeat on T1's contact; T5 and T7 in `Needs review` (T7 with `llm_ok=false` and an alert); T6 400 + alert; T9 updated T1's contact (one Dana, one opportunity, one task, a second inquiry note); T10 new contact with source `Facebook lead form`, Qualified, task; T11 stopped as a repeat on T10's contact. The incomplete review returned 422. `collect_results.py` scored 4/8 + 2/3: every failure is a check on T2, T4 or an approved email, which this round didn't send |
| M2 | **PASS** for everything sent: replaying the batch gave `duplicate_submission` for all 7 accepted items, T6 still 400, contacts and opportunities unchanged (4 / 4) |
| M3 | **PASS**: a POST without `X-Hub-Signature-256` and one with a wrong signature both got 401, a Slack alert (`missing_signature` / `bad_signature`) and nothing written. A correctly signed event for a lead the Graph mock doesn't have got 200, then a Slack alert naming leadgen id 999999 and the Graph error, and nothing written. The subscribe handshake echoed the challenge with the right verify token and returned 403 with a wrong one |

Found and fixed during this round: the mock's Slack stand-in answered JSON where Slack answers plain text `ok`, which made n8n's HTTP node fail on every alert. Fixed in the mock; the workflows were unchanged.

### Round 2 (2026-11-01, full)
Same mock, now with the demo Gmail inbox (the same one as the HubSpot and Salesforce versions), so T2 and T4 came in by email and the T8 reviews ran as written: T1 edited and approved, T2 approved, T5, T9 and T10 rejected. Output kept in `output/archive-mock-2/`.

| ID | Result |
|---|---|
| M1 | **PASS 8/8 + 3/3**: T1 Qualified in `New – qualified` with a task, edited reply approved; T2 by email on the same contact and opportunity, no second task, approved unedited; T3 repeat; T4 Not qualified with no opportunity; T5 and T7 in `Needs review`; T6 400; T8 incomplete review 422 and exactly 2 replies in the demo inbox, one with the edited T1 text; T9 Dana's third inquiry note on the same contact (one Dana, one opportunity, one task); T10 new Facebook lead with a task; T11 repeat |
| M2 | **PASS**: the whole batch replayed (forms, the same two emails, the same two Facebook events) → every accepted item `duplicate_submission`, T6 still 400, still 5 contacts and 4 opportunities |


Note: the first M3 attempt returned 401 for a correctly signed event too. `.env` had just been given the real Meta app secret while the running container still had the mock one; after recreating the container it passed. The signature check did what it should.

## 9.2-G n8n against real GoHighLevel (2026-11-01, mock Graph, mock LLM)
GoHighLevel trial sub-account (opened 2026-11-01, Allow Duplicate Contact off, Inquiries pipeline created by hand). The Meta form wasn't ready yet, so the Graph lead read stayed on the local mock; Slack and the demo Gmail inbox were real. Output kept in `output/archive-ghl-1/`.

| ID | Result |
|---|---|
| setup | `ghl_setup.py` found the location (time zone America/Los_Angeles) and the 5 stages and created the 6 fields; a second run created nothing |
| M1 | **PASS 8/8 + 3/3**, same checks as the mock rounds, now read back from the GoHighLevel API: one Dana across form, email and Facebook lead (3 inquiry notes, 1 opportunity in `New – qualified`, 1 task); T4 Not qualified with no opportunity; T5 and T7 in `Needs review`; T6 400 + Slack alert; T7 Slack alert; exactly 2 replies in the demo inbox, one with the edited T1 text |
| M2 | **PASS**: the whole batch replayed → every accepted item `duplicate_submission`, T6 still 400, counts unchanged |

The account came with one sample contact (`jordan.smith@example.com`), so the script's counts read 6 contacts / 4 opportunities; the demo itself created 5 contacts.

Found and fixed during this round:
- The API sits behind Cloudflare, which answered 403 (error 1010) to Python's default `Python-urllib` User-Agent. The script client now sends its own User-Agent. n8n's HTTP node was not affected.
- The scripts decided "mock or real" for Meta from `GHL_BASE_URL`, so with real GoHighLevel they tried the real Meta form. Meta now has its own check on `META_GRAPH_URL`. T9–T11 were sent again after the fix, and the two send logs were merged into one (the partial one is kept as `.bak`).

## 9.2 n8n against real GoHighLevel and Meta (2026-11-01, mock LLM)
Real GoHighLevel, real Meta app (development mode), real Page and Instant Form `Tidewell – quote request`, never-expiring Page token (`leads_retrieval`, `pages_manage_metadata`). The webhook went through `meta_relay.py` and an ngrok tunnel (ngrok was already installed). Output kept in `output/archive-live-meta-1/`.

**Webhook delivery.** Meta verified the callback (the subscribe handshake reached n8n through the tunnel and was answered), and the app and Page subscriptions both show `leadgen`. Test leads were created on the real form, both with the test lead API and with the Lead Ads Testing Tool, but Meta never sent a leadgen POST: the Testing Tool stayed at "Pending" and the tunnel saw no POST in about 15 minutes. The Page isn't in a business portfolio, so Leads Access isn't the cause; the likely cause is that the app is in development mode. So this round used `send_fixtures.py --self-notify`: after creating each test lead, the script sends the same signed `leadgen` event Meta would send. n8n still checks the signature with the real app secret and reads the lead from the real Graph API. **What this round does not show: Meta itself delivering the webhook.**

| ID | Result |
|---|---|
| M1 | **PASS 8/8 + 3/3**: same checks as above; T9 and T10 were real leads on the real form (ids 982496851001864 and 2189178825370630), read from Graph by n8n. One Dana across form, email and Facebook lead; Elena new with a task; T11 redelivery stopped as a repeat. GoHighLevel held exactly the 5 demo contacts and 4 opportunities |
| M2 | **PASS 8/8, Facebook 2/3**: every form and email item and T10/T11 → `duplicate_submission`, counts unchanged (5 / 4). T9 → `lead_unreadable`: Meta keeps one test lead per form, so creating T10's lead deleted T9's, and the replayed event pointed at a lead that no longer existed. n8n wrote nothing and sent the Slack alert (Graph 400, "does not exist"). This is the M3 Graph-failure path, now on real Meta; it isn't an idempotency failure, but the replay row is reported as failed |

Found and fixed during this round:
- A qualified Facebook lead's run log is written only after review, so T11 and the review step couldn't find the leadgen id. The scripts now also read the ids they created from the send logs.
- A replay created new test leads (new ids), which would never look like a repeat. In a live replay the Facebook items now re-post the leadgen ids from the initial batch, as Meta does when it redelivers.

## 9.3 E2E (real OpenAI, 2026-11-01, live round 1)
Everything real: GoHighLevel, Meta (test leads on the real form, read from Graph; the leadgen event sent by the script as in 9.2), Gmail, Slack, and OpenAI `gpt-4.1-mini` (`LLM_MODE=live`, approved by the user beforehand, estimate under US$0.02). Every AI Reason in GoHighLevel was new text, not a stored mock answer. Output kept in `output/archive-live-1/`; the scored run is `results/ghl-live-round-1.json` and the three-CRM table is `results/results-side-by-side.md`.

| ID | Result |
|---|---|
| E1 | **PASS 8/8 + 3/3**: T1 Qualified (`New – qualified`, task, edited reply approved); T2 same contact and opportunity, no second task; T3 repeat; T4 Not qualified, no opportunity; T5 Needs review; T6 400 + alert; T7 forced OpenAI error → Needs review + alert; T8 422 then exactly 2 replies in the demo inbox; T9 one Dana (3 inquiry notes, 1 opportunity, 1 task); T10 Elena Qualified with a task; T11 repeat. GoHighLevel held the 5 demo contacts and 4 opportunities |
| E2 | **PASS 8/8, Facebook 2/3**: same as 9.2 M2. Everything replayed was a repeat with counts unchanged; T9's test lead had been replaced by T10's on Meta's side, so the replay read failed (`lead_unreadable`, alert, nothing written) |
| Side by side | T1–T8: HubSpot 8/8, Salesforce 8/8, GoHighLevel 8/8 |

The trial account also holds 4 sample contacts that came with it (2 without email, `alex.carter@businessmail.com`, `riley.bennett@corporate.net`); the demo didn't touch them. The demo data from this round is left in GoHighLevel for screenshots.

## Review page login (mock, 2026-11-04)
The review page (`GET /webhook/review`) and the form it posts to (the Wait node's resume URL) now both need the review login, an n8n basic-auth credential built from `REVIEW_USER` and `REVIEW_PASSWORD`. Offline checks after the change: 62 node tests and 24 Python tests pass, including a new builder test that both nodes use the credential.

Run against the local mocks with `LLM_MODE=mock`, no Gmail (so nothing could be sent) and the form fixtures only: `send_fixtures.py --only T1,T3,T5,T6,T7`, then `--review --reject-all`. Output kept in `output/archive-mock-auth-1/`.

| Check | Result |
|---|---|
| Intake unchanged | T1 created, T3 repeat, T5 created, T6 400, T7 created with no draft (forced AI error) |
| Review page without login | 401, with `WWW-Authenticate: Basic realm="Webhook"` |
| Review page with login | 200 |
| Form post without login | 401; the execution kept waiting |
| Form post with login, no name | 422 (as in T8) |
| Form post with login, complete | 200; T1 and T5 rejected by "Morgan Lee (Ops)", nothing sent |

By hand in a browser (mock, 2026-11-04, a fresh T1 review): opening the review link asked for the login; after signing in, the page showed, and submitting a reject with a reviewer name went through without asking for the login again (the page and the form are on different paths but answer with the same realm). The run log shows the draft rejected by the name typed and nothing sent. Output kept in `output/archive-mock-auth-2/`. The browser pane built into the Claude desktop app shows only "Authorization is required!" and no login box, so use a regular browser.

Not covered: a live run on GoHighLevel, and approving (this mock run had no Gmail, so only rejects were tried). After this change the live setup needs `REVIEW_USER` and `REVIEW_PASSWORD` in `.env` and a new `python scripts/n8n_setup.py`.
