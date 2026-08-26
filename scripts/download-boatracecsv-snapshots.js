import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCES = [
  ["programs/race_cards", "race_cards", "20260825"],
  ["previews/od3", "od3", "20260719"],
  ["previews/tkz", "tkz", "20260501"],
  ["previews/stt", "stt", "20260501"],
  ["previews/sui", "sui", "20260501"],
  ["results/realtime", "results", "20260719"],
  ["results/payouts", "payouts", "20260719"]
];

function parseDate(value) {
  if (!/^\d{8}$/.test(value || "")) throw new Error(`Invalid YYYYMMDD date: ${value}`);
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
}

function toHiduke(value) {
  return value.toISOString().slice(0, 10).replaceAll("-", "");
}

function dateRange(from, to) {
  const values = [];
  for (let cursor = parseDate(from); cursor <= parseDate(to); cursor = new Date(cursor.getTime() + 86400000)) {
    values.push(toHiduke(cursor));
  }
  return values;
}

async function existsWithContent(filename) {
  try {
    return (await stat(filename)).size > 100;
  } catch {
    return false;
  }
}

async function download(job, outputRoot) {
  const [, folder] = job.source;
  const filename = path.join(outputRoot, folder, `${job.hiduke}.csv`);
  if (await existsWithContent(filename)) return "cached";
  const year = job.hiduke.slice(0, 4);
  const month = job.hiduke.slice(4, 6);
  const day = job.hiduke.slice(6, 8);
  const response = await fetch(`https://boatracecsv.github.io/data/${job.source[0]}/${year}/${month}/${day}.csv`, {
    headers: { "user-agent": "kyoteibiyori-shadow-research/1.0" },
    signal: AbortSignal.timeout(30000)
  });
  if (response.status === 404) return "missing";
  if (!response.ok) throw new Error(`${job.hiduke} ${job.source[0]}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= 100) return "invalid";
  await writeFile(filename, bytes);
  return "downloaded";
}

async function main() {
  const from = process.env.DATE_FROM || "20260501";
  const to = process.env.DATE_TO || toHiduke(new Date());
  const outputRoot = path.resolve(process.env.SNAPSHOT_DIR || "/tmp/boatrace-prerace");
  const concurrency = Number.parseInt(process.env.CONCURRENCY || "8", 10);
  await Promise.all(SOURCES.map(([, folder]) => mkdir(path.join(outputRoot, folder), { recursive: true })));
  const jobs = dateRange(from, to).flatMap((hiduke) =>
    SOURCES.filter((source) => hiduke >= source[2]).map((source) => ({ hiduke, source }))
  );
  const counts = new Map();
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const status = await download(job, outputRoot).catch((error) => {
        console.error(`[snapshot] ${error.message}`);
        return "failed";
      });
      counts.set(status, (counts.get(status) || 0) + 1);
    }
  });
  await Promise.all(workers);
  console.log(JSON.stringify(Object.fromEntries(counts)));
  if ((counts.get("failed") || 0) > 0) process.exitCode = 1;
}

await main();
