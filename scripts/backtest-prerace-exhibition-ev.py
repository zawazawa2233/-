#!/usr/bin/env python3
"""Research-only EV test adding timestamped exhibition information.

No production predictor is imported or modified.  The model is trained and
evaluated chronologically, and all ticket settlement uses actual payouts.
"""

import argparse
import importlib.util
import json
import math
from pathlib import Path

import numpy as np


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def number(row, column):
    try:
        return float(row[column])
    except (KeyError, TypeError, ValueError):
        return None


def rank_scores(values, higher_is_better):
    order = sorted(range(6), key=lambda index: values[index], reverse=higher_is_better)
    scores = [0.0] * 6
    for rank, index in enumerate(order):
        scores[index] = (5 - rank) / 5.0
    return scores


def enriched_arrays(core, helper, races, snapshot_dir, mean=None, scale=None):
    tkz = helper.read_csv_tree(snapshot_dir / "tkz")
    stt = helper.read_csv_tree(snapshot_dir / "stt")
    sui = helper.read_csv_tree(snapshot_dir / "sui")
    kept = []
    extra_rows = []
    for race in races:
        code = helper.race_key_to_code(race["key"])
        tkz_row, stt_row, sui_row = tkz.get(code), stt.get(code), sui.get(code)
        if not tkz_row or not stt_row or not sui_row:
            continue
        exhibition = [number(tkz_row, f"艇{lane}_展示タイム") for lane in range(1, 7)]
        starts = [number(stt_row, f"艇{lane}_スタート展示") for lane in range(1, 7)]
        courses = [number(stt_row, f"艇{lane}_コース") for lane in range(1, 7)]
        weights = [number(tkz_row, f"艇{lane}_体重(kg)") for lane in range(1, 7)]
        adjustments = [number(tkz_row, f"艇{lane}_体重調整(kg)") for lane in range(1, 7)]
        tilts = [number(tkz_row, f"艇{lane}_チルト") for lane in range(1, 7)]
        wind = number(sui_row, "風速(m)")
        wind_direction = number(sui_row, "風向")
        wave = number(sui_row, "波の高さ(cm)")
        if any(value is None for values in (exhibition, starts, courses, weights, adjustments, tilts) for value in values):
            continue
        if wind is None or wind_direction is None or wave is None:
            continue
        if sorted(int(value) for value in courses) != [1, 2, 3, 4, 5, 6]:
            continue

        ex_mean = float(np.mean(exhibition))
        st_mean = float(np.mean(starts))
        weight_mean = float(np.mean(weights))
        ex_rank = rank_scores(exhibition, higher_is_better=False)
        st_rank = rank_scores(starts, higher_is_better=False)
        angle = 2 * math.pi * wind_direction / 16.0
        race_extra = []
        for index in range(6):
            lane = index + 1
            ex_relative = (ex_mean - exhibition[index]) * 10.0
            st_relative = (st_mean - starts[index]) * 10.0
            lane_mask = [1.0 if index == position else 0.0 for position in range(6)]
            course_onehot = [1.0 if int(courses[index]) == position else 0.0 for position in range(1, 7)]
            race_extra.append(
                np.asarray(
                    [
                        ex_relative,
                        st_relative,
                        ex_rank[index],
                        st_rank[index],
                        (weights[index] - weight_mean) / 5.0,
                        adjustments[index] / 2.0,
                        tilts[index],
                        (courses[index] - lane) / 5.0,
                    ]
                    + course_onehot
                    + [ex_relative * value for value in lane_mask]
                    + [st_relative * value for value in lane_mask]
                    + [(wind / 10.0) * value for value in lane_mask]
                    + [(wave / 20.0) * value for value in lane_mask]
                    + [math.sin(angle) * value for value in lane_mask]
                    + [math.cos(angle) * value for value in lane_mask],
                    dtype=np.float32,
                )
            )
        kept.append(race)
        extra_rows.append(race_extra)

    base, targets, mean, scale = core.make_arrays(kept, mean, scale)
    extra = np.asarray(extra_rows, dtype=np.float32)
    return kept, np.concatenate([base, extra], axis=2), targets, mean, scale


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-dir", type=Path, default=Path("/tmp/boatrace-ev-backtest/archives"))
    parser.add_argument("--snapshot-dir", type=Path, default=Path("/tmp/boatrace-prerace"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/prerace-exhibition-ev-20260822.json"))
    parser.add_argument("--development-end", default="20260805")
    parser.add_argument("--evaluation-end", default="20260822")
    parser.add_argument("--forward-start", default="20260825")
    parser.add_argument("--fixed-alpha", type=float, default=0.30)
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    core = load_module("trifecta_ev_core", script_dir / "backtest-trifecta-ev.py")
    helper = load_module("prerace_ev_helper", script_dir / "backtest-prerace-trifecta-ev.py")

    train_raw = core.load_dataset(args.archive_dir, "20260501", "20260630")
    calibration_raw = core.load_dataset(args.archive_dir, "20260701", "20260718")
    evaluation_raw = core.load_dataset(args.archive_dir, "20260719", args.evaluation_end)
    train, x_train, y_train, mean, scale = enriched_arrays(core, helper, train_raw, args.snapshot_dir)
    calibration, x_cal, y_cal, _, _ = enriched_arrays(core, helper, calibration_raw, args.snapshot_dir, mean, scale)
    evaluation, x_eval, _, _, _ = enriched_arrays(core, helper, evaluation_raw, args.snapshot_dir, mean, scale)
    print(
        f"[dataset] train={len(train)}/{len(train_raw)} "
        f"calibration={len(calibration)}/{len(calibration_raw)} "
        f"evaluation={len(evaluation)}/{len(evaluation_raw)} features={x_train.shape[2]}"
    )

    betas = [core.fit_stage(x_train, y_train, stage) for stage in range(3)]
    temperatures = core.tune_temperatures(x_cal, y_cal, betas)
    odds_rows = helper.load_prerace_odds(args.snapshot_dir / "od3")
    payout_rows = helper.load_payouts(args.snapshot_dir / "payouts")
    records = helper.build_records(core, evaluation, x_eval, odds_rows, payout_rows, betas, temperatures)
    development = [row for row in records if row["date"] <= args.development_end]
    holdout = [row for row in records if row["date"] > args.development_end]
    selected_alpha, alpha_logloss = helper.select_alpha(core, development)
    alpha = args.fixed_alpha
    forward = [row for row in records if row["date"] >= args.forward_start]
    rules = [(threshold, cap) for threshold in (1.0, 1.05, 1.10, 1.15, 1.20) for cap in (1, 3, 5, None)]
    development_results = [helper.evaluate_rule(core, development, alpha, threshold, cap) for threshold, cap in rules]
    holdout_results = [helper.evaluate_rule(core, holdout, alpha, threshold, cap) for threshold, cap in rules]
    full_results = [helper.evaluate_rule(core, records, alpha, threshold, cap) for threshold, cap in rules]
    forward_results = [helper.evaluate_rule(core, forward, alpha, threshold, cap) for threshold, cap in rules]
    report = {
        "warning": "Research-only exhibition shadow test. Production model was not changed.",
        "train_period": ["20260501", "20260630"],
        "temperature_calibration_period": ["20260701", "20260718"],
        "pre_odds_period": ["20260719", args.evaluation_end],
        "development_end": args.development_end,
        "forward_start": args.forward_start,
        "counts": {
            "train": len(train),
            "temperature_calibration": len(calibration),
            "evaluation": len(evaluation),
            "joined": len(records),
            "development": len(development),
            "holdout": len(holdout),
            "forward": len(forward),
        },
        "features": int(x_train.shape[2]),
        "temperatures": temperatures,
        "development_selected_alpha": selected_alpha,
        "fixed_alpha": alpha,
        "development_alpha_logloss": alpha_logloss,
        "holdout_logloss": {
            "market": helper.logloss(core, holdout, 0.0),
            "selected_blend": helper.logloss(core, holdout, alpha),
            "model": helper.logloss(core, holdout, 1.0),
        },
        "development_rules": development_results,
        "holdout_rules": holdout_results,
        "full_rules": full_results,
        "forward_rules": forward_results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"counts": report["counts"], "development_selected_alpha": selected_alpha, "fixed_alpha": alpha, "holdout_logloss": report["holdout_logloss"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
