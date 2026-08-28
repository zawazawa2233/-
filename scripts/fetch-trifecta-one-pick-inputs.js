import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCES = [
  ["programs/race_cards", "race_cards"],
  ["previews/od3", "od3"],
  ["previews/tkz", "tkz"],
  ["previews/stt", "stt"],
  ["previews/sui", "sui"]
];

function validateDate(value) {
  if (!/^\d{8}$/.test(value || "")) throw new Error(`Invalid YYYYMMDD date: ${value}`);
  return value;
}

async function fetchSource({ source, folder, hiduke, outputRoot }) {
  const year = hiduke.slice(0, 4);
  const month = hiduke.slice(4, 6);
  const day = hiduke.slice(6, 8);
  const url = `https://boatracecsv.github.io/data/${source}/${year}/${month}/${day}.csv?shadow_refresh=${Date.now()}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "trifecta-model-top1-shadow/1.0",
      "cache-control": "no-cache"
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30000)
  });
  if (response.status === 404) return { folder, status: "missing", bytes: 0 };
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= 100) return { folder, status: "invalid", bytes: bytes.length };
  const directory = path.join(outputRoot, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${hiduke}.csv`), bytes);
  return { folder, status: "downloaded", bytes: bytes.length };
}

async function main() {
  const hiduke = validateDate(process.env.HIDUKE || "");
  const outputRoot = path.resolve(process.env.SNAPSHOT_DIR || ".shadow-one-pick-inputs");
  const results = await Promise.all(
    SOURCES.map(([source, folder]) => fetchSource({ source, folder, hiduke, outputRoot }))
  );
  console.log(JSON.stringify({ hiduke, outputRoot, results }));
}

await main();
