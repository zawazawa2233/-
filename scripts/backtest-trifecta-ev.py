#!/usr/bin/env python3
import argparse
import json
import math
import re
import subprocess
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np


CLASS_SCORE = {"B2": 0.0, "B1": 1.0, "A2": 2.0, "A1": 3.0}
BOAT_RE = re.compile(
    r"^([1-6])\s+(\d{4})(.*?)\s*(\d{2})(\S{2})(\d{2})(A1|A2|B1|B2)\s+"
    r"([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+"
    r"(\d+)\s+([0-9.]+)\s+(\d+)\s+([0-9.]+)"
)
PAYOUT_RE = re.compile(r"^\s*(\d{1,2})R\s+([1-6]-[1-6]-[1-6])\s+(\d+)\s")


def dates_between(start, end):
    cursor = datetime.strptime(start, "%Y%m%d")
    final = datetime.strptime(end, "%Y%m%d")
    while cursor <= final:
        yield cursor.strftime("%Y%m%d")
        cursor += timedelta(days=1)


def read_archive(filename, member):
    result = subprocess.run(
        ["bsdtar", "-xOf", str(filename), member],
        check=True,
        capture_output=True,
    )
    return result.stdout.decode("cp932", errors="replace")


def parse_program(text, hiduke):
    races = {}
    place_no = None
    race_no = None
    for raw in text.splitlines():
        marker = re.fullmatch(r"(\d{2})BBGN", raw.strip())
        if marker:
            place_no = int(marker.group(1))
            race_no = None
            continue
        line = unicodedata.normalize("NFKC", raw)
        header = re.match(r"^\s*(\d{1,2})R\s+", line)
        if header and place_no is not None:
            race_no = int(header.group(1))
            key = f"{hiduke}-{place_no:02d}-{race_no:02d}"
            races[key] = {"key": key, "hiduke": hiduke, "placeNo": place_no, "raceNo": race_no, "boats": []}
            continue
        if race_no is None or place_no is None:
            continue
        match = BOAT_RE.match(line)
        if not match:
            continue
        values = match.groups()
        boat = {
            "lane": int(values[0]),
            "racer": int(values[1]),
            "age": float(values[3]),
            "weight": float(values[5]),
            "class": values[6],
            "national_win": float(values[7]),
            "national_2": float(values[8]),
            "local_win": float(values[9]),
            "local_2": float(values[10]),
            "motor_2": float(values[12]),
            "boat_2": float(values[14]),
        }
        key = f"{hiduke}-{place_no:02d}-{race_no:02d}"
        if key in races:
            races[key]["boats"].append(boat)
    return races


def parse_results(text, hiduke):
    results = {}
    place_no = None
    for raw in text.splitlines():
        marker = re.fullmatch(r"(\d{2})KBGN", raw.strip())
        if marker:
            place_no = int(marker.group(1))
            continue
        if place_no is None:
            continue
        line = unicodedata.normalize("NFKC", raw)
        match = PAYOUT_RE.match(line)
        if not match:
            continue
        race_no = int(match.group(1))
        combination = match.group(2)
        payout = int(match.group(3))
        key = f"{hiduke}-{place_no:02d}-{race_no:02d}"
        results[key] = {"combination": combination, "payout": payout}
    return results


def load_dataset(archive_dir, start, end):
    output = []
    missing = 0
    for index, hiduke in enumerate(dates_between(start, end), start=1):
        short = hiduke[2:]
        bfile = archive_dir / "B" / f"b{short}.lzh"
        kfile = archive_dir / "K" / f"k{short}.lzh"
        if not bfile.exists() or not kfile.exists():
            missing += 1
            continue
        try:
            programs = parse_program(read_archive(bfile, f"B{short}.TXT"), hiduke)
            results = parse_results(read_archive(kfile, f"K{short}.TXT"), hiduke)
        except Exception:
            missing += 1
            continue
        for key, race in programs.items():
            result = results.get(key)
            if result and len(race["boats"]) == 6 and sorted(boat["lane"] for boat in race["boats"]) == [1, 2, 3, 4, 5, 6]:
                race["boats"].sort(key=lambda item: item["lane"])
                race.update(result)
                output.append(race)
        if index % 100 == 0:
            print(f"[parse] {index} days races={len(output)} missing_days={missing}")
    return output


