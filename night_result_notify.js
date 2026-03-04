import {
  buildBoatraceResultUrl,
  buildRaceResultFromPayoutMap,
  fetchBoatraceDailyPayouts,
  fetchBoatraceRaceResult
} from "./lib/boatrace-results.js";
import { getJstDateString } from "./lib/date.js";
import { buildChunkedDiscordPayloads, deliverDiscordPayloads } from "./lib/discord.js";
import { readPickedRaceState } from "./lib/pick-state.js";

function parseEnvBoolean(value) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function loadConfig() {
  const dryRun = parseEnvBoolean(process.env.DRY_RUN);
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim() || "";
  if (!webhookUrl && !dryRun) {
    throw new Error("DISCORD_WEBHOOK_URL is required unless DRY_RUN=1");
  }

  const hiduke = process.env.HIDUKE?.trim() || getJstDateString();
  if (!/^\d{8}$/.test(hiduke)) {
    throw new Error("HIDUKE must be in YYYYMMDD format");
  }

  return {
    webhookUrl,
    hiduke,
    dryRun
  };
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function formatMatchReason(reason) {
  return `${reason.type} ${reason.boat}号艇 ${formatPercent(reason.attack)} > 1号艇${reason.defenseLabel} ${formatPercent(reason.defense)}`;
}

function formatPayout(value) {
  return value === null ? null : `${value.toLocaleString("ja-JP")}円`;
}

function formatRaceBlock(race, result) {
  const lines = [`【${race.placeName} ${race.raceNo}R】`];

  if (result.status === "confirmed") {
    lines.push(`三連単: ${result.trifecta.combination}`);
    lines.push(`確定オッズ: ${formatPayout(result.trifecta.payoutYen)}`);
  } else if (result.status === "not_final") {
    lines.push("三連単: 未確定");
    lines.push("確定オッズ: 未確定");
  } else if (result.status === "cancelled") {
    lines.push("三連単: 中止");
    lines.push("確定オッズ: なし");
  } else {
    lines.push("三連単: 取得失敗");
    lines.push("確定オッズ: 取得失敗");
  }

  lines.push(`結果URL: ${result.resultUrl}`);
  lines.push(`朝条件: ${race.matchReasons.map((reason) => formatMatchReason(reason)).join(" / ") || "記録なし"}`);

  if (result.note) {
    lines.push(`備考: ${result.note}`);
  }

  return lines.join("\n");
}

async function sendSummary(config, summaryLines, blocks = []) {
  const payloads = buildChunkedDiscordPayloads({
    baseTitle: "kyoteibiyori ピックアップレース結果",
    content: "ピックアップレース結果",
    summary: summaryLines.join("\n"),
    blocks,
    color: 5763719
  });

  await deliverDiscordPayloads({
    webhookUrl: config.webhookUrl,
    payloads,
    dryRun: config.dryRun
  });

  return payloads.length;
}

async function collectResults(state) {
  let payoutMap = new Map();
  let payoutLoadError = null;

  try {
    payoutMap = await fetchBoatraceDailyPayouts(state.hiduke);
  } catch (error) {
    payoutLoadError = error;
    console.error(`[pay-table-failed] ${error.message}`);
  }

  const results = [];

  for (const race of state.races) {
    try {
      let result = payoutLoadError
        ? {
            hiduke: state.hiduke,
            placeNo: race.placeNo,
            raceNo: race.raceNo,
            status: "missing",
            trifecta: {
              combination: null,
              payoutYen: null
            },
            finishOrder: null,
            resultUrl: buildBoatraceResultUrl({
              hiduke: state.hiduke,
              placeNo: race.placeNo,
              raceNo: race.raceNo
            }),
            note: `Failed to load daily pay table: ${payoutLoadError.message}`
          }
        : buildRaceResultFromPayoutMap({
            hiduke: state.hiduke,
            placeNo: race.placeNo,
            raceNo: race.raceNo,
            payoutMap
          });

      if (result.status === "missing") {
        const raceResult = await fetchBoatraceRaceResult({
          hiduke: state.hiduke,
          placeNo: race.placeNo,
          raceNo: race.raceNo
        });
        if (raceResult.status !== "missing" || raceResult.trifecta.combination || raceResult.trifecta.payoutYen !== null) {
          result = raceResult;
        }
      }

      results.push({ race, result });
      console.log(`[race-result] ${race.placeNo}場 ${race.raceNo}R status=${result.status}`);
    } catch (error) {
      const fallback = {
        hiduke: state.hiduke,
        placeNo: race.placeNo,
        raceNo: race.raceNo,
        status: "missing",
        trifecta: {
          combination: null,
          payoutYen: null
        },
        finishOrder: null,
        resultUrl: buildBoatraceResultUrl({
          hiduke: state.hiduke,
          placeNo: race.placeNo,
          raceNo: race.raceNo
        }),
        note: error.message
      };
      results.push({ race, result: fallback });
      console.error(`[race-result-failed] ${race.placeNo}場 ${race.raceNo}R :: ${error.message}`);
    }
  }

  return results;
}

async function main() {
  const config = loadConfig();
  const state = readPickedRaceState(config.hiduke);

  if (!state) {
    const messages = await sendSummary(config, [
      `対象日: ${config.hiduke}`,
      "朝の対象データが見つからないため結果通知をスキップしました。"
    ]);
    console.log(`[done] hiduke=${config.hiduke} skipped=missing-pick-state discordMessages=${messages}`);
    return;
  }

  console.log(`[start] hiduke=${state.hiduke} races=${state.races.length} dryRun=${config.dryRun}`);

  if (state.races.length === 0) {
    const messages = await sendSummary(config, [
      `対象日: ${state.hiduke}`,
      "朝のピックアップ対象はありませんでした。"
    ]);
    console.log(`[done] hiduke=${state.hiduke} skipped=no-picked-races discordMessages=${messages}`);
    return;
  }

  const results = await collectResults(state);
  const counts = {
    confirmed: results.filter((item) => item.result.status === "confirmed").length,
    notFinal: results.filter((item) => item.result.status === "not_final").length,
    cancelled: results.filter((item) => item.result.status === "cancelled").length,
    missing: results.filter((item) => item.result.status === "missing").length
  };
  const blocks = results.map(({ race, result }) => formatRaceBlock(race, result));

  const messages = await sendSummary(config, [
    `対象日: ${state.hiduke}`,
    `対象レース: ${state.races.length}`,
    `確定: ${counts.confirmed}`,
    `未確定: ${counts.notFinal}`,
    `中止: ${counts.cancelled}`,
    `取得失敗: ${counts.missing}`
  ], blocks);

  console.log(`[done] hiduke=${state.hiduke} confirmed=${counts.confirmed} not_final=${counts.notFinal} cancelled=${counts.cancelled} missing=${counts.missing} discordMessages=${messages}`);

}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
