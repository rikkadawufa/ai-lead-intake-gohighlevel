"""Put the HubSpot, Salesforce and GoHighLevel runs side by side for the same T1–T8 scenarios.

  python scripts/compare_results.py                      # reads output/results.json for the GoHighLevel column
  python scripts/compare_results.py --ghl results/ghl-live-round-1.json
Writes output/results-side-by-side.md. Pass/fail comes from each run's own checking script.
"""
import argparse
import json
from pathlib import Path

try:
    from .demo_common import OUTPUT, ROOT
except ImportError:
    from demo_common import OUTPUT, ROOT

REFERENCE = [("HubSpot", ROOT / "results" / "hubspot-live-round-2.json"), ("Salesforce", ROOT / "results" / "salesforce-live-round-1.json")]
CORE = [f"T{number}" for number in range(1, 9)]


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def cell(run, fixture_id):
    item = next((row for row in run["rows"] if row["id"] == fixture_id), None)
    return "not run" if item is None else ("PASS" if item["pass"] else "FAIL")


def score(run):
    rows = [row for row in run["rows"] if row["id"] in CORE]
    return f"{sum(row['pass'] for row in rows)} / {len(rows)}"


def render(runs, ghl_label):
    """runs: [(name, results dict)], GoHighLevel last."""
    titles = {row["id"]: row["title"] for _, run in runs for row in run["rows"]}
    header = []
    for name, run in runs:
        source = run.get("source", {})
        label = ghl_label if name == "GoHighLevel" else f"{source.get('run', 'reference run')}, {str(source.get('generated') or run.get('generated', ''))[:10]}"
        header.append(f"{name} ({label})")
    lines = [
        "# Same scenarios, three CRMs",
        "",
        "Same made-up inquiries, prompts, OpenAI model and review steps. Only the CRM step differs.",
        "",
        f"| # | Scenario | {' | '.join(header)} |",
        "|---|---|" + "---|" * len(runs),
        *[f"| {fixture_id} | {titles.get(fixture_id, '')} | {' | '.join(cell(run, fixture_id) for _, run in runs)} |" for fixture_id in CORE],
        "",
        "T1–T8: " + ", ".join(f"{name} {score(run)}" for name, run in runs) + ".",
        "",
        "Each column is scored by its own project's `collect_results.py` against that CRM and the demo inbox.",
        "Scenarios that only exist in one version (Salesforce T9: an existing Contact; GoHighLevel T9–T11: Facebook lead form) are reported in that version's own results.",
    ]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ghl", default=str(OUTPUT / "results.json"))
    parser.add_argument("--label", help="column label for the GoHighLevel run (default: its generated date)")
    args = parser.parse_args()
    ghl = load(args.ghl)
    label = args.label or f"run of {ghl.get('generated', 'unknown date')[:10]}"
    text = render([(name, load(path)) for name, path in REFERENCE] + [("GoHighLevel", ghl)], label)
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / "results-side-by-side.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