def base_features(race, boat):
    lane = boat["lane"] - 1
    lane_onehot = [1.0 if lane == index else 0.0 for index in range(6)]
    place_lane = [0.0] * (24 * 6)
    if 1 <= race["placeNo"] <= 24:
        place_lane[(race["placeNo"] - 1) * 6 + lane] = 1.0
    numeric = [
        boat["national_win"], boat["national_2"], boat["local_win"], boat["local_2"],
        boat["motor_2"], boat["boat_2"], boat["age"], boat["weight"], CLASS_SCORE[boat["class"]]
    ]
    lane_interactions = []
    for value in numeric[:6]:
        lane_interactions.extend([value if lane == index else 0.0 for index in range(6)])
    race_lane = [(race["raceNo"] / 12.0) if lane == index else 0.0 for index in range(6)]
    return np.asarray(lane_onehot + numeric + lane_interactions + race_lane + place_lane, dtype=np.float32)


def make_arrays(races, mean=None, scale=None):
    x = np.stack([[base_features(race, boat) for boat in race["boats"]] for race in races]).astype(np.float32)
    numeric_slice = slice(6, 15)
    if mean is None:
        mean = x[:, :, numeric_slice].reshape(-1, 9).mean(axis=0)
        scale = x[:, :, numeric_slice].reshape(-1, 9).std(axis=0)
        scale[scale < 1e-6] = 1.0
    x[:, :, numeric_slice] = (x[:, :, numeric_slice] - mean) / scale
    targets = np.asarray([[int(part) - 1 for part in race["combination"].split("-")] for race in races], dtype=np.int64)
    return x, targets, mean, scale


def softmax_masked(scores, mask):
    adjusted = np.where(mask, scores, -1e9)
    adjusted -= adjusted.max(axis=1, keepdims=True)
    values = np.exp(adjusted)
    values *= mask
    return values / values.sum(axis=1, keepdims=True)


def fit_stage(x, targets, stage, epochs=12, batch_size=2048, learning_rate=0.025, l2=2e-4):
    rng = np.random.default_rng(20260823 + stage)
    beta = np.zeros(x.shape[2], dtype=np.float64)
    m = np.zeros_like(beta)
    v = np.zeros_like(beta)
    step = 0
    for epoch in range(epochs):
        order = rng.permutation(len(x))
        epoch_loss = 0.0
        for start in range(0, len(order), batch_size):
            idx = order[start:start + batch_size]
            xb = x[idx].astype(np.float64, copy=False)
            yb = targets[idx, stage]
            mask = np.ones((len(idx), 6), dtype=bool)
            for previous in range(stage):
                mask[np.arange(len(idx)), targets[idx, previous]] = False
            scores = np.einsum("nbf,f->nb", xb, beta)
            probs = softmax_masked(scores, mask)
            epoch_loss += -np.log(np.clip(probs[np.arange(len(idx)), yb], 1e-12, 1)).sum()
            diff = probs
            diff[np.arange(len(idx)), yb] -= 1.0
            grad = np.einsum("nb,nbf->f", diff, xb) / len(idx) + l2 * beta
            step += 1
            m = 0.9 * m + 0.1 * grad
            v = 0.999 * v + 0.001 * (grad * grad)
            mhat = m / (1 - 0.9 ** step)
            vhat = v / (1 - 0.999 ** step)
            beta -= learning_rate * mhat / (np.sqrt(vhat) + 1e-8)
        print(f"[fit] stage={stage + 1} epoch={epoch + 1} logloss={epoch_loss / len(x):.6f}")
    return beta


def stage_probabilities(x, betas, temperatures=(1.0, 1.0, 1.0)):
    return [np.einsum("nbf,f->nb", x.astype(np.float64, copy=False), beta) / temperature for beta, temperature in zip(betas, temperatures)]


