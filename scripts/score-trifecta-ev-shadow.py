#!/usr/bin/env python3
"""Score Champion v1 from public pre-deadline CSVs without retraining."""

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def as_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def load_races(helper, snapshot_dir, start, end):
    cards = helper.read_csv_tree(snapshot_dir / "race_cards")
    tkz = helper.read_csv_tree(snapshot_dir / "tkz")
    payouts = helper.load_payouts(snapshot_dir / "payouts")
    results = helper.read_csv_tree(snapshot_dir / "results")
    races = []
    for code, row in sorted(cards.items()):
        hiduke = code[:8]
        if hiduke < start or hiduke > end:
            continue
        payout = payouts.get(code)
        preview = tkz.get(code)
        result = results.get(code)
        if not payout or not preview or not result:
            continue
        result_combo = "-".join(str(result.get(f"{rank}着_艇番", "")) for rank in range(1, 4))
        if result_combo != payout["winner"]:
            continue
        boats = []
        valid = True
        for lane in range(1, 7):
            values = {
                "lane": lane,
                "racer": as_int(row.get(f"艇{lane}_登録番号")),
                "age": as_float(row.get(f"艇{lane}_年齢")),
                "weight": as_float(preview.get(f"艇{lane}_体重(kg)")),
                "class": row.get(f"艇{lane}_級別"),
                "national_win": as_float(row.get(f"艇{lane}_全国勝率")),
                "national_2": as_float(row.get(f"艇{lane}_全国2連対率")),
                "local_win": as_float(row.get(f"艇{lane}_当地勝率")),
                "local_2": as_float(row.get(f"艇{lane}_当地2連対率")),
                "motor_2": as_float(row.get(f"艇{lane}_モーター2連対率")),
                "boat_2": as_float(row.get(f"艇{lane}_ボート2連対率")),
            }
            if values["class"] not in ("A1", "A2", "B1", "B2") or any(
                values[key] is None
                for key in (
                    "racer",
                    "age",
                    "weight",
                    "national_win",
                    "national_2",
                    "local_win",
                    "local_2",
                    "motor_2",
                    "boat_2",
                )
            ):
                valid = False
                break
            boats.append(values)
        if not valid:
            continue
        races.append(
            {
                "key": f"{hiduke}-{int(code[8:10]):02d}-{int(code[10:12]):02d}",
                "hiduke": hiduke,
                "placeNo": int(code[8:10]),
                "raceNo": int(code[10:12]),
                "boats": boats,
                "combination": payout["winner"],
                "payout": payout["payout"],
            }
        )
    return races


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--through", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    script_dir = Path(__file__).resolve().parent
    core = load_module("trifecta_ev_core", script_dir / "backtest-trifecta-ev.py")
    helper = load_module("prerace_ev_helper", script_dir / "backtest-prerace-trifecta-ev.py")
    exhibition = load_module("exhibition_ev", script_dir / "backtest-prerace-exhibition-ev.py")
    model = json.loads(args.model.read_text(encoding="utf-8"))
    mean = np.asarray(model["base_numeric_mean"], dtype=np.float64)
    scale = np.asarray(model["base_numeric_scale"], dtype=np.float64)
    betas = [np.asarray(beta, dtype=np.float64) for beta in model["betas"]]
    temperatures = model["temperatures"]

    raw_races = load_races(helper, args.snapshot_dir, args.start, args.through)
    races, x, _, _, _ = exhibition.enriched_arrays(
        core, helper, raw_races, args.snapshot_dir, mean, scale
    )
    if x.shape[2] != model["feature_count"]:
        raise RuntimeError(f"Feature mismatch: {x.shape[2]} != {model['feature_count']}")
    odds_rows = helper.load_prerace_odds(args.snapshot_dir / "od3")
    payout_rows = helper.load_payouts(args.snapshot_dir / "payouts")
    records = helper.build_records(
        core, races, x, odds_rows, payout_rows, betas, temperatures
    )
    rule = helper.evaluate_rule(
        core, records, model["fixed_alpha"], threshold=1.10, cap=1
    )
    report = {
        "warning": "Shadow-only. No real-money betting.",
        "model_id": model["model_id"],
        "forward_period": [args.start, args.through],
        "counts": {"public_races": len(raw_races), "scored_races": len(records), "forward": len(records)},
        "fixed_alpha": model["fixed_alpha"],
        "forward_rules": [rule],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"counts": report["counts"], "rule": {key: rule[key] for key in ("tickets", "hits", "stake", "return", "roi")}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
