# Setup

How to get from an empty machine to the T1 to T11 results. The commands are for PowerShell on Windows and work in bash with small changes.

## Requirements

- Docker Desktop
- Python 3.12 and Node.js 24 (standard library and built-ins only, nothing to install)
- A GoHighLevel sub-account where you can create a Private Integration. This was tested on a 14-day trial.
- For the Facebook lead form part: a Facebook account, a Page you manage, and a Meta developer account
- A tunnel tool that gives a public HTTPS URL for a local port (ngrok or `cloudflared`), only for the Facebook part
- A Gmail address used only for this demo, with 2-Step Verification on
- An OpenAI API key with credit (only needed for live mode; mock mode is free)
- A Slack workspace where you can add an incoming webhook

## 1. GoHighLevel

In the sub-account:

1. **Settings → Business Profile**: check that **Allow Duplicate Contact** is off. The workflow relies on GoHighLevel refusing a second contact with the same email or phone. Note the time zone; follow-up tasks are due at 10:00 in it.
2. **Settings → Private Integrations → Create new integration**. Name it `n8n Lead Intake` and give it these scopes: `contacts.readonly`, `contacts.write`, `opportunities.readonly`, `opportunities.write`, `locations.readonly`, `locations/customFields.readonly`, `locations/customFields.write`. Copy the token (it starts with `pit-` and is shown once).
3. Copy the **Location ID** (Business Profile, or the part after `/location/` in the URL).
4. **Opportunities → Pipelines → Add pipeline**: name it `Inquiries`, with stages `New – qualified`, `Needs review`, `Contacted`, `Won`, `Lost` in that order. The setup script finds the pipeline and stages by name.

## 2. Meta (Facebook lead forms)

Skip this section if you only want the form and email sources.

1. Create a Page for the demo business, or use a test Page you manage.
2. On developers.facebook.com: **My Apps → Create App**. Keep it in **Development mode**; as an app admin you can read your own Page's leads without App Review.
3. **Settings → Basic**: copy the App ID and App Secret.
4. Create an Instant Form on the Page (Meta Business Suite → **Instant Forms**). This demo uses `Tidewell – quote request` with Full name, Email, Phone number and one short-answer question, "What do you need cleaned, and how often?". Save it as a form only; no ad is needed.
5. **Graph API Explorer** (developers.facebook.com/tools/explorer): pick the app, keep **User Token**, add `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `leads_retrieval` and `pages_manage_ads`, and generate a token. It lasts about an hour, so do step 4 of section 4 right after.

## 3. `.env`

Copy `.env.example` to `.env` and fill it in. Never commit `.env`; it's in `.gitignore`.

| Variable | Where it comes from |
|---|---|
| `GHL_TOKEN` | The Private Integration token from section 1 |
| `GHL_LOCATION_ID` | The Location ID |
| `GHL_BASE_URL`, `META_GRAPH_URL` | Leave empty for the real APIs. For a run against the local mock: `http://mock:5690` |
| `META_APP_ID`, `META_APP_SECRET` | From the Meta app |
| `META_PAGE_ID` | The Page's ID (Page → About, or Graph API Explorer) |
| `META_USER_TOKEN` | The short-lived token from Graph API Explorer. `meta_setup.py token` turns it into `META_PAGE_TOKEN`; delete it afterwards |
| `META_PAGE_TOKEN` | Written by `meta_setup.py token` |
| `META_FORM_ID` | Shown by `meta_setup.py forms` |
| `META_VERIFY_TOKEN` | Any random string. Meta sends it back when it checks the webhook URL |
| `GMAIL_ADDRESS` | The demo inbox. Leave empty to run without the email source |
| `GMAIL_APP_PASSWORD` | https://myaccount.google.com/apppasswords (needs 2-Step Verification). Spaces are fine. |
| `SLACK_WEBHOOK_URL` | https://api.slack.com/apps → your app → Incoming Webhooks → add one for the alerts channel |
| `OPENAI_API_KEY` | https://platform.openai.com/api-keys. A restricted key with only Chat completions allowed is enough. |
| `OPENAI_MODEL` | `gpt-4.1-mini` was used for testing |
| `LLM_MODE` | `mock` (default) or `live` |
| `DEMO_MODE` | `1` keeps everything inside the demo: only `@example.com` / `@example.org` senders (or phone-only inquiries from the fictional 555-0100 to 555-0199 range) reach GoHighLevel, and approved replies go to `REPLY_REDIRECT_TO` |
| `REPLY_REDIRECT_TO` | Where approved replies go in demo mode, for example `yourdemo+replies@gmail.com` |
| `GENERIC_TIMEZONE` | n8n's own time zone, for example `America/Los_Angeles`. Task due dates use the GoHighLevel location's time zone, not this one |
| `N8N_ENCRYPTION_KEY` | Any long random string. Keep it: changing it later makes n8n unable to read its stored credentials. |
| `N8N_VERSION` | `2.44.7` |