def stage_logloss(scores, targets, stage, temperature):
    mask = np.ones((len(scores), 6), dtype=bool)
    for previous in range(stage):
        mask[np.arange(len(scores)), targets[:, previous]] = False
    probs = softmax_masked(scores / temperature, mask)
    return float(-np.log(np.clip(probs[np.arange(len(scores)), targets[:, stage]], 1e-12, 1)).mean())


def tune_temperatures(x, targets, betas):
    scores = [np.einsum("nbf,f->nb", x.astype(np.float64, copy=False), beta) for beta in betas]
    grid = np.linspace(0.55, 2.2, 67)
    temperatures = []
    for stage in range(3):
        best = min(grid, key=lambda value: stage_logloss(scores[stage], targets, stage, value))
        temperatures.append(float(best))
        print(f"[calibrate] stage={stage + 1} temperature={best:.3f} logloss={stage_logloss(scores[stage], targets, stage, best):.6f}")
    return temperatures


def all_combinations():
    return [(a, b, c) for a in range(6) for b in range(6) if b != a for c in range(6) if c not in (a, b)]


COMBINATIONS = all_combinations()


def combination_probabilities(x_race, betas, temperatures):
    scores = [x_race.astype(np.float64) @ beta / temperature for beta, temperature in zip(betas, temperatures)]
    p1 = np.exp(scores[0] - np.max(scores[0])); p1 /= p1.sum()
    output = {}
    for first in range(6):
        mask2 = np.ones(6, dtype=bool); mask2[first] = False
        p2 = softmax_masked(scores[1][None, :], mask2[None, :])[0]
        for second in range(6):
            if second == first: continue
            mask3 = np.ones(6, dtype=bool); mask3[[first, second]] = False
            p3 = softmax_masked(scores[2][None, :], mask3[None, :])[0]
            for third in range(6):
                if third in (first, second): continue
                output[f"{first + 1}-{second + 1}-{third + 1}"] = float(p1[first] * p2[second] * p3[third])
    return output


def market_probabilities(odds):
    inverse = {key: 1.0 / value for key, value in odds.items() if value and value > 0}
    total = sum(inverse.values())
    return {key: value / total for key, value in inverse.items()}


def blend_probabilities(model, market, alpha):
    raw = {key: (max(model[key], 1e-12) ** alpha) * (max(market[key], 1e-12) ** (1 - alpha)) for key in model if key in market}
    total = sum(raw.values())
    return {key: value / total for key, value in raw.items()}


def tune_blend(calibration, x_cal, odds_data, betas, temperatures):
    cached = []
    for race, xr in zip(calibration, x_cal):
        entry = odds_data.get(race["key"], {})
        odds = entry.get("odds", {}) if entry.get("status") in ("ok", "partial") else {}
        if len(odds) != 120: continue
        cached.append((race["combination"], combination_probabilities(xr, betas, temperatures), market_probabilities(odds)))
    if not cached:
        return 1.0
    candidates = np.linspace(0, 1, 21)
    losses = []
    for alpha in candidates:
        loss = np.mean([-math.log(max(blend_probabilities(model, market, alpha).get(winner, 1e-12), 1e-12)) for winner, model, market in cached])
        losses.append(loss)
    index = int(np.argmin(losses))
    print(f"[blend] races={len(cached)} alpha={candidates[index]:.2f} logloss={losses[index]:.6f} market={losses[0]:.6f} model={losses[-1]:.6f}")
    return float(candidates[index])


