#!/usr/bin/env python3
"""Offline OnePick regression fixtures; never sends or uses production state.

Run with Python 3.12 + numpy and Node 24 + bsdtar on PATH, or set
ONE_PICK_NODE to the Node executable. ONE_PICK_TEST_OUTPUT optionally keeps
all synthetic fixtures, stdout/stderr and reports for review.
"""

import csv
import hashlib
import io
import itertools
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
MOCK = REPO / "tests/fixtures/one-pick-network.mjs"
HIDUKE = "20261002"
CODE = HIDUKE + "0101"
NODE = os.environ.get("ONE_PICK_NODE") or shutil.which("node")
BSDTAR = shutil.which("bsdtar")


def csv_bytes(row):
    text = io.StringIO(newline="")
    writer = csv.DictWriter(text, fieldnames=list(row))
    writer.writeheader()
    writer.writerow(row)
    return text.getvalue().encode("utf-8-sig")


def lha_bytes(member, payload):
    # Synthetic level-0 -lh0- archive, including the real payload CRC16.
    # Header reference: https://github.com/jca02266/lha/blob/master/header.doc.md
    crc = 0
    for byte in payload:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    name = member.encode("ascii")
    dos_date_time = ((2026 - 1980) << 25) | (10 << 21) | (2 << 16)
    body = (
        b"-lh0-" + struct.pack("<III", len(payload), len(payload), dos_date_time)
        + b"\x20\x00" + bytes([len(name)]) + name + struct.pack("<H", crc)
    )
    return bytes([len(body), sum(body) & 0xFF]) + body + payload + b"\x00"


def write_inputs(folder, live=False, exhibition=True, archive=True, corrupt=False):
    card = {"レースコード": CODE}
    tkz = {"レースコード": CODE}
    stt = {"レースコード": CODE}
    program = ["01BBGN", "1R テストレース"]
    for lane in range(1, 7):
        card.update({
            f"艇{lane}_登録番号": 4000 + lane,
            f"艇{lane}_年齢": 30,
            f"艇{lane}_級別": "A1",
            f"艇{lane}_全国勝率": 7.1,
            f"艇{lane}_全国2連対率": 50.0,
            f"艇{lane}_当地勝率": 6.5,
            f"艇{lane}_当地2連対率": 45.0,
            f"艇{lane}_モーター2連対率": 40.0,
            f"艇{lane}_ボート2連対率": 35.0,
        })
        tkz.update({
            f"艇{lane}_展示タイム": 6.7 + lane / 100,
            f"艇{lane}_体重(kg)": 52.0,
            f"艇{lane}_体重調整(kg)": 0.0,
            f"艇{lane}_チルト": 0.0,
        })
        stt.update({f"艇{lane}_コース": lane, f"艇{lane}_スタート展示": 0.1 + lane / 100})
        program.append(f"{lane} {4000 + lane} テスト{lane} 30東京52A1 7.10 50.0 6.50 45.0 10 40.0 20 35.0")
    sui = {"レースコード": CODE, "風速(m)": 2, "風向": 8, "波の高さ(cm)": 1,
           "注記": "合成fixture。実レース・通知原本ではありません。"}
    odds = {"レースコード": CODE, "取得日時": "2026-10-02T09:55:00+09:00", "締切時刻": "10:00"}
    for index, combo in enumerate(itertools.permutations(range(1, 7), 3)):
        odds["3連単_" + "-".join(map(str, combo))] = 5.0 if index < 7 else 1000.0
    if live:
        (folder / "race_cards.csv").write_bytes(csv_bytes(card))
    if exhibition:
        for name, row in [("tkz", tkz), ("stt", stt), ("sui", sui), ("od3", odds)]:
            (folder / f"{name}.csv").write_bytes(csv_bytes(row))
    if archive:
        payload = ("\r\n".join(program) + "\r\n").encode("cp932")
        data = lha_bytes("B261002.TXT", payload)
        if corrupt:
            # Passes the downloader's >100-byte / -lh check, but is truncated.
            data = data[:110]
        (folder / "b261002.lzh").write_bytes(data)


class OnePickFallbackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not NODE or not BSDTAR:
            raise RuntimeError("Fixture runner requires Node 24 and bsdtar")
        cls.node_version = subprocess.check_output([NODE, "--version"], text=True).strip()
        if not cls.node_version.startswith("v24.") or sys.version_info[:2] != (3, 12):
            raise RuntimeError(f"Required Node24/Python3.12; got {cls.node_version}/{sys.version}")
        output = os.environ.get("ONE_PICK_TEST_OUTPUT")
        cls.temporary = None if output else tempfile.TemporaryDirectory(prefix="one-pick-offline-")
        cls.root = Path(output or cls.temporary.name).resolve()
        cls.root.mkdir(parents=True, exist_ok=True)
        print(f"[environment] Node={cls.node_version} Python={sys.version.split()[0]} output={cls.root}")

    @classmethod
    def tearDownClass(cls):
        if cls.temporary:
            cls.temporary.cleanup()

    def run_case(self, name, missing_bsdtar=False, **fixture_args):
        case = self.root / name
        case.mkdir()  # Refuse to overwrite older validation evidence.
        fixture = case / "fixture"
        fixture.mkdir()
        write_inputs(fixture, **fixture_args)
        temp = case / "tmp"
        temp.mkdir()
        blocker = case / "python-no-network"
        blocker.mkdir()
        (blocker / "sitecustomize.py").write_text(
            "import socket\n"
            "def blocked(*args, **kwargs):\n"
            "    raise RuntimeError('Python fixture network access is forbidden')\n"
            "socket.socket.connect = blocked\n"
            "socket.socket.connect_ex = blocked\n"
            "socket.create_connection = blocked\n"
        )
        executable_path = case / "empty-path" if missing_bsdtar else Path(BSDTAR).parent
        if missing_bsdtar:
            executable_path.mkdir()
        env = {
            "PATH": str(executable_path),
            "TMPDIR": str(temp),
            "PYTHONPATH": str(blocker),
            "PYTHONDONTWRITEBYTECODE": "1",
            "HIDUKE": HIDUKE, "DATE_FROM": HIDUKE, "DATE_TO": HIDUKE,
            "SNAPSHOT_DIR": str(case / "snapshots"),
            "ARCHIVE_DIR": str(case / "archives"),
            "ONE_PICK_FIXTURE_DIR": str(fixture),
            "SHADOW_ONE_PICK_REPORT": str(case / "report.json"),
            "SHADOW_ONE_PICK_STATE": str(case / "state.json"),
            "SHADOW_NOW": "2026-10-02T09:55:00+09:00", "DRY_RUN": "1",
        }
        def run(label, command):
            result = subprocess.run(command, cwd=REPO, env=env, text=True, capture_output=True, timeout=30)
            (case / f"{label}.stdout.log").write_text(result.stdout)
            (case / f"{label}.stderr.log").write_text(result.stderr)
            (case / f"{label}.exit-code").write_text(str(result.returncode) + "\n")
            return result

        for label, script in [("fetch", "scripts/fetch-trifecta-one-pick-inputs.js"),
                              ("download", "scripts/download-boatrace-archives.js")]:
            result = run(label, [NODE, "--import", str(MOCK), script])
            self.assertEqual(result.returncode, 0, result.stderr)
        score = run("score", [sys.executable, "scripts/score-trifecta-one-pick-shadow.py",
                              "--hiduke", HIDUKE, "--snapshot-dir", env["SNAPSHOT_DIR"],
                              "--archive-dir", env["ARCHIVE_DIR"], "--output", env["SHADOW_ONE_PICK_REPORT"]])
        report_file = Path(env["SHADOW_ONE_PICK_REPORT"])
        report = json.loads(report_file.read_text()) if report_file.exists() else None
        notify = None
        if score.returncode == 0:
            notify = run("notify", [NODE, "--import", str(MOCK), "shadow_one_pick_notify.js"])
            self.assertEqual(notify.returncode, 0, notify.stderr)
        self.assertFalse(Path(env["SHADOW_ONE_PICK_STATE"]).exists(), "DRY_RUN wrote a sent-state file")
        requests = [json.loads(line) for line in (fixture / "requests.jsonl").read_text().splitlines()]
        self.assertEqual(len(requests), 7)
        self.assertTrue(all(row["method"] == "GET" for row in requests))
        self.assertFalse((case / "archives/K/k261002.lzh").exists(), "Unexpected result archive")
        return score, report, notify

    def assert_selected(self, score, report, notify, source):
        self.assertEqual(score.returncode, 0, score.stderr)
        self.assertEqual(report["race_card_source"], source)
        self.assertEqual(report["counts"], {"race_cards": 1, "feature_ready": 1, "odds_ready": 1, "selected": 1})
        self.assertEqual(len(report["selections"]), 1)
        self.assertEqual(report["selections"][0]["grade"], "S")
        self.assertIn("[dry-run-payload]", notify.stdout)
        self.assertIn("delivered=1 dry_run=true", notify.stdout)

    def test_live_inputs(self):
        self.assert_selected(*self.run_case("live", live=True, archive=False), "boatracecsv")

    def test_b_archive_with_exhibition_and_odds(self):
        self.assert_selected(*self.run_case("b-ready"), "official_b_archive")

    def test_b_archive_without_exhibition(self):
        score, report, notify = self.run_case("b-no-exhibition", exhibition=False)
        self.assertEqual(score.returncode, 0, score.stderr)
        self.assertEqual(report["race_card_source"], "official_b_archive")
        self.assertEqual(report["counts"], {"race_cards": 1, "feature_ready": 0, "odds_ready": 0, "selected": 0})
        self.assertEqual(report["selections"], [])
        self.assertIn("exhibition", report["note"].lower())
        self.assertIn("no due selections", notify.stdout)

    def test_unpublished_archive(self):
        score, report, notify = self.run_case("unpublished", archive=False, exhibition=False)
        self.assertEqual(score.returncode, 0, score.stderr)
        self.assertEqual(report["race_card_source"], "none")
        self.assertEqual(report["counts"], {"race_cards": 0, "feature_ready": 0, "odds_ready": 0, "selected": 0})
        self.assertIn("available yet", report["note"])
        self.assertIn("no due selections", notify.stdout)

    def test_corrupt_archive(self):
        score, report, notify = self.run_case("corrupt", corrupt=True)
        self.assertNotEqual(score.returncode, 0, score.stdout)
        self.assertIn("program-fallback", score.stderr)
        self.assertIn("bsdtar", score.stderr)
        self.assertIsNone(report)
        self.assertIsNone(notify)

    def test_bsdtar_missing(self):
        score, report, notify = self.run_case("missing-bsdtar", missing_bsdtar=True)
        self.assertNotEqual(score.returncode, 0, score.stdout)
        self.assertIn("program-fallback", score.stderr)
        self.assertIn("bsdtar", score.stderr)
        self.assertIsNone(report)
        self.assertIsNone(notify)

    def test_frozen_ev_artifacts_preserved(self):
        protocol = json.loads((REPO / "experiments/trifecta-ev-shadow/protocol-v1.json").read_text())
        for contract in ("implementation_sha256", "operational_sha256"):
            for relative, expected in protocol["champion"][contract].items():
                with self.subTest(contract=contract, file=relative):
                    self.assertEqual(hashlib.sha256((REPO / relative).read_bytes()).hexdigest(), expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
