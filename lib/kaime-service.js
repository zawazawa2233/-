import { fetchBoatraceTrifectaOdds } from "./boatrace-results.js";
import { getJstDateString } from "./date.js";
import { buildDualKaimePlans } from "./kaime.js";
import { readPickedRaceState } from "./pick-state.js";
import { PLACE_NAMES, getPlaceName } from "./places.js";

const PLACE_NAME_TO_NO = new Map([...PLACE_NAMES.entries()].map(([placeNo, placeName]) => [placeName, placeNo]));

export function resolvePlaceNo({ placeNo = null, placeName = "" }) {
  if (Number.isInteger(placeNo) && placeNo >= 1 && placeNo <= 24) {
    return placeNo;
  }

  const normalized = (placeName || "").trim();
  if (!normalized) {
    throw new Error("placeNo or placeName is required");
  }

  if (PLACE_NAME_TO_NO.has(normalized)) {
    return PLACE_NAME_TO_NO.get(normalized);
  }

  for (const [name, candidatePlaceNo] of PLACE_NAME_TO_NO.entries()) {
    if (normalized.includes(name) || name.includes(normalized)) {
      return candidatePlaceNo;
    }
  }

  throw new Error(`Unknown place name: ${placeName}`);
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function formatOdds(value) {
  if (value === null || value === undefined) {
    return "-";
  }

  return `${value.toLocaleString("ja-JP", {
    minimumFractionDigits: value < 100 ? 1 : 0,
    maximumFractionDigits: 1
  })}倍`;
}

function formatReason(reason) {
  return `${reason.type}: ${reason.boat}号艇 ${formatPercent(reason.attack)} > 1号艇${reason.defenseLabel} ${formatPercent(reason.defense)}`;
}

function formatPlanLine(label, plan, oddsByCombination) {
  const statusLabel = plan.status === "buy" ? "買い" : plan.status === "skip" ? "見送り" : plan.status;
  const oddsLabel = plan.syntheticOdds !== null ? ` 合成${formatOdds(plan.syntheticOdds)}` : "";
  const ticketsLabel = plan.tickets.length > 0
    ? ` ${plan.tickets.map((ticket) => `${ticket}(${formatOdds(oddsByCombination.get(ticket))})`).join(" / ")}`
    : "";
  const noteLabel = plan.note ? ` ${plan.note}` : "";

  return `${label}: ${statusLabel}${oddsLabel}${ticketsLabel}${noteLabel}`.trim();
}

export function buildKaimeTextResponse({
  hiduke,
  race,
  oddsUrl,
  oddsByCombination,
  plans,
  anaMinCombinedOdds,
  honmeiMinCombinedOdds
}) {
  const primary = plans.ana.prediction || plans.honmei.prediction;
  const lines = [
    `対象日: ${hiduke}`,
    `レース: ${race.placeName} ${race.raceNo}R`,
    primary ? `頭候補: ${primary.boat}号艇 (${primary.type})` : "頭候補: なし",
    primary ? `根拠: ${formatReason(primary)}` : "根拠: 条件なし",
    `オッズURL: ${oddsUrl}`,
    formatPlanLine(`穴狙い(合成${anaMinCombinedOdds}倍以上)`, plans.ana, oddsByCombination),
    formatPlanLine(`本命(合成${honmeiMinCombinedOdds}倍以上)`, plans.honmei, oddsByCombination)
  ];

  return lines.join("\n");
}

function formatTicketList(tickets, oddsByCombination) {
  if (tickets.length === 0) {
    return "なし";
  }

  return tickets
    .map((ticket) => `${ticket}(${formatOdds(oddsByCombination.get(ticket))})`)
    .join(" / ");
}

function formatPlanStatus(plan) {
  if (plan.status === "buy") {
    return "買い";
  }
  if (plan.status === "skip") {
    return "見送り";
  }
  return plan.status;
}

export function buildKaimeRaceBlock({
  race,
  oddsByCombination,
  plans,
  anaMinCombinedOdds,
  honmeiMinCombinedOdds
}) {
  const primary = plans.ana.prediction || plans.honmei.prediction;
  const lines = [
    `【${race.placeName} ${race.raceNo}R】 ${primary ? `${primary.boat}号艇 ${primary.type}` : "頭候補なし"}`
  ];

  if (primary) {
    lines.push(`根拠: ${formatReason(primary)}`);
  }

  lines.push(
    `穴狙い(合成${anaMinCombinedOdds}倍以上): ${formatPlanStatus(plans.ana)}${plans.ana.syntheticOdds !== null ? ` / 合成${formatOdds(plans.ana.syntheticOdds)}` : ""}`
  );
  lines.push(`穴目: ${formatTicketList(plans.ana.tickets, oddsByCombination)}`);

  lines.push(
    `本命(合成${honmeiMinCombinedOdds}倍以上): ${formatPlanStatus(plans.honmei)}${plans.honmei.syntheticOdds !== null ? ` / 合成${formatOdds(plans.honmei.syntheticOdds)}` : ""}`
  );
  lines.push(`本線: ${formatTicketList(plans.honmei.tickets, oddsByCombination)}`);

  if (plans.ana.note && plans.ana.note === plans.honmei.note) {
    lines.push(`備考: ${plans.ana.note}`);
  }

  return lines.join("\n");
}

export async function queryKaimeForRace({
  hiduke = getJstDateString(),
  race,
  anaMinCombinedOdds = 10,
  honmeiMinCombinedOdds = 5,
  minTicketOdds = 0
}) {
  if (!race || !Number.isInteger(race.placeNo) || !Number.isInteger(race.raceNo)) {
    throw new Error("race must include placeNo and raceNo");
  }

  const { oddsUrl, oddsByCombination } = await fetchBoatraceTrifectaOdds({
    hiduke,
    placeNo: race.placeNo,
    raceNo: race.raceNo
  });

  const plans = buildDualKaimePlans({
    race,
    oddsByCombination,
    minTicketOdds,
    anaMinCombinedOdds,
    honmeiMinCombinedOdds
  });

  return {
    hiduke,
    race,
    oddsUrl,
    oddsByCombination,
    plans,
    anaMinCombinedOdds,
    honmeiMinCombinedOdds,
    text: buildKaimeTextResponse({
      hiduke,
      race,
      oddsUrl,
      oddsByCombination,
      plans,
      anaMinCombinedOdds,
      honmeiMinCombinedOdds
    }),
    block: buildKaimeRaceBlock({
      race,
      oddsByCombination,
      plans,
      anaMinCombinedOdds,
      honmeiMinCombinedOdds
    })
  };
}

export async function queryKaime({
  hiduke = getJstDateString(),
  placeNo = null,
  placeName = "",
  raceNo,
  anaMinCombinedOdds = 10,
  honmeiMinCombinedOdds = 5,
  minTicketOdds = 0
}) {
  if (!/^\d{8}$/.test(hiduke)) {
    throw new Error("hiduke must be in YYYYMMDD format");
  }
  if (!Number.isInteger(raceNo) || raceNo < 1 || raceNo > 12) {
    throw new Error("raceNo must be between 1 and 12");
  }

  const resolvedPlaceNo = resolvePlaceNo({ placeNo, placeName });
  const state = readPickedRaceState(hiduke);
  if (!state) {
    throw new Error(`Pick state not found for ${hiduke}`);
  }

  const race = state.races.find((item) => item.placeNo === resolvedPlaceNo && item.raceNo === raceNo);
  if (!race) {
    throw new Error(`${getPlaceName(resolvedPlaceNo)} ${raceNo}R is not in picked-races-${hiduke}.json`);
  }

  return queryKaimeForRace({
    hiduke,
    race,
    anaMinCombinedOdds,
    honmeiMinCombinedOdds,
    minTicketOdds
  });
}
