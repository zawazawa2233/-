import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getJstTimestamp } from "./date.js";
import { getPlaceName } from "./places.js";

export function getPickedRaceStateFilename(hiduke) {
  return `picked-races-${hiduke}.json`;
}

function buildRaceKey(placeNo, raceNo) {
  return `${placeNo}-${raceNo}`;
}

export function resolvePickStateDir(dir = process.env.PICK_STATE_DIR) {
  return (dir || "").trim() || "artifacts";
}

export function getPickedRaceStatePath(hiduke, dir = resolvePickStateDir()) {
  return path.join(dir, getPickedRaceStateFilename(hiduke));
}

function buildDefaultFinalState() {
  return {
    status: "pending",
    lastEvaluatedAtJst: null,
    sentAtJst: null,
    deadlineAtJst: null,
    remainingMinutes: null,
    decisionStatus: "pending",
    note: null,
    mainHead: null,
    mainType: null,
    extraHeads: [],
    tickets: [],
    syntheticOdds: null
  };
}

export function buildPickedRaceState({ hiduke, matchedResults, kaimeByRace = new Map() }) {
  const races = matchedResults.map((result) => ({
    placeNo: result.placeNo,
    placeName: result.placeName || getPlaceName(result.placeNo),
    raceNo: result.raceNo,
    sourceUrl: result.url,
    sentAtJst: getJstTimestamp(),
    matchReasons: result.matches.map((match) => ({
      type: match.type,
      boat: match.boat,
      attack: match.attack,
      defense: match.defense,
      defenseLabel: match.defenseLabel
    })),
    escapeRisk: result.escapeRisk ? {
      score: result.escapeRisk.score,
      label: result.escapeRisk.label,
      summary: result.escapeRisk.summary
    } : null,
    kaime: kaimeByRace.get(buildRaceKey(result.placeNo, result.raceNo)) || null,
    final: buildDefaultFinalState()
  }));

  return {
    hiduke,
    generatedAtJst: getJstTimestamp(),
    raceCount: races.length,
    races
  };
}