## 4. Fields, pipeline ids and the Page token

```powershell
python scripts/ghl_setup.py --dry-run
python scripts/ghl_setup.py
```

This checks the location, creates the six contact fields listed in [FIELD-MAPPING.md](FIELD-MAPPING.md), finds the `Inquiries` pipeline and its stages, and writes all ids to `output/ghl-ids.json`. Running it again skips what already exists.

For the Facebook part:

```powershell
python scripts/meta_setup.py token   # META_USER_TOKEN → a Page token that doesn't expire, written to .env
python scripts/meta_setup.py forms   # lists the Page's forms and their question keys; copy the form id to META_FORM_ID
```

Nothing secret is printed.

## 5. Start n8n and import the workflows

```powershell
docker compose up -d
node n8n-src/build-workflows.mjs
python scripts/n8n_setup.py
```

`build-workflows.mjs` generates the six workflow files in `workflows/` from `n8n-src/code/*.js` and the prompts. `n8n_setup.py` imports the credentials (GoHighLevel, the Meta Page token, OpenAI, and Gmail IMAP and SMTP when `GMAIL_ADDRESS` is set) through a temp file that is deleted right after, imports the workflows, publishes them and restarts n8n. Give the webhooks a few seconds to register after the restart.

The editor runs at http://localhost:5681. Create the local owner account there the first time if you want to look at the workflows; the import doesn't need it. Port 5681 is used so this can run next to other n8n instances.

## 6. The Facebook webhook

Meta needs a public HTTPS URL. Don't point the tunnel at n8n itself: `scripts/meta_relay.py` listens on port 5691 and forwards only `/webhook/meta-leads`, so the editor and the review page stay private.

```powershell
python scripts/meta_relay.py      # keep it running
ngrok http 5691                   # or: cloudflared tunnel --url http://localhost:5691
python scripts/meta_setup.py subscribe --callback https://<your-tunnel-host>
```

`subscribe` points the app's webhook at the tunnel and subscribes the Page to `leadgen`. Meta calls the URL right away to check `META_VERIFY_TOKEN`, so the relay and tunnel have to be up first. A free tunnel URL changes every time it restarts; run `subscribe` again when it does.

In this project's tests, Meta checked the URL and accepted the subscription but never sent a lead notification to the development-mode app, from either the test lead API or the Lead Ads Testing Tool (see [VERIFICATION.md](VERIFICATION.md)). `send_fixtures.py --self-notify` covers that: after creating each test lead it sends the same signed event Meta would send, and n8n then reads the real lead from the Graph API. With a Live-mode app that receives Meta's webhooks, leave the flag off.

## 7. Run the tests

```powershell
python scripts/reset_demo.py            # dry run: lists what would be deleted
python scripts/reset_demo.py --apply    # deletes demo contacts with their notes, tasks and opportunities, clears output/
python scripts/send_fixtures.py --dry-run
python scripts/send_fixtures.py --self-notify   # T1–T11, one every 8 seconds
python scripts/send_fixtures.py --review        # T8 (and the rejects for T9 and T10): the review decisions
python scripts/collect_results.py       # writes output/results.md
python scripts/compare_results.py       # writes output/results-side-by-side.md
```

