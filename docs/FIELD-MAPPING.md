# Field mapping

How an inquiry from the website form, the inbox or a Facebook lead form lands in GoHighLevel. The code is in `n8n-src/code/ghl.js` (contact, note, opportunity and task bodies) and `n8n-src/code/meta.js` (Facebook lead → inquiry).

## 1. Inquiry fields

Every source is first turned into one shape (`n8n-src/code/normalize.js`).

| Inquiry field | From the form | From an email | From a Facebook lead form |
|---|---|---|---|
| `name` | `name` | Reply-To display name, else From | `full_name` |
| `email` | `email`, lowercased | Reply-To address, else From, lowercased | `email`, lowercased |
| `phone` | `phone`, converted to E.164 (`+1…` by default) | first phone number found in the body, E.164 | `phone_number`, E.164 |
| `company` | `company` | not set | `company_name`, if the form asks for it |
| `subject` | not set | email subject | not set |
| `message` | `message` | body without quoted replies or the signature | the answer to the question that starts with `what_do_you_need`; any other question the form asks is added below it as `question: answer` lines |
| `source` | `form` | `email` | `meta_lead` |
| `source_id` | `form:<submission_id>` | `email:<Message-ID>` | `meta:<leadgen_id>` |

A Facebook lead arrives as a webhook that only carries the `leadgen_id`. The workflow checks the `X-Hub-Signature-256` signature, then reads the lead's answers from the Graph API (`GET /v21.0/{leadgen_id}`) with the Page token.

## 2. Finding the contact

1. `GET /contacts/search/duplicate` with the email.
2. If nothing was found and there is a phone number, the same call with the phone number.

A failed lookup stops the run and alerts Slack instead of counting as "no match".

A found contact whose **Inquiry Source IDs** field already contains this `source_id` means the inquiry was handled before (a form sent twice, an email read again, a Facebook lead delivered again). The run stops as `duplicate_submission`: no AI call, no note, no draft.

Otherwise a found contact is updated, and no match creates a new contact. The sub-account has **Allow Duplicate Contact** turned off. If a create is refused because the contact already exists (the error names it), the workflow updates that contact instead. That path is built but wasn't triggered in the tests.

## 3. Contact fields

| GoHighLevel field | New contact | Existing contact |
|---|---|---|
| `firstName` | first word of `name` | filled only if empty |
| `lastName` | rest of `name` | filled only if empty |
| `email` | `email` | filled only if empty |
| `phone` | `phone` (E.164) | filled only if empty |
| `companyName` | `company` | filled only if empty |
| `source` | `Website form`, `Email` or `Facebook lead form` | not changed |
| `tags` | `ai-intake` | not changed (GoHighLevel's update call replaces the whole tag list, so tags are only sent on create) |
| Lead Tier | AI tier | AI tier, but a contact that is already `qualified` stays `qualified` |
| Inquiry Topic | AI topic | latest AI topic |
| Inquiry Urgency | AI urgency | latest AI urgency |
| Inquiry Source | `form`, `email` or `meta_lead` | latest source |
| AI Reason | AI reason plus the quoted sentence from the message | latest reason |
| Inquiry Source IDs | `source_id` | previous ids plus this one, one per line |

When the AI call fails, the tier is `needs_review`, the topic `other`, the urgency `normal`, and the reason says the classification failed.

## 4. Notes

| Note | Body |
|---|---|
| One per inquiry | `Inquiry via <source> at <received time>`, the email subject if there is one, the full message, `AI: <tier> / <topic> / <urgency> — <reason>`, and `Source id: <source_id>` |
| One per review decision | `AI reply approved by <name>` (whether the draft was edited, the date, where it was sent, and the subject and body that went out), `AI reply rejected by <name>` (nothing sent) or `AI reply review timed out` |

## 5. Opportunity and task

Pipeline **Inquiries**, stages `New – qualified`, `Needs review`, `Contacted`, `Won`, `Lost`.

| Tier | Opportunity | Follow-up task |
|---|---|---|
| `qualified` | open, in `New – qualified` | `Call <name> about <topic>`, due the next business day at 10:00 in the location's time zone |
| `needs_review` | open, in `Needs review` | none |
| `not_qualified` | none | none |

- One open opportunity per contact in this pipeline, named `<name or email> – <topic>`, source `AI lead intake`.
- A later inquiry only moves it up (`Needs review` → `New – qualified`, which also adds the task). It never moves it down, and never touches it once someone has moved it to `Contacted`, `Won` or `Lost`.
- The task is added only when the opportunity is created in, or moved up to, `New – qualified`. A second qualified inquiry from the same person doesn't add another task.

## 6. Custom fields created by `scripts/ghl_setup.py`

All on the contact. The script skips fields that already exist and writes their ids to `output/ghl-ids.json`, which the workflows read.

| Name | Type | Values |
|---|---|---|
| Lead Tier | Single option | `qualified`, `needs_review`, `not_qualified` |
| Inquiry Topic | Single option | `regular_cleaning`, `deep_cleaning`, `quote_request`, `complaint`, `job_application`, `sales_pitch`, `other` |
| Inquiry Urgency | Single option | `high`, `normal`, `low` |
| Inquiry Source | Single option | `form`, `email`, `meta_lead` |
| AI Reason | Multi-line text | |
| Inquiry Source IDs | Multi-line text | one source id per line |

The option values must match the enums in `prompts/qualify.md`. The pipeline isn't created by the script; create it by hand (see [SETUP.md](SETUP.md)) and the script reads its stage ids.
