# Same scenarios, three CRMs

Same made-up inquiries, prompts, OpenAI model and review steps. Only the CRM step differs.

| # | Scenario | HubSpot (live OpenAI round 2, 2026-10-29) | Salesforce (live OpenAI round 1, 2026-10-30) | GoHighLevel (live OpenAI round 1, 2026-11-01) |
|---|---|---|---|---|
| T1 | Qualified form inquiry | PASS | PASS | PASS |
| T2 | Same person follows up by email | PASS | PASS | PASS |
| T3 | Same form submission sent twice | PASS | PASS | PASS |
| T4 | Sales pitch by email | PASS | PASS | PASS |
| T5 | Vague price question | PASS | PASS | PASS |
| T6 | No email and no phone | PASS | PASS | PASS |
| T7 | OpenAI returns an error | PASS | PASS | PASS |
| T8 | Human review: edit + approve, approve, reject | PASS | PASS | PASS |

T1–T8: HubSpot 8 / 8, Salesforce 8 / 8, GoHighLevel 8 / 8.

Each column is scored by its own project's `collect_results.py` against that CRM and the demo inbox.
Scenarios that only exist in one version (Salesforce T9: an existing Contact; GoHighLevel T9–T11: Facebook lead form) are reported in that version's own results.
