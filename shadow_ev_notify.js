import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function deliverDiscordPayloads({ webhookUrl, payloads, dryRun }) {
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

function formatYen(value) {
  return `${Math.round(Number(value) || 0).toLocaleString("ja-JP")}円`;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function formatDate(hiduke) {
  return /^\d{8}$/.test(hiduke || "")
    ? `${hiduke.slice(0, 4)}-${hiduke.slice(4, 6)}-${hiduke.slice(6, 8)}`
    : hiduke;
}

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function findChampionRule(report, protocol) {
  const threshold = protocol.champion.ticket_rule.minimum_estimated_ev;
  const cap = protocol.champion.ticket_rule.maximum_tickets_per_race;
  const rule = report.forward_rules?.find((item) => item.threshold === threshold && item.cap === cap);
  if (!rule) throw new Error(`Champion rule not found in report: threshold=${threshold} cap=${cap}`);
  return rule;
}

function delta(current, previous, key) {
  return Number(current?.[key] || 0) - Number(previous?.[key] || 0);
}

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const webhookUrl = process.env.SHADOW_DISCORD_WEBHOOK_URL?.trim() || "";
  if (!webhookUrl && !dryRun) throw new Error("SHADOW_DISCORD_WEBHOOK_URL is required unless DRY_RUN=1");
  if (process.env.SHADOW_TEST === "1") {
    await deliverDiscordPayloads({
      webhookUrl,
      dryRun,
      payloads: [
        {
          username: "EVシャドー検証",
          embeds: [
            {
              title: "✅ 専用ルーム接続テスト成功",
              description: "Champion v1の日次結果は、2026-08-26 07:30 JSTからこのルームへ通知します。\n実購入なし／100円換算のシャドー検証です。",
              color: 0x2ecc71
            }
          ]
        }
      ]
    });
    return;
  }
  const reportFile = path.resolve(process.env.SHADOW_REPORT || "");
  const stateFile = path.resolve(process.env.SHADOW_STATE_FILE || ".shadow-cache/last-summary.json");
  const through = (process.env.SHADOW_THROUGH || "").trim();
  if (!reportFile || !through) throw new Error("SHADOW_REPORT and SHADOW_THROUGH are required");

  const protocol = await readJson(path.resolve("experiments/trifecta-ev-shadow/protocol-v1.json"));
  const report = await readJson(reportFile);
  const current = findChampionRule(report, protocol);
  const previousState = await readJson(stateFile, null);
  if (previousState?.through === through && process.env.FORCE_NOTIFY !== "1") {
    console.log(`[shadow-notify] already notified through ${through}`);
    return;
  }
  const previous = previousState?.champion || {};
  const periodTickets = delta(current, previous, "tickets");
  const periodHits = delta(current, previous, "hits");
  const periodStake = delta(current, previous, "stake");
  const periodReturn = delta(current, previous, "return");
  const periodRoi = periodStake > 0 ? (periodReturn / periodStake) * 100 : null;
  const interval = current.bootstrap_95 || [null, null];
  const checkpoint = current.tickets >= 20000 ? "20,000点チェック" : current.tickets >= 10000 ? "10,000点チェック" : "検証継続中";
  const payload = {
    username: "EVシャドー検証",
    embeds: [
      {
        title: `EVシャドー｜${formatDate(through)}`,
        description: [
          `**Champion v1**　EV≥1.10・各レース1点`,
          `実購入なし／100円換算`,
          "",
          `**前回通知以降**`,
          `買い目 ${periodTickets.toLocaleString("ja-JP")}点｜的中 ${periodHits}件`,
          `投資 ${formatYen(periodStake)}｜払戻 ${formatYen(periodReturn)}｜ROI ${formatPercent(periodRoi)}`,
          "",
          `**2026-08-25からの累計**`,
          `買い目 ${current.tickets.toLocaleString("ja-JP")}点｜的中 ${current.hits}件`,
          `投資 ${formatYen(current.stake)}｜払戻 ${formatYen(current.return)}｜ROI ${formatPercent(current.roi)}`,
          `最大払戻除外 ${formatPercent(current.roi_without_largest_hit)}`,
          `95%区間 ${formatPercent(interval[0])}〜${formatPercent(interval[1])}`,
          `判定: ${checkpoint}`
        ].join("\n"),
        color: periodRoi !== null && periodRoi >= 100 ? 0x2ecc71 : 0xe67e22,
        footer: { text: `固定プロトコル: ${protocol.protocol_id}` }
      }
    ]
  };
  await deliverDiscordPayloads({ webhookUrl, payloads: [payload], dryRun });
  if (!dryRun) {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ through, champion: current }, null, 2), "utf8");
  }
}

await main();
