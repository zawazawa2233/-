#!/usr/bin/env python3
"""Shadow backtest using tradeable pre-deadline trifecta odds.

This is deliberately separate from the production predictors.  It imports the
experimental probability model from backtest-trifecta-ev.py, trains only on
older official archives, and evaluates tickets against odds captured before the
betting deadline.
"""

import argparse
import csv
import importlib.util
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np


def load_core(script_dir):
    path = script_dir / "backtest-trifecta-ev.py"
    spec = importlib.util.spec_from_file_location("trifecta_ev_core", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_csv_tree(root):
    rows = {}
    for path in sorted(root.glob("*.csv")):
        with path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                code = row.get("レースコード", "")
                if code:
                    rows[code] = row
    return rows


def race_key_to_code(key):
    day, place, race = key.split("-")
    return f"{day}{place}{race}"


def load_prerace_odds(root):
    rows = read_csv_tree(root)
    output = {}
    for code, row in rows.items():
        odds = {}
        for column, raw in row.items():
            if not column.startswith("3連単_"):
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if value > 0:
                odds[column.removeprefix("3連単_")] = value
        if len(odds) == 120:
            output[code] = {
                "odds": odds,
                "captured_at": row.get("取得日時"),
                "deadline": row.get("締切時刻"),
            }
    return output


def load_payouts(root):
    rows = read_csv_tree(root)
    output = {}
    for code, row in rows.items():
        winner = row.get("3連単_組番", "")
        try:
            payout = int(float(row.get("3連単_払戻金", "")))
        except (TypeError, ValueError):
            continue
        if winner and payout > 0:
            output[code] = {"winner": winner, "payout": payout}
    return output


def build_records(core, races, x, odds_rows, payout_rows, betas, temperatures):
    records = []
    for race, xr in zip(races, x):
        code = race_key_to_code(race["key"])
        odds_entry = odds_rows.get(code)
        payout_entry = payout_rows.get(code)
        if not odds_entry or not payout_entry:
            continue
        # Official archive and realtime payout must agree.  Disagreements can be
        # caused by special-result handling and are excluded rather than guessed.
        if race["combination"] != payout_entry["winner"]:
            continue
        model = core.combination_probabilities(xr, betas, temperatures)
        market = core.market_probabilities(odds_entry["odds"])
        records.append(
            {
                "key": race["key"],
                "date": race["hiduke"],
                "winner": payout_entry["winner"],
                "payout": payout_entry["payout"],
                "odds": odds_entry["odds"],
                "model": model,
                "market": market,
                "captured_at": odds_entry["captured_at"],
                "deadline": odds_entry["deadline"],
            }
        )
    return records


def logloss(core, records, alpha):
    return float(
        np.mean(
            [
                -math.log(
                    max(
                        core.blend_probabilities(row["model"], row["market"], alpha)[row["winner"]],
                        1e-12,
                    )
                )
                for row in records
            ]
        )
    )


def select_alpha(core, records):
    candidates = [round(value, 2) for value in np.linspace(0, 1, 21)]
    scores = {str(alpha): logloss(core, records, alpha) for alpha in candidates}
    selected = min(candidates, key=lambda alpha: scores[str(alpha)])
    return selected, scores


def evaluate_rule(core, records, alpha, threshold, cap):
    race_rows = []
    hit_details = []
    daily = defaultdict(lambda: [0, 0])
    for row in records:
        probabilities = core.blend_probabilities(row["model"], row["market"], alpha)
        candidates = [
            {
                "ticket": ticket,
                "probability": probability,
                "pre_odds": row["odds"][ticket],
                "ev": probability * row["odds"][ticket],
            }
            for ticket, probability in probabilities.items()
            if probability * row["odds"][ticket] >= threshold
        ]
        candidates.sort(key=lambda item: item["ev"], reverse=True)
        if cap:
            candidates = candidates[:cap]
        stake = len(candidates) * 100
        hit = next((item for item in candidates if item["ticket"] == row["winner"]), None)
        returned = row["payout"] if hit else 0
        race_rows.append((stake, returned))
        if stake:
            daily[row["date"]][0] += stake
            daily[row["date"]][1] += returned
        if hit:
            hit_details.append(
                {
                    "key": row["key"],
                    "winner": row["winner"],
                    "payout": row["payout"],
                    "pre_odds": hit["pre_odds"],
                    "estimated_ev": hit["ev"],
                    "tickets_in_race": len(candidates),
                }
            )

    stake = sum(item[0] for item in race_rows)
    returned = sum(item[1] for item in race_rows)
    largest = max((item["payout"] for item in hit_details), default=0)
    boot = []
    if stake:
        rng = np.random.default_rng(20260824 + int(threshold * 1000) + (cap or 99))
        values = np.asarray(race_rows, dtype=np.int64)
        for _ in range(5000):
            sample = values[rng.integers(0, len(values), len(values))]
            sampled_stake = int(sample[:, 0].sum())
            if sampled_stake:
                boot.append(float(sample[:, 1].sum() / sampled_stake * 100))
    return {
        "threshold": threshold,
        "cap": cap,
        "races_bet": sum(1 for item in race_rows if item[0]),
        "tickets": stake // 100,
        "hits": len(hit_details),
        "stake": stake,
        "return": returned,
        "roi": returned / stake * 100 if stake else None,
        "roi_without_largest_hit": (returned - largest) / stake * 100 if stake else None,
        "bootstrap_95": [float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))] if boot else None,
        "bootstrap_share_over_100": float(np.mean(np.asarray(boot) > 100.0)) if boot else None,
        "active_days": len(daily),
        "profitable_days": sum(1 for day_stake, day_return in daily.values() if day_return > day_stake),
        "largest_hit": max(hit_details, key=lambda item: item["payout"], default=None),
        "hit_details": hit_details,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-dir", type=Path, default=Path("/tmp/boatrace-ev-backtest/archives"))
    parser.add_argument("--snapshot-dir", type=Path, default=Path("/tmp/boatrace-prerace"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/prerace-trifecta-ev-20260822.json"))
    parser.add_argument("--development-end", default="20260805")
    args = parser.parse_args()

    core = load_core(Path(__file__).resolve().parent)
    train = core.load_dataset(args.archive_dir, "20250101", "20260630")
    calibration = core.load_dataset(args.archive_dir, "20260701", "20260718")
    evaluation = core.load_dataset(args.archive_dir, "20260719", "20260822")
    print(f"[dataset] train={len(train)} calibration={len(calibration)} evaluation={len(evaluation)}")

    x_train, y_train, mean, scale = core.make_arrays(train)
    x_cal, y_cal, _, _ = core.make_arrays(calibration, mean, scale)
    x_eval, _, _, _ = core.make_arrays(evaluation, mean, scale)
    betas = [core.fit_stage(x_train, y_train, stage) for stage in range(3)]
    temperatures = core.tune_temperatures(x_cal, y_cal, betas)

    odds_rows = load_prerace_odds(args.snapshot_dir / "od3")
    payout_rows = load_payouts(args.snapshot_dir / "payouts")
    records = build_records(core, evaluation, x_eval, odds_rows, payout_rows, betas, temperatures)
    development = [row for row in records if row["date"] <= args.development_end]
    holdout = [row for row in records if row["date"] > args.development_end]
    alpha, alpha_logloss = select_alpha(core, development)
    print(f"[split] joined={len(records)} development={len(development)} holdout={len(holdout)} alpha={alpha}")

    rules = [(threshold, cap) for threshold in (1.0, 1.05, 1.10, 1.15, 1.20) for cap in (1, 3, 5, None)]
    development_results = [evaluate_rule(core, development, alpha, threshold, cap) for threshold, cap in rules]
    holdout_results = [evaluate_rule(core, holdout, alpha, threshold, cap) for threshold, cap in rules]
    report = {
        "warning": "Research-only shadow test. Production model was not changed.",
        "train_period": ["20250101", "20260630"],
        "temperature_calibration_period": ["20260701", "20260718"],
        "pre_odds_period": ["20260719", "20260822"],
        "development_end": args.development_end,
        "holdout_start": holdout[0]["date"] if holdout else None,
        "counts": {
            "train": len(train),
            "temperature_calibration": len(calibration),
            "evaluation_archive": len(evaluation),
            "pre_odds_complete": len(odds_rows),
            "payouts": len(payout_rows),
            "joined": len(records),
            "development": len(development),
            "holdout": len(holdout),
        },
        "temperatures": temperatures,
        "selected_alpha": alpha,
        "development_alpha_logloss": alpha_logloss,
        "holdout_logloss": {
            "market": logloss(core, holdout, 0.0),
            "selected_blend": logloss(core, holdout, alpha),
            "model": logloss(core, holdout, 1.0),
        },
        "development_rules": development_results,
        "holdout_rules": holdout_results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"counts": report["counts"], "selected_alpha": alpha, "holdout_logloss": report["holdout_logloss"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
