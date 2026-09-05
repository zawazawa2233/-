#!/usr/bin/env python3
"""Fetch public immutable inputs and audit frozen Champion v1 parameters."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


def run(command, env, cwd):
    print(f"[audit] {' '.join(str(value) for value in command)}")
    subprocess.run(command, cwd=cwd, env=env, check=True)


def main():
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--through",
        default=(datetime.now(ZoneInfo("Asia/Tokyo")) - timedelta(days=1)).strftime("%Y%m%d"),
        help="Last settled YYYYMMDD date to include; defaults to yesterday in JST.",
    )
    parser.add_argument("--snapshot-dir", type=Path, default=Path("/tmp/boatrace-prerace"))
    args = parser.parse_args()
    if not args.through.isdigit() or len(args.through) != 8:
        parser.error("--through must be YYYYMMDD")

    protocol_path = repo / "experiments/trifecta-ev-shadow/protocol-v1.json"
    protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
    for relative, expected in protocol["champion"]["operational_sha256"].items():
        actual = hashlib.sha256((repo / relative).read_bytes()).hexdigest()
        if actual != expected:
            parser.error(f"Champion v1 operational artifact changed: {relative}")
    start = protocol["forward_period"]["start"].replace("-", "")
    final = protocol["forward_period"]["end"].replace("-", "")
    if args.through < start:
        parser.error(f"Champion v1 starts at {start}; no forward audit exists yet")
    if args.through > final:
        parser.error(f"Champion v1 ends at {final}; use that date for the final audit")

    env = os.environ.copy()
    env.update(
        {
            "DATE_FROM": start,
            "DATE_TO": args.through,
            "SNAPSHOT_DIR": str(args.snapshot_dir),
        }
    )
    run(["node", "scripts/download-boatracecsv-snapshots.js"], env, repo)
    output = repo / f"artifacts/trifecta-ev-shadow-audit-{args.through}.json"
    run(
        [
            sys.executable,
            "scripts/score-trifecta-ev-shadow.py",
            "--snapshot-dir",
            str(args.snapshot_dir),
            "--model",
            "experiments/trifecta-ev-shadow/champion-v1-model.json",
            "--start",
            start,
            "--through",
            args.through,
            "--output",
            str(output),
        ],
        env,
        repo,
    )
    run([sys.executable, "scripts/compare-shadow-variants.py", "--snapshot-dir",
         str(args.snapshot_dir), "--report", str(output)], env, repo)
    report = json.loads(output.read_text(encoding="utf-8"))
    rule = next(
        item
        for item in report["forward_rules"]
        if item["threshold"] == protocol["champion"]["ticket_rule"]["minimum_estimated_ev"]
        and item["cap"] == protocol["champion"]["ticket_rule"]["maximum_tickets_per_race"]
    )
    print(
        json.dumps(
            {
                "protocol": protocol["protocol_id"],
                "through": args.through,
                "forward_races": report["counts"]["scored_races"],
                "tickets": rule["tickets"],
                "hits": rule["hits"],
                "roi": rule["roi"],
                "roi_without_largest_hit": rule["roi_without_largest_hit"],
                "bootstrap_95": rule["bootstrap_95"],
                "report": str(output),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
