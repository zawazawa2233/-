#!/usr/bin/env python3
"""Train Champion v1 once and save its immutable inference parameters."""

import argparse
import importlib.util
import json
from pathlib import Path


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-dir", type=Path, default=Path("/tmp/boatrace-ev-backtest/archives"))
    parser.add_argument("--snapshot-dir", type=Path, default=Path("/tmp/boatrace-prerace"))
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("experiments/trifecta-ev-shadow/champion-v1-model.json"),
    )
    args = parser.parse_args()
    script_dir = Path(__file__).resolve().parent
    core = load_module("trifecta_ev_core", script_dir / "backtest-trifecta-ev.py")
    helper = load_module("prerace_ev_helper", script_dir / "backtest-prerace-trifecta-ev.py")
    exhibition = load_module("exhibition_ev", script_dir / "backtest-prerace-exhibition-ev.py")

    train_raw = core.load_dataset(args.archive_dir, "20260501", "20260630")
    calibration_raw = core.load_dataset(args.archive_dir, "20260701", "20260718")
    train, x_train, y_train, mean, scale = exhibition.enriched_arrays(
        core, helper, train_raw, args.snapshot_dir
    )
    calibration, x_cal, y_cal, _, _ = exhibition.enriched_arrays(
        core, helper, calibration_raw, args.snapshot_dir, mean, scale
    )
    betas = [core.fit_stage(x_train, y_train, stage) for stage in range(3)]
    temperatures = core.tune_temperatures(x_cal, y_cal, betas)
    artifact = {
        "model_id": "trifecta-ev-shadow-champion-v1",
        "created_from_frozen_periods": {
            "train": ["20260501", "20260630"],
            "temperature_calibration": ["20260701", "20260718"],
            "train_races": len(train),
            "calibration_races": len(calibration),
        },
        "feature_count": int(x_train.shape[2]),
        "base_numeric_mean": mean.tolist(),
        "base_numeric_scale": scale.tolist(),
        "betas": [beta.tolist() for beta in betas],
        "temperatures": temperatures,
        "fixed_alpha": 0.30,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "feature_count": artifact["feature_count"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
