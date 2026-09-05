#!/usr/bin/env python3
"""Registered shadow comparisons; historical exploration is not forward evidence."""
import argparse
import importlib.util
import json
from pathlib import Path

START = "20260906"
VARIANTS = [
    {"id": "baseline", "label": "現行 EV1.10", "ev": 1.10},
    {"id": "ev120", "label": "EV1.20以上", "ev": 1.20},
    {"id": "ev130", "label": "EV1.30以上", "ev": 1.30},
    {"id": "prob001", "label": "推定的中率1%以上", "ev": 1.10, "prob": 0.01},
    {"id": "odds100", "label": "100倍以下", "ev": 1.10, "max_odds": 100},
]


def summarize(rows, variant):
    # Filter the original top-EV ticket; do not replace it with a different ticket.
    selected = [r for r in rows if r["estimated_ev"] >= variant["ev"]
                and r["probability"] >= variant.get("prob", 0)
                and r["pre_odds"] <= variant.get("max_odds", float("inf"))]
    stake = len(selected) * 100
    returned = sum(r["return"] for r in selected)
    hits = [r for r in selected if r["hit"]]
    streak = longest = equity = peak = drawdown = 0
    for r in selected:
        streak = 0 if r["hit"] else streak + 1
        longest = max(longest, streak)
        equity += r["return"] - 100
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return {**variant, "tickets": len(selected), "skipped": len(rows)-len(selected),
            "hits": len(hits), "stake": stake, "return": returned,
            "roi": returned / stake * 100 if stake else None,
            "max_losing_streak": longest, "max_drawdown_yen": drawdown,
            "roi_without_largest_hit": (returned-max((r["return"] for r in hits), default=0))/stake*100 if stake else None,
            "hit_details": hits,
            "mean_hit_payout_to_pre_odds": sum(r["payout_to_pre_odds"] for r in hits)/len(hits) if hits else None}


def compare(rows):
    rows = sorted(rows, key=lambda r: (r["date"], r.get("deadline") or "99:99", r["key"]))
    forward = [r for r in rows if r["date"] >= START]
    historical = [r for r in rows if r["date"] < START]
    return {"version": "shadow-comparison-v1", "registered_on": "20260905",
            "forward_start": START, "review_after": "20261006",
            "policy": "No automatic promotion. Historical results are exploratory. Each variant uses 100 yen per ticket. Losing streaks use scheduled deadline order, not actual finish order. Payout/pre-odds ratios exist only for hits and are not all-ticket final odds movement.",
            "forward": [summarize(forward, v) for v in VARIANTS],
            "historical_exploratory": [summarize(historical, v) for v in VARIANTS],
            "ticket_ledger": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("frozen_shadow", root / "score-trifecta-ev-shadow.py")
    scorer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scorer)
    import numpy as np
    core = scorer.load_module("comparison_core", root / "backtest-trifecta-ev.py")
    helper = scorer.load_module("comparison_helper", root / "backtest-prerace-trifecta-ev.py")
    exhibition = scorer.load_module("comparison_exhibition", root / "backtest-prerace-exhibition-ev.py")
    model = json.loads((root.parent / "experiments/trifecta-ev-shadow/champion-v1-model.json").read_text())
    report = json.loads(args.report.read_text())
    start, end = report["forward_period"]
    raw = scorer.load_races(helper, args.snapshot_dir, start, end)
    races, x, _, _, _ = exhibition.enriched_arrays(core, helper, raw, args.snapshot_dir,
        np.asarray(model["base_numeric_mean"]), np.asarray(model["base_numeric_scale"]))
    records = helper.build_records(core, races, x,
        helper.load_prerace_odds(args.snapshot_dir / "od3"), helper.load_payouts(args.snapshot_dir / "payouts"),
        [np.asarray(b) for b in model["betas"]], model["temperatures"])
    ledger = []
    for r in records:
        probabilities = core.blend_probabilities(r["model"], r["market"], model["fixed_alpha"])
        ticket = max(probabilities, key=lambda t: probabilities[t] * r["odds"][t])
        odds, probability = r["odds"][ticket], probabilities[ticket]
        ev = probability * odds
        if ev < 1.10:
            continue
        hit = ticket == r["winner"]
        ledger.append({"key": r["key"], "date": r["date"], "ticket": ticket,
            "pre_odds": odds, "probability": probability, "estimated_ev": ev,
            "captured_at": r["captured_at"], "deadline": r["deadline"],
            "winner": r["winner"], "hit": hit, "return": r["payout"] if hit else 0,
            "payout_to_pre_odds": r["payout"] / 100 / odds if hit else None})
    baseline = summarize(ledger, VARIANTS[0])
    champion = next(r for r in report["forward_rules"] if r["threshold"] == 1.10 and r["cap"] == 1)
    for key in ("tickets", "hits", "stake", "return"):
        if baseline[key] != champion[key]:
            raise RuntimeError(f"Baseline mismatch: {key}")
    report["comparison"] = compare(ledger)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"comparison_start": START, "ledger_tickets": len(ledger), "baseline_verified": True}))


if __name__ == "__main__":
    main()
