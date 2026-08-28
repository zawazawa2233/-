#!/usr/bin/env python3
"""Score current S/A races and emit the frozen model's top trifecta.

This challenger does not settle results and does not modify Champion v1.  It
uses only race-card, exhibition and pre-deadline odds rows already published
for the target date.
"""

import argparse
import hashlib
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


def empty_report(hiduke, protocol_id, reason):
    return {
        "protocol_id": protocol_id,
        "hiduke": hiduke,
        "counts": {"race_cards": 0, "feature_ready": 0, "odds_ready": 0, "selected": 0},
        "selections": [],
        "note": reason,
    }


def load_current_races(helper, snapshot_dir, hiduke):
    cards = helper.read_csv_tree(snapshot_dir / "race_cards")
    previews = helper.read_csv_tree(snapshot_dir / "tkz")
    starts = helper.read_csv_tree(snapshot_dir / "stt")
    weather = helper.read_csv_tree(snapshot_dir / "sui")
    races = []
    for code, row in sorted(cards.items()):
        if code[:8] != hiduke:
            continue
        preview = previews.get(code)
        starts_row = starts.get(code)
        weather_row = weather.get(code)
        if not preview or not starts_row or not weather_row:
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
            required = (
                "racer", "age", "weight", "national_win", "national_2",
                "local_win", "local_2", "motor_2", "boat_2",
            )
            if values["class"] not in ("A1", "A2", "B1", "B2") or any(
                values[key] is None for key in required
            ):
                valid = False
                break
            boats.append(values)
        if not valid:
            continue
        exhibition_values = [
            as_float(preview.get(f"艇{lane}_{column}"))
            for lane in range(1, 7)
            for column in ("展示タイム", "体重(kg)", "体重調整(kg)", "チルト")
        ]
        start_values = [
            as_float(starts_row.get(f"艇{lane}_{column}"))
            for lane in range(1, 7)
            for column in ("コース", "スタート展示")
        ]
        weather_values = [
            as_float(weather_row.get(column))
            for column in ("風速(m)", "風向", "波の高さ(cm)")
        ]
        if any(value is None for value in exhibition_values + start_values + weather_values):
            continue
        courses = [as_int(starts_row.get(f"艇{lane}_コース")) for lane in range(1, 7)]
        if sorted(courses) != [1, 2, 3, 4, 5, 6]:
            continue
        races.append(
            {
                "key": f"{hiduke}-{int(code[8:10]):02d}-{int(code[10:12]):02d}",
                "hiduke": hiduke,
                "placeNo": int(code[8:10]),
                "raceNo": int(code[10:12]),
                "boats": boats,
                # enriched_arrays calls the shared array builder, whose target
                # is unused for live scoring but still requires this field.
                "combination": "1-2-3",
                "payout": 0,
            }
        )
    return races


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hiduke", required=True)
    parser.add_argument("--snapshot-dir", type=Path, default=Path(".shadow-one-pick-inputs"))
    parser.add_argument("--protocol", type=Path, default=Path("experiments/trifecta-one-pick-shadow/protocol-v1.json"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.hiduke.isdigit() or len(args.hiduke) != 8:
        parser.error("--hiduke must be YYYYMMDD")

    repo = Path(__file__).resolve().parent.parent
    protocol = json.loads((repo / args.protocol).read_text(encoding="utf-8"))
    model_path = repo / protocol["model"]["source"]
    actual_hash = hashlib.sha256(model_path.read_bytes()).hexdigest()
    if actual_hash != protocol["model"]["sha256"]:
        parser.error("Frozen model hash does not match the one-pick protocol")
    frozen = json.loads(model_path.read_text(encoding="utf-8"))

    script_dir = Path(__file__).resolve().parent
    core = load_module("one_pick_core", script_dir / "backtest-trifecta-ev.py")
    helper = load_module("one_pick_helper", script_dir / "backtest-prerace-trifecta-ev.py")
    exhibition = load_module("one_pick_exhibition", script_dir / "backtest-prerace-exhibition-ev.py")

    raw_races = load_current_races(helper, args.snapshot_dir, args.hiduke)
    if not raw_races:
        report = empty_report(args.hiduke, protocol["protocol_id"], "No current race cards with preview weights are available yet.")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False))
        return

    mean = np.asarray(frozen["base_numeric_mean"], dtype=np.float64)
    scale = np.asarray(frozen["base_numeric_scale"], dtype=np.float64)
    betas = [np.asarray(beta, dtype=np.float64) for beta in frozen["betas"]]
    races, features, _, _, _ = exhibition.enriched_arrays(
        core, helper, raw_races, args.snapshot_dir, mean, scale
    )
    odds_rows = helper.load_prerace_odds(args.snapshot_dir / "od3")
    s_minimum = protocol["race_grade"]["s_minimum"]
    a_minimum = protocol["race_grade"]["a_minimum"]
    selections = []
    odds_ready = 0
    for race, race_features in zip(races, features):
        code = helper.race_key_to_code(race["key"])
        odds_entry = odds_rows.get(code)
        if not odds_entry:
            continue
        odds_ready += 1
        odds = odds_entry["odds"]
        market = core.market_probabilities(odds)
        market_ranked = sorted(market, key=market.get, reverse=True)
        top7_mass = float(sum(market[ticket] for ticket in market_ranked[:7]))
        if top7_mass >= s_minimum:
            grade = "S"
        elif top7_mass >= a_minimum:
            grade = "A"
        else:
            continue
        model_probabilities = core.combination_probabilities(
            race_features, betas, frozen["temperatures"]
        )
        ticket = max(model_probabilities, key=model_probabilities.get)
        selections.append(
            {
                "race_code": code,
                "key": race["key"],
                "hiduke": race["hiduke"],
                "place_no": race["placeNo"],
                "race_no": race["raceNo"],
                "deadline": odds_entry.get("deadline"),
                "captured_at": odds_entry.get("captured_at"),
                "grade": grade,
                "grade_top7_market_mass": top7_mass,
                "ticket": ticket,
                "model_probability": float(model_probabilities[ticket]),
                "pre_odds": float(odds[ticket]),
                "market_probability": float(market[ticket]),
                "market_rank": market_ranked.index(ticket) + 1,
                "model_price_multiple": float(model_probabilities[ticket] * odds[ticket]),
            }
        )

    selections.sort(key=lambda row: ((row.get("deadline") or "99:99"), row["place_no"], row["race_no"]))
    report = {
        "protocol_id": protocol["protocol_id"],
        "hiduke": args.hiduke,
        "model_id": frozen["model_id"],
        "counts": {
            "race_cards": len(raw_races),
            "feature_ready": len(races),
            "odds_ready": odds_ready,
            "selected": len(selections),
        },
        "selections": selections,
        "warning": "Shadow only. No real-money purchase is performed.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"hiduke": args.hiduke, "counts": report["counts"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
