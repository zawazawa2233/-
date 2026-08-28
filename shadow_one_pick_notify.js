import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getPlaceName } from "./lib/places.js";

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function deadlineDate(hiduke, deadline) {
  if (!/^\d{8}$/.test(hiduke || "") || !/^\d{1,2}:\d{2}$/.test(deadline || "")) return null;
  const hour = deadline.split(":")[0].padStart(2, "0");
  const minute = deadline.split(":")[1];
  return new Date(`${hiduke.slice(0, 4)}-${hiduke.slice(4, 6)}-${hiduke.slice(6, 8)}T${hour}:${minute}:00+09:00`);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function formatOdds(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}倍` : "—";
}

function buildEmbed(selection) {
  const isS = selection.grade === "S";
  const label = isS ? "勝負本線" : "参考本線";
  return {
    title: `${isS ? "🎯" : "📌"} ${selection.grade} ${label}｜${getPlaceName(selection.place_no)} ${selection.race_no}R`,
    description: [
      `三連単1点　**${selection.ticket}**`,
      `モデル推定的中率 ${formatPercent(selection.model_probability)}`,
      `締切前オッズ ${formatOdds(selection.pre_odds)}｜市場 ${selection.market_rank}番人気`,
      `締切 ${selection.deadline || "不明"} JST`,
      "",
      "実購入なし／前向きシャドー検証"
    ].join("\n"),
    color: isS ? 0xe74c3c : 0x3498db,
    footer: { text: "固定モデル確率1位・各レース1点" }
  };
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

async function deliver(webhookUrl, payloads, dryRun) {
  for (const payload of payloads) {
    if (dryRun) {
      console.log(`[dry-run-payload] ${JSON.stringify(payload)}`);
      continue;
    }
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook failed with status ${response.status}: ${body || response.statusText}`);
    }
  }
}

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const notifyAll = process.env.SHADOW_NOTIFY_ALL === "1";
  const webhookUrl = process.env.SHADOW_DISCORD_WEBHOOK_URL?.trim() || "";
  if (!webhookUrl && !dryRun) throw new Error("SHADOW_DISCORD_WEBHOOK_URL is required unless DRY_RUN=1");
  const reportFile = path.resolve(process.env.SHADOW_ONE_PICK_REPORT || "");
  if (!process.env.SHADOW_ONE_PICK_REPORT) throw new Error("SHADOW_ONE_PICK_REPORT is required");
  const stateFile = path.resolve(process.env.SHADOW_ONE_PICK_STATE || ".shadow-one-pick-cache/state.json");
  const report = await readJson(reportFile);
  const state = await readJson(stateFile, { hiduke: report.hiduke, notified: [] });
  const notified = new Set(state.hiduke === report.hiduke ? state.notified || [] : []);
  const protocol = await readJson(path.resolve("experiments/trifecta-one-pick-shadow/protocol-v1.json"));
  const now = process.env.SHADOW_NOW ? new Date(process.env.SHADOW_NOW) : new Date();
  const lookaheadMs = Number(protocol.notification.deadline_lookahead_minutes || 12) * 60000;
  const graceMs = Number(protocol.notification.past_deadline_grace_minutes || 0) * 60000;
  const due = report.selections.filter((selection) => {
    if (notified.has(selection.race_code)) return false;
    if (notifyAll) return true;
    const deadline = deadlineDate(report.hiduke, selection.deadline);
    if (!deadline || Number.isNaN(deadline.getTime())) return false;
    const distance = deadline.getTime() - now.getTime();
    return distance >= -graceMs && distance <= lookaheadMs;
  });
  if (!due.length) {
    console.log(`[one-pick-notify] no due selections; scored=${report.selections.length} already=${notified.size}`);
    return;
  }
  const payloads = chunks(due.map(buildEmbed), 10).map((embeds) => ({
    username: "三連単1点シャドー",
    content: `モデル本線1点｜${report.hiduke}`,
    embeds
  }));
  await deliver(webhookUrl, payloads, dryRun);
  if (!dryRun) {
    for (const selection of due) notified.add(selection.race_code);
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(
      stateFile,
      JSON.stringify({ hiduke: report.hiduke, notified: [...notified].sort() }, null, 2),
      "utf8"
    );
  }
  console.log(`[one-pick-notify] delivered=${due.length} dry_run=${dryRun}`);
}

await main();
