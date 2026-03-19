import {
  buildBoatraceResultUrl,
  fetchBoatraceDailyPayouts,
  fetchBoatraceRaceResult
} from "./lib/boatrace-results.js";
import { getJstDateString } from "./lib/date.js";
import { buildChunkedDiscordPayloads, deliverDiscordPayloads } from "./lib/discord.js";
import { readPickedRaceState } from "./lib/pick-state.js";

const HIGH_PAYOUT_THRESHOLD_YEN = 10000;
const SUMMARY_HIGHLIGHT_LIMIT = 5;

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

function formatOdds(value) {
  if (typeof value !== "number") {
    return null;
  }

  return `${value.toLocaleString("ja-JP", {
    minimumFractionDigits: value < 100 ? 1 : 0,
    maximumFractionDigits: 1
  })}倍`;
}

function formatPrediction(prediction) {
  if (!prediction) {
    return "なし";
  }

  return `${prediction.boat}号艇 (${prediction.type})`;
}

function areSameTickets(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  return left.every((ticket, index) => ticket === right[index]);
}

function planIncludesCombination(plan, combination) {
  return Boolean(
    plan &&
    plan.status === "buy" &&
    Array.isArray(plan.tickets) &&
    combination &&
    plan.tickets.includes(combination)
  );
}

function buildKaimeJudgement(race, result) {
  if (!race.kaime) {
    return {
      status: "unavailable",
      hitTypes: [],
      note: "朝の買い目情報なし"
    };
  }

  if (race.kaime.status === "failed") {
    return {
      status: "unavailable",
      hitTypes: [],
      note: race.kaime.error ? `朝の買い目算出失敗: ${race.kaime.error}` : "朝の買い目算出失敗"
    };
  }

  if (result.status === "not_final") {
    return {
      status: "pending",
      hitTypes: [],
      note: null
    };
  }

  if (result.status === "cancelled") {
    return {
      status: "cancelled",
      hitTypes: [],
      note: "レース中止"
    };
  }

  if (result.status !== "confirmed") {
    return {
      status: "unavailable",
      hitTypes: [],
      note: result.note || "結果取得失敗"
    };
  }

  const combination = result.trifecta.combination;
  const hitTypes = [];
  if (planIncludesCombination(race.kaime.plans?.ana, combination)) {
    hitTypes.push("穴");
  }
  if (planIncludesCombination(race.kaime.plans?.honmei, combination)) {
    hitTypes.push("本命");
  }

  return {
    status: hitTypes.length > 0 ? "hit" : "miss",
    hitTypes,
    note: null
  };
}

function formatHitType(hitTypes) {
  if (hitTypes.length === 0) {
    return "";
  }

  return hitTypes.length >= 2 ? "共通" : hitTypes[0];
}

function formatHiduke(hiduke) {
  if (!/^\d{8}$/.test(hiduke)) {
    return hiduke;
  }

  return `${hiduke.slice(0, 4)}-${hiduke.slice(4, 6)}-${hiduke.slice(6, 8)}`;
}

function buildResultHeadline(race, result, judgement) {
  const prefix = judgement.status === "hit" ? "◎ " : "";

  if (result.status === "confirmed") {
    return `${prefix}【${race.placeName} ${race.raceNo}R】 ${result.trifecta.combination} / ${formatPayout(result.trifecta.payoutYen)}`;
  }

  if (result.status === "not_final") {
    return `${prefix}【${race.placeName} ${race.raceNo}R】 未確定`;
  }

  if (result.status === "cancelled") {
    return `${prefix}【${race.placeName} ${race.raceNo}R】 中止`;
  }

  return `${prefix}【${race.placeName} ${race.raceNo}R】 取得失敗`;
}

function formatPlanLine(label, plan) {
  if (!plan || plan.status !== "buy" || plan.tickets.length === 0) {
    return `${label}: 該当なし`;
  }

  const oddsLabel = formatOdds(plan.syntheticOdds);
  return `${label}: ${plan.tickets.join(" / ")}${oddsLabel ? ` / 合成${oddsLabel}` : ""}`;
}

function formatKaimeOutcomeLine(result, judgement) {
  if (judgement.status === "hit") {
    return `買い目的中: ${formatHitType(judgement.hitTypes)} ${result.trifecta.combination}`;
  }

  if (judgement.status === "miss") {
    return "買い目: 不的中";
  }

  if (judgement.status === "pending") {
    return "買い目: 判定待ち";
  }

  if (judgement.status === "cancelled") {
    return "買い目: 判定なし (中止)";
  }

  return `買い目: 判定不可${judgement.note ? ` (${judgement.note})` : ""}`;
}

