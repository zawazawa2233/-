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

function formatReason(reason) {
  return `${reason.type}: ${reason.boat}号艇 ${formatPercent(reason.attack)} > 1号艇${reason.defenseLabel} ${formatPercent(reason.defense)}`;
}

function formatTicketLines(tickets) {
  if (tickets.length === 0) {
    return ["- なし"];
  }

  return tickets.map((ticket) => `- ${ticket}`);
}

function buildDisplayTickets(plans) {
  const tickets = [];
  for (const ticket of plans.honmei.tickets) {
    if (!tickets.includes(ticket)) {
      tickets.push(ticket);
    }
  }
  for (const ticket of plans.ana.tickets) {
    if (!tickets.includes(ticket)) {
      tickets.push(ticket);
    }
  }
  return tickets;
}

export function buildKaimeTextResponse({
  hiduke,
  race,
  plans
}) {
  const primary = plans.ana.prediction || plans.honmei.prediction;
  const lines = [
    `対象日: ${hiduke}`,
    `レース: ${race.placeName} ${race.raceNo}R`,
    primary ? `頭候補: ${primary.boat}号艇 (${primary.type})` : "頭候補: なし",
    primary ? `根拠: ${formatReason(primary)}` : "根拠: 条件なし"
  ].filter(Boolean);

  lines.push("買い目:");
  lines.push(...formatTicketLines(buildDisplayTickets(plans)));

  return lines.join("\n");
}

export function buildKaimeRaceBlock({
  race,
  plans
}) {
  const primary = plans.ana.prediction || plans.honmei.prediction;
  const lines = [
    `【${race.placeName} ${race.raceNo}R】 ${primary ? `${primary.boat}号艇 ${primary.type}` : "頭候補なし"}`
  ];

  if (primary) {
    lines.push(`根拠: ${formatReason(primary)}`);
  }

  lines.push("買い目:");
  lines.push(...formatTicketLines(buildDisplayTickets(plans)));

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
