# Operations guide

For the team running this day to day. Most changes are a text edit followed by two commands:

```powershell
node n8n-src/build-workflows.mjs
python scripts/n8n_setup.py --skip-credentials
```

The first rebuilds the workflow files, the second imports and publishes them. Don't edit the workflows in the n8n editor if you plan to rebuild, because the rebuild overwrites them. Make the change in the source files instead.

## Daily use

1. A new lead posts to Slack: `New lead: <name> (<tier>, <urgency> urgency) — review the draft reply: <link>`.
2. Open the link. The page shows the original message, the AI's tier and reason, and a link to the contact in GoHighLevel.
3. Edit the draft if needed, pick **Approve and send** or **Reject, send nothing**, type your name and submit.
4. The decision is saved as a note on the contact ("AI reply approved by …"). Opening the link again shows "Already reviewed".

In GoHighLevel:

- **Opportunities → Inquiries**: Qualified leads land in `New – qualified` with a follow-up task due the next business day at 10:00. Leads the AI wasn't sure about land in `Needs review`. Move a card to `Contacted` once someone has talked to the person; the workflow leaves it alone from then on.
- **Contacts**: every contact the workflow touched has the tag `ai-intake`. Filter by the **Lead Tier** field to find Not qualified ones (pitches, job applications, home cleaning). They get no opportunity and no draft but are still saved.
- Each inquiry is a note on the contact (`Inquiry via Website form …`, `via Email`, `via Facebook lead form`) with the full message and the AI's reason.

Known gaps to watch for when reviewing:

- The draft only sees the current message, so on a follow-up it may ask for details the person already gave. Check the contact's earlier inquiry notes and edit the draft before approving.
- The draft can sound more certain than it should, for example "we can definitely arrange…". Take out promises about dates or prices before approving.

## Where inquiries go

- A contact with the same email gets the inquiry. If there's no email match, a contact with the same phone number does.
- Otherwise a new contact is created.
- The same person writing through the form, by email and through a Facebook lead form ends up on one contact with one open opportunity.

[FIELD-MAPPING.md](FIELD-MAPPING.md) lists every field the workflow writes and which ones it only fills when empty.

## Changing the sorting rules

The rules are plain English in [../prompts/qualify.md](../prompts/qualify.md), under **System**. For example, to accept residential work, move "home cleaning" out of the not_qualified line and describe when it counts as qualified. Rebuild and re-import afterwards.

The reply style lives in [../prompts/draft-reply.md](../prompts/draft-reply.md) the same way.

Test a rule change in mock mode first, then do one live run (see SETUP §8). In mock mode the AI answers come from `sample-data/mock-llm/`, so mock runs only test the plumbing, not the new wording.

## Running without AI

`LLM_MODE=off` keeps only the intake: each inquiry is still matched by email, then phone, repeats are still stopped, empty name, email and phone fields are still filled, and the message is still saved as a note. Nothing goes to OpenAI. Only Inquiry Source and Inquiry Source IDs are written; Lead Tier, Topic, Urgency and AI Reason are left as they are, the note has no AI line, and no opportunity, task, draft or AI alert is made. An OpenAI key isn't used in this mode. Recreate the container after changing it (`docker compose up -d --force-recreate n8n`).

## Sorting without reply drafts

`DRAFT_MODE=off` keeps the AI sorting and stops before the reply step: the AI fields, the note's AI line, the pipeline stage, the call task and the AI failure alert all work as usual, but no draft is written, no review page is made and Slack gets no review link, only the alerts. Leave `LLM_MODE` on `live` (or `mock`); with `LLM_MODE=off` there is nothing to draft anyway. Recreate the container after changing it (`docker compose up -d --force-recreate n8n`).

## Changing what each tier does in the pipeline

The tier-to-stage rules and the task wording are in `n8n-src/code/ghl.js` (`STAGES`, `planOpportunity`, `followUpTask`). To rename a stage, rename it in GoHighLevel, change the name in `STAGES` and in `scripts/ghl_setup.py`, run `ghl_setup.py` to refresh `output/ghl-ids.json`, then run the tests, rebuild and re-import. The workflows find stages by the ids in that file, so renaming in GoHighLevel alone breaks nothing until the next setup run.

## Adding a topic or tier value

Values have to match in three places:

1. The JSON schema enum in `prompts/qualify.md`
2. The `TOPICS` / `TIERS` / `URGENCIES` list in `n8n-src/code/llm.js`
3. The options of the custom field in GoHighLevel

`ghl_setup.py` only creates missing fields; it doesn't add options to existing ones, but it warns when an option is missing. Add the option in GoHighLevel → **Settings → Custom Fields** → the field, update the list in `scripts/ghl_setup.py` so a fresh sub-account gets it too, then run the unit tests, rebuild and re-import.

## Adding a new source