function buildKaimeCandidateLines(race) {
  if (!race.kaime || race.kaime.status !== "ok") {
    return [];
  }

  const lines = [];
  if (race.kaime.primaryPrediction) {
    lines.push(`頭候補: ${formatPrediction(race.kaime.primaryPrediction)}`);
  }

  const anaPlan = race.kaime.plans.ana;
  const honmeiPlan = race.kaime.plans.honmei;
  if (anaPlan.status === "buy" && honmeiPlan.status === "buy" && areSameTickets(anaPlan.tickets, honmeiPlan.tickets)) {
    const oddsLabel = formatOdds(anaPlan.syntheticOdds);
    lines.push(`共通買い目: ${anaPlan.tickets.join(" / ")}${oddsLabel ? ` / 合成${oddsLabel}` : ""}`);
    return lines;
  }

  lines.push("買い目候補:");
  lines.push(formatPlanLine("穴", anaPlan));
  lines.push(formatPlanLine("本命", honmeiPlan));
  return lines;
}

function formatRaceBlock(race, result, judgement) {
  const lines = [buildResultHeadline(race, result, judgement)];
  const reasons = race.matchReasons.map((reason) => `- ${formatMatchReason(reason)}`);
  lines.push(formatKaimeOutcomeLine(result, judgement));
  lines.push(...buildKaimeCandidateLines(race));

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
  const highPayoutItems = results
    .filter((item) => item.result.status === "confirmed" && item.result.trifecta.payoutYen !== null)
    .filter((item) => item.result.trifecta.payoutYen >= HIGH_PAYOUT_THRESHOLD_YEN)
    .sort((left, right) => right.result.trifecta.payoutYen - left.result.trifecta.payoutYen)
    .slice(0, SUMMARY_HIGHLIGHT_LIMIT)
    .map((item) => `${item.race.placeName} ${item.race.raceNo}R ${formatPayout(item.result.trifecta.payoutYen)}`);

  return highPayoutItems.length > 0 ? `高配当(1万円以上): ${highPayoutItems.join(" / ")}` : null;
}

function buildKaimeHitSummaryLine(results) {
  const hitResults = results.filter((item) => item.judgement.status === "hit");
  if (hitResults.length === 0) {
    return "買い目的中: 0レース";
  }

  const highlighted = hitResults
    .slice(0, SUMMARY_HIGHLIGHT_LIMIT)
    .map(({ race, judgement }) => {
      return `${race.placeName} ${race.raceNo}R ${formatHitType(judgement.hitTypes)}`;
    });

  const remainingCount = hitResults.length - highlighted.length;
  const suffix = remainingCount > 0 ? ` / 他${remainingCount}レース` : "";
  return `買い目的中: ${hitResults.length}レース (${highlighted.join(" / ")}${suffix})`;
}

function buildKaimeUnavailableSummaryLine(results) {
  const unavailableCount = results.filter((item) => item.judgement.status === "unavailable").length;
  return unavailableCount > 0 ? `買い目判定不可: ${unavailableCount}レース` : null;
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
      let result = await fetchBoatraceRaceResult({
        hiduke: state.hiduke,
        placeNo: race.placeNo,
        raceNo: race.raceNo
      });

      if (
        result.status === "missing" &&
        !payoutLoadError &&
        payoutMap.has(`${race.placeNo}-${race.raceNo}`)
      ) {
        const payoutFallback = payoutMap.get(`${race.placeNo}-${race.raceNo}`);
        if (payoutFallback?.status === "confirmed") {
          result = {
            hiduke: state.hiduke,
            placeNo: race.placeNo,
            raceNo: race.raceNo,
            status: "confirmed",
            trifecta: {
              combination: payoutFallback.combination,
              payoutYen: payoutFallback.payoutYen
            },
            finishOrder: payoutFallback.combination
              .split("-")
              .map((value) => Number.parseInt(value, 10)),
            resultUrl: buildBoatraceResultUrl({
              hiduke: state.hiduke,
              placeNo: race.placeNo,
              raceNo: race.raceNo
            }),
            note: "個別結果ページ取得失敗のため日別払戻一覧で補完"
          };
        }
      } else if (result.status === "missing" && payoutLoadError) {
        result.note = result.note || `Failed to load daily pay table: ${payoutLoadError.message}`;
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

  const results = (await collectResults(state)).map((item) => ({
    ...item,
    judgement: buildKaimeJudgement(item.race, item.result)
  }));
  const counts = {
    confirmed: results.filter((item) => item.result.status === "confirmed").length,
    notFinal: results.filter((item) => item.result.status === "not_final").length,
    cancelled: results.filter((item) => item.result.status === "cancelled").length,
    missing: results.filter((item) => item.result.status === "missing").length
  };
  const blocks = results.map(({ race, result, judgement }) => formatRaceBlock(race, result, judgement));

  const messages = await sendSummary(config, [
    `対象日: ${formatHiduke(state.hiduke)}`,
    `件数: ${state.races.length}レース`,
    `確定 ${counts.confirmed} / 未確定 ${counts.notFinal} / 中止 ${counts.cancelled} / 失敗 ${counts.missing}`,
    buildKaimeHitSummaryLine(results),
    buildKaimeUnavailableSummaryLine(results),
    buildTopPayoutLine(results)
  ].filter(Boolean), blocks);

  console.log(`[done] hiduke=${state.hiduke} confirmed=${counts.confirmed} not_final=${counts.notFinal} cancelled=${counts.cancelled} missing=${counts.missing} discordMessages=${messages}`);

}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
