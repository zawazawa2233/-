import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function parseDate(value) {
  if (!/^\d{8}$/.test(value || "")) {
    throw new Error(`Invalid YYYYMMDD date: ${value}`);
  }
  return new Date(Date.UTC(
    Number.parseInt(value.slice(0, 4), 10),
    Number.parseInt(value.slice(4, 6), 10) - 1,
    Number.parseInt(value.slice(6, 8), 10)
  ));
}

function toHiduke(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
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

async function downloadOne(kind, hiduke, outputRoot) {
  const shortDate = hiduke.slice(2);
  const month = hiduke.slice(0, 6);
  const lower = kind.toLowerCase();
  const filename = path.join(outputRoot, kind, `${lower}${shortDate}.lzh`);
  if (await existsWithContent(filename)) {
    return { status: "cached", filename };
  }

  const url = `https://www1.mbrace.or.jp/od2/${kind}/${month}/${lower}${shortDate}.lzh`;
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; kyoteibiyori-analysis/1.0)" },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    return { status: "missing", filename, note: `HTTP ${response.status}` };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || !bytes.subarray(0, 12).includes(Buffer.from("-lh"))) {
    return { status: "invalid", filename, note: `${bytes.length} bytes` };
  }
  await writeFile(filename, bytes);
  return { status: "downloaded", filename };
}

async function main() {
  const from = process.env.DATE_FROM || "20250101";
  const to = process.env.DATE_TO || "20260822";
  const outputRoot = path.resolve(process.env.ARCHIVE_DIR || "/tmp/boatrace-ev-backtest/archives");
  const concurrency = Number.parseInt(process.env.CONCURRENCY || "8", 10);
  await Promise.all([mkdir(path.join(outputRoot, "B"), { recursive: true }), mkdir(path.join(outputRoot, "K"), { recursive: true })]);

  const jobs = dateRange(from, to).flatMap((hiduke) => ["B", "K"].map((kind) => ({ kind, hiduke })));
  const counts = new Map();
  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      const result = await downloadOne(job.kind, job.hiduke, outputRoot).catch((error) => ({ status: "failed", note: error.message }));
      counts.set(result.status, (counts.get(result.status) || 0) + 1);
      completed += 1;
      if (completed % 100 === 0 || completed === jobs.length) {
        console.log(`[archive] ${completed}/${jobs.length} ${JSON.stringify(Object.fromEntries(counts))}`);
      }
    }
  });
  await Promise.all(workers);
}

await main();
