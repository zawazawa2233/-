import { createBrowserContext, launchBrowser, NAVIGATION_TIMEOUT_MS, preparePage } from "./playwright.js";
import { PLACE_NAMES, getPlaceName } from "./places.js";

const PLACE_NAME_TO_NO = new Map([...PLACE_NAMES.entries()].map(([placeNo, placeName]) => [placeName, placeNo]));

function normalizeWhitespace(value) {
  return (value || "").replace(/\s+/g, " ").trim();
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

function resultKey(placeNo, raceNo) {
  return `${placeNo}-${raceNo}`;
}

function resolvePlaceNo(value) {
  const line = normalizeWhitespace(String(value || "").replace(/^Image:\s*/i, ""));

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

function isRaceLabel(value) {
  return /^([1-9]|1[0-2])R$/.test(normalizeWhitespace(value));
}

function parseVenueGroup(segment) {
  const joined = normalizeWhitespace(segment.join(" "));

  if (!joined) {
    return {
      status: "missing",
      combination: null,
      payoutYen: null
    };
  }

  if (joined.includes("レース中止")) {
    return {
      status: "cancelled",
      combination: null,
      payoutYen: null
    };
  }

  const combination = parseCombination(joined);
  const payoutYen = parseYen(joined);

  if (combination && payoutYen !== null) {
    return {
      status: "confirmed",
      combination,
      payoutYen
    };
  }

  return {
    status: "missing",
    combination: null,
    payoutYen: null
  };
}

function parseRowsToPayoutMap(rows) {
  const payoutMap = new Map();
  let index = 0;

  while (index < rows.length) {
    const venueRow = rows[index];
    const blockVenues = venueRow.map((cell) => resolvePlaceNo(cell)).filter(Boolean);

    if (blockVenues.length === 0) {
      index += 1;
      continue;
    }

    index += 1;

    while (index < rows.length && !rows[index].some((cell) => String(cell).includes("組番"))) {
      index += 1;
    }

    const headerRow = rows[index] || [];
    const headerGroupWidth = blockVenues.length > 0 ? Math.max(3, Math.floor(headerRow.length / blockVenues.length)) : 3;
    index += 1;

    while (index < rows.length) {
      const row = rows[index];
      if (!row || row.length === 0) {
        index += 1;
        continue;
      }

      if (row.some((cell) => resolvePlaceNo(cell))) {
        break;
      }

      if (!isRaceLabel(row[0])) {
        index += 1;
        continue;
      }

      const raceNo = Number.parseInt(String(row[0]).replace("R", ""), 10);
      const cells = row.slice(1);
      if (cells.length === 0) {
        index += 1;
        continue;
      }

      const groupWidth = headerGroupWidth;

      for (let venueIndex = 0; venueIndex < blockVenues.length; venueIndex += 1) {
        const start = venueIndex * groupWidth;
        const end = venueIndex === blockVenues.length - 1 ? cells.length : start + groupWidth;
        const segment = cells.slice(start, end);
        const entry = parseVenueGroup(segment);
        payoutMap.set(resultKey(blockVenues[venueIndex], raceNo), entry);
      }

      index += 1;
    }
  }

  return payoutMap;
}

async function extractPayTableRows(hiduke) {
  const browser = await launchBrowser();
  const context = await createBrowserContext(browser);
  const resultUrl = buildBoatracePayUrl(hiduke);

  try {
    const page = await context.newPage();
    await preparePage(page);
    await page.goto(resultUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS
    });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    const rows = await page.evaluate(() => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const cellText = (cell) => {
        const text = normalize(cell.textContent || "");
        const imgAlts = [...cell.querySelectorAll("img")]
          .map((img) => normalize(img.getAttribute("alt") || ""))
          .filter(Boolean);
        return normalize([text, ...imgAlts].join(" "));
      };

      const expandCell = (cell) => {
        const text = cellText(cell);
        const colspan = Number.parseInt(cell.getAttribute("colspan") || "1", 10);
        const span = Number.isInteger(colspan) && colspan > 1 ? colspan : 1;
        return Array.from({ length: span }, () => text);
      };

      return [...document.querySelectorAll("tr")]
        .filter((row) => isVisible(row))
        .map((row) =>
          [...row.querySelectorAll("th, td")]
            .filter((cell) => isVisible(cell))
            .flatMap((cell) => expandCell(cell))
            .filter(Boolean)
        )
        .filter((row) => row.length > 0);
    });

    await page.close().catch(() => {});
    return rows;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export function buildBoatracePayUrl(hiduke) {
  return `https://www.boatrace.jp/owpc/pc/race/pay?hd=${hiduke}`;
}

export async function fetchBoatraceDailyPayouts(hiduke) {
  const rows = await extractPayTableRows(hiduke);
  return parseRowsToPayoutMap(rows);
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
      note: `No payout found in daily pay table for ${getPlaceName(placeNo)} ${raceNo}R`
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

  if (payout.status !== "confirmed") {
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
      note: `Unable to parse payout row for ${getPlaceName(placeNo)} ${raceNo}R`
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
