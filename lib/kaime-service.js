import { getJstDateString } from "./date.js";
import { buildDualKaimePlans, calculateEscapeRisk } from "./kaime.js";
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

function formatReason(reason) {
  return `${reason.type}: ${reason.boat}号艇 ${formatPercent(reason.attack)} > 1号艇${reason.defenseLabel} ${formatPercent(reason.defense)}`;
}

function areSameTickets(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((ticket, index) => ticket === right[index]);
}

function formatTicketLines(tickets) {
  if (tickets.length === 0) {
    return ["- なし"];
  }

  return tickets.map((ticket) => `- ${ticket}`);
}

function formatPlanLine(label, plan) {
  const statusLabel = plan.status === "buy" ? "候補あり" : ["skip", "no-match", "no-tickets", "no-rule"].includes(plan.status) ? "該当なし" : plan.status;
  const ticketsLabel = plan.tickets.length > 0 ? ` ${plan.tickets.join(" / ")}` : "";
  const noteLabel = plan.status === "buy" && plan.note ? ` ${plan.note}` : "";

  return `${label}: ${statusLabel}${ticketsLabel}${noteLabel}`.trim();
}

export function buildKaimeTextResponse({
  hiduke,
  race,
  plans
}) {
  const escapeRisk = race.escapeRisk || calculateEscapeRisk(race.matchReasons);
  const primary = plans.ana.prediction || plans.honmei.prediction;
  const lines = [
    `対象日: ${hiduke}`,
    `レース: ${race.placeName} ${race.raceNo}R`,
    `逃げ危険度: ${escapeRisk.label} (${escapeRisk.score}) ${escapeRisk.summary}`,
    primary ? `頭候補: ${primary.boat}号艇 (${primary.type})` : "頭候補: なし",
    primary ? `根拠: ${formatReason(primary)}` : "根拠: 条件なし"
  ].filter(Boolean);

  const sharedTickets = areSameTickets(plans.ana.tickets, plans.honmei.tickets);
  if (sharedTickets && plans.ana.tickets.length > 0) {
    lines.push(`共通買い目: 本線 ${formatPlanStatus(plans.honmei)} / 押さえ ${formatPlanStatus(plans.ana)}`);
    lines.push(...formatTicketLines(plans.ana.tickets));
  } else {
    lines.push(formatPlanLine("本線", plans.honmei));
    lines.push(formatPlanLine("押さえ", plans.ana));
  }

  return lines.join("\n");
}

function formatPlanStatus(plan) {
  if (plan.status === "buy") {
    return "候補あり";
  }
  if (["skip", "no-match", "no-tickets", "no-rule"].includes(plan.status)) {
    return "該当なし";
  }
  return plan.status;
}

export function buildKaimeRaceBlock({
  race,
  plans
}) {
  const escapeRisk = race.escapeRisk || calculateEscapeRisk(race.matchReasons);
  const primary = plans.ana.prediction || plans.honmei.prediction;
  const lines = [
    `【${race.placeName} ${race.raceNo}R】 ${primary ? `${primary.boat}号艇 ${primary.type}` : "頭候補なし"}`
  ];

  lines.push(`逃げ危険度: ${escapeRisk.label} (${escapeRisk.score}) ${escapeRisk.summary}`);

  if (primary) {
    lines.push(`根拠: ${formatReason(primary)}`);
  }

  const sharedTickets = areSameTickets(plans.ana.tickets, plans.honmei.tickets);

  if (sharedTickets && plans.ana.tickets.length > 0) {
    lines.push(`共通買い目: 本線 ${formatPlanStatus(plans.honmei)} / 押さえ ${formatPlanStatus(plans.ana)}`);
    lines.push(...formatTicketLines(plans.ana.tickets));
  } else {
    lines.push(`本線: ${formatPlanStatus(plans.honmei)}`);
    lines.push(...formatTicketLines(plans.honmei.tickets));
    lines.push(`押さえ: ${formatPlanStatus(plans.ana)}`);
    lines.push(...formatTicketLines(plans.ana.tickets));
  }

  const notes = [
    plans.honmei.status === "buy" ? plans.honmei.note : null,
    plans.ana.status === "buy" ? plans.ana.note : null
  ].filter(Boolean);
  if (notes.length > 0) {
    lines.push(`備考: ${[...new Set(notes)].join(" / ")}`);
  }

  return lines.join("\n");
}

export async function queryKaimeForRace({
  hiduke = getJstDateString(),
  race
}) {
  if (!race || !Number.isInteger(race.placeNo) || !Number.isInteger(race.raceNo)) {
    throw new Error("race must include placeNo and raceNo");
  }

  const plans = buildDualKaimePlans({
    race
  });

  return {
    hiduke,
    race,
    plans,
    text: buildKaimeTextResponse({
      hiduke,
      race,
      plans
    }),
    block: buildKaimeRaceBlock({
      race,
      plans
    })
  };
}

export async function queryKaime({
  hiduke = getJstDateString(),
  placeNo = null,
  placeName = "",
  raceNo
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
    race
  });
}