export function writePickedRaceState(state, dir = resolvePickStateDir()) {
  const filePath = getPickedRaceStatePath(state.hiduke, dir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

function isValidMatchReason(reason) {
  return reason &&
    Number.isInteger(reason.boat) &&
    typeof reason.type === "string" &&
    typeof reason.defenseLabel === "string" &&
    typeof reason.attack === "number" &&
    typeof reason.defense === "number";
}

function isValidEscapeRisk(value) {
  return value === null || (
    value &&
    typeof value.score === "number" &&
    typeof value.label === "string" &&
    typeof value.summary === "string"
  );
}

function isValidTicket(ticket) {
  return typeof ticket === "string" && /^\d-\d-\d$/.test(ticket);
}

function isValidOptionalNumber(value) {
  return value === null || typeof value === "number";
}

function isValidOptionalInteger(value) {
  return value === null || Number.isInteger(value);
}

function isValidKaimePrediction(prediction) {
  return prediction === null || (
    prediction &&
    Number.isInteger(prediction.boat) &&
    typeof prediction.type === "string" &&
    typeof prediction.defenseLabel === "string" &&
    typeof prediction.attack === "number" &&
    typeof prediction.defense === "number" &&
    isValidOptionalNumber(prediction.score)
  );
}

function isValidKaimePlan(plan) {
  return plan &&
    typeof plan.status === "string" &&
    Array.isArray(plan.tickets) &&
    plan.tickets.every(isValidTicket) &&
    isValidOptionalNumber(plan.syntheticOdds) &&
    (plan.note === null || typeof plan.note === "string");
}

function normalizeKaimePrediction(prediction) {
  if (!prediction) {
    return null;
  }

  return {
    type: prediction.type,
    boat: prediction.boat,
    attack: prediction.attack,
    defense: prediction.defense,
    defenseLabel: prediction.defenseLabel,
    score: typeof prediction.score === "number" ? prediction.score : null
  };
}

function normalizeKaimePlan(plan) {
  return {
    status: plan.status,
    tickets: plan.tickets,
    syntheticOdds: typeof plan.syntheticOdds === "number" ? plan.syntheticOdds : null,
    note: typeof plan.note === "string" ? plan.note : null
  };
}

function normalizeRaceKaime(kaime) {
  if (kaime === null || kaime === undefined) {
    return null;
  }

  if (!kaime || typeof kaime !== "object") {
    throw new Error("Pick state race kaime must be an object");
  }

  if (typeof kaime.generatedAtJst !== "string" || !kaime.generatedAtJst) {
    throw new Error("Pick state race kaime generatedAtJst is required");
  }

  if (!["ok", "failed"].includes(kaime.status)) {
    throw new Error("Pick state race kaime status is invalid");
  }

  if (!isValidKaimePrediction(kaime.primaryPrediction)) {
    throw new Error("Pick state race kaime primaryPrediction is invalid");
  }

  if (kaime.status === "ok") {
    if (!kaime.plans || typeof kaime.plans !== "object") {
      throw new Error("Pick state race kaime plans are required");
    }
    if (!isValidKaimePlan(kaime.plans.ana) || !isValidKaimePlan(kaime.plans.honmei)) {
      throw new Error("Pick state race kaime plans are invalid");
    }
  } else if (kaime.plans !== null && kaime.plans !== undefined) {
    throw new Error("Pick state race failed kaime must not include plans");
  }

  if (kaime.error !== null && kaime.error !== undefined && typeof kaime.error !== "string") {
    throw new Error("Pick state race kaime error is invalid");
  }

  return {
    generatedAtJst: kaime.generatedAtJst,
    status: kaime.status,
    primaryPrediction: normalizeKaimePrediction(kaime.primaryPrediction),
    plans: kaime.status === "ok"
      ? {
          ana: normalizeKaimePlan(kaime.plans.ana),
          honmei: normalizeKaimePlan(kaime.plans.honmei)
        }
      : null,
    error: typeof kaime.error === "string" ? kaime.error : null
  };
}

function isValidFinalDecisionStatus(value) {
  return ["pending", "send", "skip", "missed"].includes(value);
}

function normalizeRaceFinal(finalState) {
  if (finalState === null || finalState === undefined) {
    return buildDefaultFinalState();
  }

  if (!finalState || typeof finalState !== "object") {
    throw new Error("Pick state race final must be an object");
  }

  const extraHeads = Array.isArray(finalState.extraHeads) ? finalState.extraHeads : [];
  if (!extraHeads.every((value) => Number.isInteger(value) && value >= 1 && value <= 6)) {
    throw new Error("Pick state race final extraHeads are invalid");
  }

  const tickets = Array.isArray(finalState.tickets) ? finalState.tickets : [];
  if (!tickets.every(isValidTicket)) {
    throw new Error("Pick state race final tickets are invalid");
  }

  const status = typeof finalState.status === "string" ? finalState.status : "pending";
  if (!["pending", "sent", "missed"].includes(status)) {
    throw new Error("Pick state race final status is invalid");
  }

  const decisionStatus = typeof finalState.decisionStatus === "string" ? finalState.decisionStatus : "pending";
  if (!isValidFinalDecisionStatus(decisionStatus)) {
    throw new Error("Pick state race final decisionStatus is invalid");
  }

  if (!isValidOptionalInteger(finalState.remainingMinutes ?? null)) {
    throw new Error("Pick state race final remainingMinutes is invalid");
  }

  if (!isValidOptionalInteger(finalState.mainHead ?? null)) {
    throw new Error("Pick state race final mainHead is invalid");
  }

  return {
    status,
    lastEvaluatedAtJst: typeof finalState.lastEvaluatedAtJst === "string" ? finalState.lastEvaluatedAtJst : null,
    sentAtJst: typeof finalState.sentAtJst === "string" ? finalState.sentAtJst : null,
    deadlineAtJst: typeof finalState.deadlineAtJst === "string" ? finalState.deadlineAtJst : null,
    remainingMinutes: Number.isInteger(finalState.remainingMinutes) ? finalState.remainingMinutes : null,
    decisionStatus,
    note: typeof finalState.note === "string" ? finalState.note : null,
    mainHead: Number.isInteger(finalState.mainHead) ? finalState.mainHead : null,
    mainType: typeof finalState.mainType === "string" ? finalState.mainType : null,
    extraHeads: [...new Set(extraHeads)],
    tickets: [...new Set(tickets)],
    syntheticOdds: typeof finalState.syntheticOdds === "number" ? finalState.syntheticOdds : null
  };
}

export function validatePickedRaceState(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Pick state must be an object");
  }

  if (!/^\d{8}$/.test(parsed.hiduke || "")) {
    throw new Error("Pick state hiduke must be YYYYMMDD");
  }

  if (!Array.isArray(parsed.races)) {
    throw new Error("Pick state races must be an array");
  }

  for (const race of parsed.races) {
    if (!race || typeof race !== "object") {
      throw new Error("Pick state race must be an object");
    }
    if (!Number.isInteger(race.placeNo) || race.placeNo < 1 || race.placeNo > 24) {
      throw new Error("Pick state race placeNo is invalid");
    }
    if (!Number.isInteger(race.raceNo) || race.raceNo < 1 || race.raceNo > 12) {
      throw new Error("Pick state race raceNo is invalid");
    }
    if (typeof race.placeName !== "string" || !race.placeName) {
      throw new Error("Pick state race placeName is required");
    }
    if (typeof race.sourceUrl !== "string" || !race.sourceUrl) {
      throw new Error("Pick state race sourceUrl is required");
    }
    if (!Array.isArray(race.matchReasons) || !race.matchReasons.every(isValidMatchReason)) {
      throw new Error("Pick state race matchReasons is invalid");
    }
    if (!isValidEscapeRisk(race.escapeRisk ?? null)) {
      throw new Error("Pick state race escapeRisk is invalid");
    }
  }

  return {
    hiduke: parsed.hiduke,
    generatedAtJst: typeof parsed.generatedAtJst === "string" ? parsed.generatedAtJst : "",
    raceCount: Number.isInteger(parsed.raceCount) ? parsed.raceCount : parsed.races.length,
    races: parsed.races.map((race) => ({
      ...race,
      escapeRisk: race.escapeRisk || null,
      kaime: normalizeRaceKaime(race.kaime),
      final: normalizeRaceFinal(race.final)
    }))
  };
}

export function readPickedRaceState(hiduke, dir = resolvePickStateDir()) {
  const filePath = getPickedRaceStatePath(hiduke, dir);
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return validatePickedRaceState(parsed);
}