def evaluate(test, x_test, odds_data, betas, temperatures, alpha):
    records = []
    probability_rows = []
    for race, xr in zip(test, x_test):
        entry = odds_data.get(race["key"], {})
        odds = entry.get("odds", {}) if entry.get("status") in ("ok", "partial") else {}
        if len(odds) != 120: continue
        model = combination_probabilities(xr, betas, temperatures)
        market = market_probabilities(odds)
        probs = blend_probabilities(model, market, alpha)
        probability_rows.append({"winner_probability": probs[race["combination"]], "winner_market_probability": market[race["combination"]]})
        values = []
        for combo, probability in probs.items():
            values.append({"ticket": combo, "probability": probability, "odds": odds[combo], "ev": probability * odds[combo]})
        values.sort(key=lambda item: item["ev"], reverse=True)
        records.append({
            "key": race["key"], "winner": race["combination"], "payout": race["payout"],
            "tickets": values,
        })

    thresholds = [1.00, 1.05, 1.10, 1.15, 1.20, 1.30, 1.50]
    summaries = []
    for threshold in thresholds:
        bets = hits = payout = races_bet = 0
        daily = defaultdict(lambda: [0, 0])
        race_stakes = []
        race_payouts = []
        hit_details = []
        for record in records:
            selected = [item for item in record["tickets"] if item["ev"] >= threshold]
            race_stake = len(selected) * 100
            race_return = 0
            if not selected:
                race_stakes.append(0)
                race_payouts.append(0)
                continue
            races_bet += 1
            bets += len(selected)
            day = record["key"][:8]
            daily[day][0] += race_stake
            winners = [item for item in selected if item["ticket"] == record["winner"]]
            if winners:
                hits += 1
                payout += record["payout"]
                race_return = record["payout"]
                daily[day][1] += record["payout"]
                hit_details.append({
                    "key": record["key"], "winner": record["winner"], "payout": record["payout"],
                    "ticket_count": len(selected), "winner_ev": winners[0]["ev"],
                })
            race_stakes.append(race_stake)
            race_payouts.append(race_return)
        stake = bets * 100
        bootstrap_roi = []
        if stake and records:
            rng = np.random.default_rng(20260823 + int(threshold * 100))
            stakes_array = np.asarray(race_stakes)
            payouts_array = np.asarray(race_payouts)
            for _ in range(2000):
                sample = rng.integers(0, len(records), len(records))
                sampled_stake = stakes_array[sample].sum()
                if sampled_stake > 0:
                    bootstrap_roi.append(payouts_array[sample].sum() / sampled_stake * 100)
        summaries.append({
            "threshold": threshold, "races": races_bet, "tickets": bets, "hits": hits,
            "stake": stake, "payout": payout, "roi": payout / stake * 100 if stake else 0,
            "roi_bootstrap_95": [float(np.percentile(bootstrap_roi, 2.5)), float(np.percentile(bootstrap_roi, 97.5))] if bootstrap_roi else None,
            "roi_without_largest_hit": (payout - max((item["payout"] for item in hit_details), default=0)) / stake * 100 if stake else 0,
            "profitable_days": sum(1 for stake_day, payout_day in daily.values() if payout_day > stake_day),
            "active_days": len(daily),
            "hit_details": hit_details,
        })

    for cap in [1, 3, 5, 10]:
        threshold = 1.10
        bets = hits = payout = races_bet = 0
        race_stakes = []
        race_payouts = []
        hit_details = []
        for record in records:
            selected = [item for item in record["tickets"] if item["ev"] >= threshold][:cap]
            race_stake = len(selected) * 100
            race_return = 0
            if not selected:
                race_stakes.append(0); race_payouts.append(0)
                continue
            races_bet += 1; bets += len(selected)
            winners = [item for item in selected if item["ticket"] == record["winner"]]
            if winners:
                hits += 1; payout += record["payout"]; race_return = record["payout"]
                hit_details.append({"key": record["key"], "winner": record["winner"], "payout": record["payout"], "winner_ev": winners[0]["ev"]})
            race_stakes.append(race_stake); race_payouts.append(race_return)
        stake = bets * 100
        bootstrap_roi = []
        if stake and records:
            rng = np.random.default_rng(20260900 + cap)
            stakes_array = np.asarray(race_stakes); payouts_array = np.asarray(race_payouts)
            for _ in range(2000):
                sample = rng.integers(0, len(records), len(records))
                sampled_stake = stakes_array[sample].sum()
                if sampled_stake > 0:
                    bootstrap_roi.append(payouts_array[sample].sum() / sampled_stake * 100)
        summaries.append({
            "threshold": f"1.10_top{cap}", "races": races_bet, "tickets": bets, "hits": hits,
            "stake": stake, "payout": payout, "roi": payout / stake * 100 if stake else 0,
            "roi_bootstrap_95": [float(np.percentile(bootstrap_roi, 2.5)), float(np.percentile(bootstrap_roi, 97.5))] if bootstrap_roi else None,
            "roi_without_largest_hit": (payout - max((item["payout"] for item in hit_details), default=0)) / stake * 100 if stake else 0,
            "hit_details": hit_details,
        })

    model_logloss = float(np.mean([-math.log(max(row["winner_probability"], 1e-12)) for row in probability_rows]))
    market_logloss = float(np.mean([-math.log(max(row["winner_market_probability"], 1e-12)) for row in probability_rows]))
    top_candidates = sorted(
        (
            {
                "key": record["key"],
                "ticket": ticket["ticket"],
                "probability": ticket["probability"],
                "odds": ticket["odds"],
                "ev": ticket["ev"],
                "hit": ticket["ticket"] == record["winner"],
                "winner": record["winner"],
                "payout": record["payout"],
            }
            for record in records
            for ticket in record["tickets"][:3]
        ),
        key=lambda item: item["ev"],
        reverse=True,
    )[:20]
    return {
        "races_with_odds": len(records), "alpha": alpha, "model_logloss": model_logloss,
        "market_logloss": market_logloss, "summaries": summaries, "top_candidates": top_candidates,
    }


