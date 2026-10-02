// Test-only fetch replacement. Unknown URLs and all external writes are rejected.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const fixtureDir = process.env.ONE_PICK_FIXTURE_DIR;
if (!fixtureDir) throw new Error("ONE_PICK_FIXTURE_DIR is required");
const hiduke = process.env.HIDUKE;
const datePath = `${hiduke.slice(0, 4)}/${hiduke.slice(4, 6)}/${hiduke.slice(6, 8)}.csv`;
const routes = new Map([
  [`https://boatracecsv.github.io/data/programs/race_cards/${datePath}`, "race_cards.csv"],
  ...["od3", "tkz", "stt", "sui"].map((name) => [
    `https://boatracecsv.github.io/data/previews/${name}/${datePath}`, `${name}.csv`
  ]),
  ...["B", "K"].map((kind) => [
    `https://www1.mbrace.or.jp/od2/${kind}/${hiduke.slice(0, 6)}/${kind.toLowerCase()}${hiduke.slice(2)}.lzh`,
    `${kind.toLowerCase()}${hiduke.slice(2)}.lzh`
  ])
]);

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const method = options.method || "GET";
  appendFileSync(path.join(fixtureDir, "requests.jsonl"), JSON.stringify({ url: url.origin + url.pathname, method }) + "\n");
  const filename = routes.get(url.origin + url.pathname);
  if (method !== "GET" || !filename) throw new Error(`Blocked external request: ${method} ${url.origin}${url.pathname}`);
  let body;
  try {
    body = readFileSync(path.join(fixtureDir, filename));
  } catch (error) {
    if (error.code === "ENOENT") return new Response(null, { status: 404 });
    throw error;
  }
  return new Response(body, { status: 200 });
};
