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
  return `${reason.type}: ${reason.boat}号艇 ${formatPercent(reason.attack)} > 1号艇${reason.defenseLabel} ${formatPercent(reason.defense)}`;
}

function formatPayout(value) {
  return value === null ? null : `${value.toLocaleString("ja-JP")}円`;
}

function formatHiduke(hiduke) {
  if (!/^\d{8}$/.test(hiduke)) {
    return hiduke;
  }

  return `${hiduke.slice(0, 4)}-${hiduke.slice(4, 6)}-${hiduke.slice(6, 8)}`;
}

function buildResultHeadline(race, result) {
  if (result.status === "confirmed") {
    return `【${race.placeName} ${race.raceNo}R】 ${result.trifecta.combination} / ${formatPayout(result.trifecta.payoutYen)}`;
  }

  if (result.status === "not_final") {
    return `【${race.placeName} ${race.raceNo}R】 未確定`;
  }

  if (result.status === "cancelled") {
    return `【${race.placeName} ${race.raceNo}R】 中止`;
  }

  return `【${race.placeName} ${race.raceNo}R】 取得失敗`;
}

function formatRaceBlock(race, result) {
  const lines = [buildResultHeadline(race, result)];
  const reasons = race.matchReasons.map((reason) => `- ${formatMatchReason(reason)}`);

  if (reasons.length > 0) {
    lines.push("条件:");
    lines.push(...reasons);
  }

  lines.push(`結果: ${result.resultUrl}`);

  if (result.note) {
    lines.push(`備考: ${result.note}`);
  }

  return lines.join("\n");
}

function buildTopPayoutLine(results) {
  const topItems = results
    .filter((item) => item.result.status === "confirmed" && item.result.trifecta.payoutYen !== null)
    .sort((left, right) => right.result.trifecta.payoutYen - left.result.trifecta.payoutYen)
    .slice(0, 3)
    .map((item) => `${item.race.placeName} ${item.race.raceNo}R ${formatPayout(item.result.trifecta.payoutYen)}`);

  return topItems.length > 0 ? `高配当: ${topItems.join(" / ")}` : null;
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
    `対象日: ${formatHiduke(state.hiduke)}`,
    `件数: ${state.races.length}レース`,
    `確定 ${counts.confirmed} / 未確定 ${counts.notFinal} / 中止 ${counts.cancelled} / 失敗 ${counts.missing}`,
    buildTopPayoutLine(results)
  ].filter(Boolean), blocks);

  console.log(`[done] hiduke=${state.hiduke} confirmed=${counts.confirmed} not_final=${counts.notFinal} cancelled=${counts.cancelled} missing=${counts.missing} discordMessages=${messages}`);

}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