def write_race_list(races, filename):
    filename.parent.mkdir(parents=True, exist_ok=True)
    filename.write_text(json.dumps([{key: race[key] for key in ("key", "hiduke", "placeNo", "raceNo")} for race in races], ensure_ascii=False), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-dir", type=Path, default=Path("/tmp/boatrace-ev-backtest/archives"))
    parser.add_argument("--odds-file", type=Path, default=Path("/tmp/boatrace-ev-backtest/odds.json"))
    parser.add_argument("--race-list", type=Path, default=Path("/tmp/boatrace-ev-backtest/odds-races.json"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/trifecta-ev-backtest-20260822.json"))
    parser.add_argument("--prepare-odds", action="store_true")
    parser.add_argument("--odds-sample-cal", type=int, default=0)
    parser.add_argument("--odds-sample-test", type=int, default=0)
    args = parser.parse_args()

    train = load_dataset(args.archive_dir, "20250101", "20260630")
    calibration = load_dataset(args.archive_dir, "20260701", "20260722")
    test = load_dataset(args.archive_dir, "20260723", "20260822")
    print(f"[dataset] train={len(train)} calibration={len(calibration)} test={len(test)}")
    if args.prepare_odds:
        def evenly_sample(values, count):
            if count <= 0 or count >= len(values):
                return values
            return [values[index] for index in np.linspace(0, len(values) - 1, count, dtype=int)]

        selected = evenly_sample(calibration, args.odds_sample_cal) + evenly_sample(test, args.odds_sample_test)
        write_race_list(selected, args.race_list)
        print(f"[race-list] {args.race_list} races={len(selected)}")
        return

    x_train, y_train, mean, scale = make_arrays(train)
    x_cal, y_cal, _, _ = make_arrays(calibration, mean, scale)
    x_test, _, _, _ = make_arrays(test, mean, scale)
    betas = [fit_stage(x_train, y_train, stage) for stage in range(3)]
    temperatures = tune_temperatures(x_cal, y_cal, betas)
    odds_data = json.loads(args.odds_file.read_text(encoding="utf-8"))
    alpha = tune_blend(calibration, x_cal, odds_data, betas, temperatures)
    alpha_values = sorted(set([alpha, 0.25, 0.5, 0.75, 1.0]))
    calibration_evaluations = {f"{value:.2f}": evaluate(calibration, x_cal, odds_data, betas, temperatures, value) for value in alpha_values}
    evaluations = {f"{value:.2f}": evaluate(test, x_test, odds_data, betas, temperatures, value) for value in alpha_values}
    report = dict(evaluations[f"{alpha:.2f}"])
    report["calibration_blends"] = calibration_evaluations
    report["alternative_blends"] = evaluations
    report.update({
        "train_period": ["20250101", "20260630"], "calibration_period": ["20260701", "20260722"],
        "test_period": ["20260723", "20260822"], "train_races": len(train), "calibration_races": len(calibration),
        "test_races": len(test), "temperatures": temperatures,
    })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "records"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