`reset_demo.py` only touches contacts with an `@example.com` / `@example.org` email (or no email and a 555-01xx phone). GoHighLevel's contact search shows deletions about 30 seconds late, so run the dry run again until it lists nothing before sending.

Meta keeps one test lead per form, so creating T10's lead deletes T9's. Wait for the drafts to appear before `--review`: a few seconds in mock mode, up to about a minute in live mode. `--review` reports any review page that isn't there yet.

To check idempotency, send the same batch again and compare:

```powershell
python scripts/send_fixtures.py --replay --self-notify
python scripts/collect_results.py --replay   # writes output/results-replay.md
```

Forms and emails are sent again as they were; Facebook leads are redelivered with the leadgen ids from the first batch, the way Meta retries. Every item should come back as `duplicate_submission`, and the number of demo contacts and opportunities should stay the same. T9's lead no longer exists on Meta's side by then, so the replay reports it as `lead_unreadable` instead.

## 8. Live mode

Run everything in mock mode first. To use OpenAI, set `LLM_MODE=live` in `.env`, recreate the container, and switch back afterwards:

```powershell
docker compose up -d --force-recreate n8n
docker compose exec -T n8n printenv LLM_MODE
# reset, send, review, collect as above
```

A full run makes about a dozen small OpenAI calls (six classifications, five drafts, and T7's call that is made to fail). The replay makes none.

## Running without GoHighLevel or Meta

`scripts/mock_platforms.mjs` fakes the GoHighLevel endpoints, the Graph lead read and a Slack webhook, so the whole flow can run before you have accounts. Set `GHL_BASE_URL` and `META_GRAPH_URL` to `http://mock:5690` and `SLACK_WEBHOOK_URL` to `http://mock:5690/__slack`, then:

```powershell
docker compose --profile mock up -d
python scripts/ghl_setup.py   # again after every mock restart; its data lives in memory
```

Without `GMAIL_ADDRESS`, add `--reject-all` to `--review` so no draft is ever sent. Mock results only show the plumbing works.

## Offline checks

```powershell
node --test "n8n-src/code/*.test.js" "n8n-src/*.test.mjs" "scripts/*.test.mjs"
python -m unittest discover tests_scripts
```

On Windows, pass the test files as a glob; giving `node --test` a folder fails.

## Troubleshooting

- **403 "Error 1010: Access denied" from GoHighLevel in a script:** Cloudflare in front of the API blocks some default User-Agents. The scripts send their own; if you write your own client, do the same.
- **401 `Invalid JWT` or 403 from GoHighLevel:** check `GHL_TOKEN` and that the Private Integration has the scopes in section 1.
- **`No pipeline named 'Inquiries'`:** create it as in section 1, step 4. Stage names have to match.
- **`GoHighLevel lookup ... failed` in Slack:** the lookup stops on any API error on purpose, so a broken search never looks like "no match".
- **Facebook lead never reaches n8n:** check that the relay and tunnel are running and that `meta_setup.py subscribe` succeeded with the current tunnel URL. The ngrok inspector at http://localhost:4040 shows every request that came in. See section 6 for development-mode apps.
- **401 on the Facebook webhook:** the signature didn't match. `META_APP_SECRET` in `.env` and in the running container have to be the same; recreate the container after changing it.
- **`could not be read from Meta` alert:** the Page token is wrong or expired, or the lead was deleted (a test lead is replaced when the next one is created). Run `meta_setup.py token` again with a fresh user token if the token is the problem.
- **429 `insufficient_quota` from OpenAI:** the account behind the key has no credit. Leads are still saved as Needs review with an alert.
- **Webhook 404 right after a restart:** wait a few seconds and retry.
- **Review page says "Review not accepted":** the reviewer name is empty or no decision was picked. Go back, fix it and submit again; nothing was sent.
- **Credential decryption error:** `N8N_ENCRYPTION_KEY` changed. Put the original back.
- **An email isn't picked up:** the trigger only reads unread mail in INBOX. In demo mode, senders outside `example.com` / `example.org` are skipped on purpose.
