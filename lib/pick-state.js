import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getJstTimestamp } from "./date.js";
import { getPlaceName } from "./places.js";

export function getPickedRaceStateFilename(hiduke) {
  return `picked-races-${hiduke}.json`;
}

export function resolvePickStateDir(dir = process.env.PICK_STATE_DIR) {
  return (dir || "").trim() || "artifacts";
}

export function getPickedRaceStatePath(hiduke, dir = resolvePickStateDir()) {
  return path.join(dir, getPickedRaceStateFilename(hiduke));
}

export function buildPickedRaceState({ hiduke, matchedResults }) {
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
    }))
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
  }

  return {
    hiduke: parsed.hiduke,
    generatedAtJst: typeof parsed.generatedAtJst === "string" ? parsed.generatedAtJst : "",
    raceCount: Number.isInteger(parsed.raceCount) ? parsed.raceCount : parsed.races.length,
    races: parsed.races
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
