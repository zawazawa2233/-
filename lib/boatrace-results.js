import fetch from "node-fetch";

import { PLACE_NAMES, getPlaceName } from "./places.js";

const PLACE_NAME_TO_NO = new Map([...PLACE_NAMES.entries()].map(([placeNo, placeName]) => [placeName, placeNo]));

function normalizeWhitespace(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizeLine(value) {
  return normalizeWhitespace(String(value || "").replace(/^Image:\s*/i, ""));
}

function decodeHtmlEntities(value) {
  return (value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function htmlToLines(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, "\n$1\n")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
      .replace(/<\/(tr|td|th|p|div|li|section|article|header|footer|h1|h2|h3|h4|h5|h6|br)>/gi, "\n")
      .replace(/<[^>]+>/g, "\n")
  )
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter(Boolean);
}

function parseYen(value) {
  const match = String(value || "").match(/¥\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円/);
  if (!match) {
    return null;
  }

  const raw = match[1] || match[2];
  const parsed = Number.parseInt(raw.replace(/,/g, ""), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseCombination(value) {
  const compact = normalizeWhitespace(value);
  let match = compact.match(/([1-6])\s*[-=]\s*([1-6])\s*[-=]\s*([1-6])/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  match = compact.match(/([1-6])\s+([1-6])\s+([1-6])/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  match = compact.match(/([1-6])\D+([1-6])\D+([1-6])/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  return null;
}

function finishOrderFromCombination(combination) {
  if (!combination) {
    return null;
  }

  const parts = combination.split("-").map((item) => Number.parseInt(item, 10));
  return parts.length === 3 && parts.every((item) => Number.isInteger(item)) ? parts : null;
}

function parseRaceChunk(lines, venueCount) {
  const entries = [];
  let cursor = 0;

  while (cursor < lines.length && entries.length < venueCount) {
    const line = lines[cursor];

    if (line === "レース中止") {
      entries.push({
        status: "cancelled",
        combination: null,
        payoutYen: null
      });
      cursor += 1;
      continue;
    }

    let combination = null;
    let payoutYen = null;
    const buffer = [];
    let guard = 0;

    while (cursor < lines.length && guard < 6 && (!combination || payoutYen === null)) {
      const current = lines[cursor];
      buffer.push(current);
      const joined = buffer.join(" ");

      if (!combination) {
        combination = parseCombination(joined);
      }
      if (payoutYen === null) {
        payoutYen = parseYen(joined);
      }

      cursor += 1;
      guard += 1;
    }

    if (combination && payoutYen !== null) {
      entries.push({
        status: "confirmed",
        combination,
        payoutYen
      });
      continue;
    }

    entries.push({
      status: "missing",
      combination: null,
      payoutYen: null
    });
  }

  return entries;
}

function resultKey(placeNo, raceNo) {
  return `${placeNo}-${raceNo}`;
}

function resolvePlaceNo(line) {
  if (PLACE_NAME_TO_NO.has(line)) {
    return PLACE_NAME_TO_NO.get(line);
  }

  for (const [placeName, placeNo] of PLACE_NAME_TO_NO.entries()) {
    if (line.includes(placeName)) {
      return placeNo;
    }
  }

  return null;
}

function isRaceLine(line) {
  return /^([1-9]|1[0-2])R$/.test(line);
}

function isDayLine(line) {
  return /^(初日|[０-９0-9]+日目)$/.test(line);
}

export function buildBoatracePayUrl(hiduke) {
  return `https://www.boatrace.jp/owpc/pc/race/pay?hd=${hiduke}`;
}

export async function fetchBoatraceDailyPayouts(hiduke) {
  const resultUrl = buildBoatracePayUrl(hiduke);
  const payoutMap = new Map();

  const response = await fetch(resultUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; kyoteibiyori-result-bot/1.0)",
      "accept-language": "ja,en-US;q=0.9,en;q=0.8"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch payout list: HTTP ${response.status}`);
  }

  const html = await response.text();
  const lines = htmlToLines(html);
  let index = 0;

  while (index < lines.length) {
    const blockVenues = [];

    while (index < lines.length) {
      const line = lines[index];
      const placeNo = resolvePlaceNo(line);
      if (placeNo) {
        blockVenues.push(getPlaceName(placeNo));
        index += 1;
        continue;
      }
      if (isDayLine(line)) {
        index += 1;
        continue;
      }
      break;
    }

    if (blockVenues.length === 0) {
      index += 1;
      continue;
    }

    while (index < lines.length && !lines[index].includes("組番")) {
      index += 1;
    }
    if (index >= lines.length) {
      break;
    }

    index += 1;

    while (index < lines.length) {
      const raceLine = lines[index];
      if (!isRaceLine(raceLine)) {
        break;
      }

      const raceNo = Number.parseInt(raceLine.replace("R", ""), 10);
      index += 1;

      const chunkLines = [];
      while (index < lines.length) {
        const line = lines[index];
        if (isRaceLine(line)) {
          break;
        }
        if (resolvePlaceNo(line)) {
          break;
        }
        if (line.includes("組番")) {
          break;
        }
        chunkLines.push(line);
        index += 1;
      }

      const entries = parseRaceChunk(chunkLines, blockVenues.length);
      for (let venueIndex = 0; venueIndex < blockVenues.length; venueIndex += 1) {
        const placeName = blockVenues[venueIndex];
        const placeNo = PLACE_NAME_TO_NO.get(placeName);
        const entry = entries[venueIndex];
        if (!placeNo || !entry) {
          continue;
        }

        payoutMap.set(resultKey(placeNo, raceNo), entry);
      }
    }
  }

  return payoutMap;
}

export function buildRaceResultFromPayoutMap({ hiduke, placeNo, raceNo, payoutMap }) {
  const resultUrl = buildBoatracePayUrl(hiduke);
  const payout = payoutMap.get(resultKey(placeNo, raceNo));

  if (!payout) {
    return {
      hiduke,
      placeNo,
      raceNo,
      status: "missing",
      trifecta: {
        combination: null,
        payoutYen: null
      },
      finishOrder: null,
      resultUrl,
      note: `No payout found in daily pay list for ${getPlaceName(placeNo)} ${raceNo}R`
    };
  }

  if (payout.status === "cancelled") {
    return {
      hiduke,
      placeNo,
      raceNo,
      status: "cancelled",
      trifecta: {
        combination: null,
        payoutYen: null
      },
      finishOrder: null,
      resultUrl
    };
  }

  return {
    hiduke,
    placeNo,
    raceNo,
    status: "confirmed",
    trifecta: {
      combination: payout.combination,
      payoutYen: payout.payoutYen
    },
    finishOrder: finishOrderFromCombination(payout.combination),
    resultUrl
  };
}
