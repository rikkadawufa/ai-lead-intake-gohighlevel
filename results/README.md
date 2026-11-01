# Live results

Each file is the output of a project's `scripts/collect_results.py` after a live OpenAI run: every scenario, PASS or FAIL, and what was read back from the CRM and the demo inbox. The demo inbox address is replaced with `<demo inbox>`.

| File | Version | Run | Result |
|---|---|---|---|
| `ghl-live-round-1.json` | GoHighLevel (this repo) | live OpenAI, 2026-11-01 | T1–T8 8/8, Facebook lead form T9–T11 3/3 |
| `hubspot-live-round-2.json` | [HubSpot](https://github.com/rikkadawufa/ai-lead-intake-hubspot) | live OpenAI, 2026-10-29 | T1–T8 8/8 |
| `salesforce-live-round-1.json` | [Salesforce](https://github.com/rikkadawufa/ai-lead-intake-salesforce) | live OpenAI, 2026-10-30 | T1–T8 8/8 |
| `results-side-by-side.md` | all three | built by `scripts/compare_results.py` | T1–T8 side by side |

The GoHighLevel run passed on its first live attempt. Sending the same batch a second time (the replay check) created no new contacts, opportunities or drafts, but scored Facebook 2/3: Meta keeps one test lead per form, so T9's lead had been replaced by T10's and could no longer be read. The workflow wrote nothing for it and posted a Slack alert. [docs/VERIFICATION.md](../docs/VERIFICATION.md) has every round, mock runs included.