Any channel can feed the same flow. Turn the incoming message into the inquiry shape below, then call the **Lead intake: process inquiry** workflow with an *Execute Workflow* node, the way the form, email and Facebook workflows do.

```json
{
  "source": "form",
  "source_id": "form:<unique id from the channel>",
  "received_at": "2026-11-01T09:00:00.000Z",
  "name": "Dana Whitfield",
  "email": "dana@example.com",
  "phone": "+15105550142",
  "company": "Harborview Dental Group",
  "subject": "Website contact form",
  "message": "The message text",
  "demo_flags": { "break_llm": false }
}
```

- `source_id` must be unique and stable for the same message. That's what stops duplicates, so use the channel's own message ID rather than a timestamp.
- At least one of `email` or `phone` is required. Use `normalize.js` (`toE164`, `validateInquiry`) so phone numbers match existing contacts.
- Add the new source as an option on the **Inquiry Source** field, and a label for the contact's `source` in `SOURCE_LABEL` in `ghl.js`.

## Facebook lead forms

- **Another form on the same Page** works without changes as long as it asks for name, email or phone, and a free-text question whose key starts with `what_do_you_need`. Other questions are added to the message as `question: answer` lines. To use a different main question, change the prefix in `n8n-src/code/meta.js`.
- **Another Page:** run `meta_setup.py token` with a user token that has that Page, then `meta_setup.py subscribe`.
- **Lost leads:** if the Page token stops working, Slack gets `Facebook lead <id> … could not be read from Meta` for every new lead, with the lead id. Nothing is lost on Meta's side; the leads stay in Meta Business Suite → Leads Center. Fix the token, then enter those leads by hand or re-post their events.

## Reading the run log

Every inquiry writes one JSON file to `output/run-log/`:

| Field | Meaning |
|---|---|
| `action` | `created`, `updated`, `duplicate_submission`, `rejected_input`, `lead_unreadable` (a Facebook lead Meta couldn't return) or `refused_webhook` (bad signature) |
| `contact_id` | The GoHighLevel contact the inquiry went to |
| `matched_by` | `email`, `phone`, `duplicateRefused` (the create was refused and the named contact was updated), or empty for a new contact |
| `tier`, `llm_ok`, `llm_error` | The AI's result; `llm_ok: false` means the fallback was used |
| `opportunity_id`, `stage`, `task_id` | The open opportunity, its stage after this inquiry, and the follow-up task if one was added |
| `draft` | `none`, `approved`, `rejected` or `timeout` |
| `reviewer`, `edited`, `sent_to` | Who decided, whether they changed the draft, where it went |
| `alerts` | Slack messages sent for this inquiry |

For a qualified or needs-review lead the file is written after the review decision, so it can show up hours later. `errors.jsonl` in the same folder lists workflow failures caught by the error handler.

## Slack alerts

| Alert | What to do |
|---|---|
| `Inquiry not accepted (no_contact)` | The sender left no email or phone. Nothing was saved; follow up by hand if you can tell who it was. |
| `AI classification failed (...)` | The lead is in GoHighLevel as Needs review with no draft. Open it, decide the tier yourself and reply manually. `api_error_429` usually means the OpenAI account is out of credit. |
| `AI reply draft failed (...)` | The lead was classified, but there's no draft. Reply from GoHighLevel directly. |
| `Facebook lead … could not be read from Meta` | See "Lost leads" above. |
| `A request to the Facebook lead webhook was refused` | Someone posted to the webhook without a valid Meta signature. Once is noise; if it repeats, check `META_APP_SECRET`. |
| `Lead intake workflow error` | Something failed outside the expected paths, for example a GoHighLevel error during the lookup. The alert links to the failed n8n execution. |

## Rotating keys

1. Create the new secret and put it in `.env`:
   - GoHighLevel: a new Private Integration token (Settings → Private Integrations), with the same scopes
   - Meta: a new user token from Graph API Explorer, then `python scripts/meta_setup.py token`; a new app secret also needs the container recreated
   - OpenAI: a new key; Gmail: a new app password
2. `python scripts/n8n_setup.py` re-imports the credentials with the new values.
3. Revoke the old one once a test inquiry goes through.

Keep `N8N_ENCRYPTION_KEY` unchanged through all of this.

## Leaving demo mode

`DEMO_MODE=1` blocks every sender outside `example.com` / `example.org` (and phone-only inquiries outside the fictional 555-01xx range) and sends approved replies to `REPLY_REDIRECT_TO`. Before setting `DEMO_MODE=0` for real use, put n8n on a host the team can reach over HTTPS, set a strong `REVIEW_PASSWORD` (the review page and its form already ask for it), give the Private Integration only the scopes it needs, and run one live test with an address you own. For Facebook leads, confirm that Meta delivers the webhooks itself before relying on them. In these tests it didn't for the development-mode app (see [VERIFICATION.md](VERIFICATION.md)); putting the app in Live mode is the likely fix, and reading other businesses' Pages also needs Meta's App Review.
