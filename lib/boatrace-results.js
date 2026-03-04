import fetch from "node-fetch";

import { createBrowserContext, launchBrowser, NAVIGATION_TIMEOUT_MS, preparePage } from "./playwright.js";
import { PLACE_NAMES, getPlaceName } from "./places.js";

const PLACE_NAME_TO_NO = new Map([...PLACE_NAMES.entries()].map(([placeNo, placeName]) => [placeName, placeNo]));

function pad2(value) {
  return String(value).padStart(2, "0");
}

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

function stripTags(value) {
  return normalizeWhitespace(
    decodeHtmlEntities(
      String(value || "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/(td|th|tr|p|div|li|span)>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );
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

function isDayLabel(value) {
  return /^(初日|[０-９0-9]+日目)$/.test(normalizeWhitespace(value));
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

function parseTrifectaWindow(text) {
  const normalized = normalizeWhitespace(text);
  const labelIndex = Math.max(normalized.indexOf("3連単"), normalized.indexOf("三連単"));
  const source = labelIndex >= 0 ? normalized.slice(labelIndex) : normalized;

  const directMatch = source.match(/(?:3連単|三連単)(.{0,120}?)([0-9][0-9,]*)\s*円/);
  if (directMatch) {
    const combination = parseCombination(directMatch[1]);
    const payoutYen = parseYen(directMatch[0]);
    if (combination && payoutYen !== null) {
      return { combination, payoutYen };
    }
  }

  const fallbackMatch = source.match(/(?:3連単|三連単)(.{0,240}?)([0-9][0-9,]*)\s*円/);
  if (fallbackMatch) {
    const combination = parseCombination(fallbackMatch[1]);
    const payoutYen = parseYen(fallbackMatch[0]);
    if (combination && payoutYen !== null) {
      return { combination, payoutYen };
    }
  }

  return null;
}

function extractRowsFromHtml(html) {
  const rows = [];
  const rowMatches = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  for (const rowHtml of rowMatches) {
    const cells = (rowHtml.match(/<(?:th|td)\b[\s\S]*?<\/(?:th|td)>/gi) || [])
      .map((cellHtml) => stripTags(cellHtml))
      .filter(Boolean);

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

function extractTrifecta(rows, bodyText) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const joined = normalizeWhitespace(row.join(" "));
    if (!joined.includes("3連単") && !joined.includes("三連単")) {
      continue;
    }

    const windowText = [
      joined,
      normalizeWhitespace((rows[index + 1] || []).join(" ")),
      normalizeWhitespace((rows[index + 2] || []).join(" "))
    ].join(" ");

    const rowMatch = parseTrifectaWindow(windowText);
    if (rowMatch) {
      return rowMatch;
    }
  }

  return parseTrifectaWindow(bodyText);
}

function detectRaceResultStatus(bodyText, trifecta) {
  const normalized = normalizeWhitespace(bodyText);

  if (/レース中止|中止|不成立/.test(normalized)) {
    return "cancelled";
  }

  if (trifecta) {
    return "confirmed";
  }

  if (/払戻金|勝式|投票締切|締切/.test(normalized)) {
    return "missing";
  }

  return "not_final";
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
        const rowspan = Number.parseInt(cell.getAttribute("rowspan") || "1", 10);
        return {
          text,
          colspan: Number.isInteger(colspan) && colspan > 1 ? colspan : 1,
          rowspan: Number.isInteger(rowspan) && rowspan > 1 ? rowspan : 1
        };
      };

      const pending = [];
      const normalizedRows = [];

      for (const row of [...document.querySelectorAll("tr")].filter((element) => isVisible(element))) {
        const output = [];
        let columnIndex = 0;

        const consumePending = () => {
          while (pending[columnIndex]?.remaining > 0) {
            output.push(pending[columnIndex].text);
            pending[columnIndex].remaining -= 1;
            if (pending[columnIndex].remaining <= 0) {
              pending[columnIndex] = null;
            }
            columnIndex += 1;
          }
        };

        consumePending();

        for (const cell of [...row.querySelectorAll("th, td")].filter((element) => isVisible(element))) {
          consumePending();

          const expanded = expandCell(cell);
          for (let col = 0; col < expanded.colspan; col += 1) {
            output.push(expanded.text);
            if (expanded.rowspan > 1) {
              pending[columnIndex] = {
                text: expanded.text,
                remaining: expanded.rowspan - 1
              };
            } else {
              pending[columnIndex] = null;
            }
            columnIndex += 1;
          }
        }

        consumePending();

        const normalized = output.filter(Boolean);
        if (normalized.length > 0) {
          normalizedRows.push(normalized);
        }
      }

      return normalizedRows;
    });

    await page.close().catch(() => {});
    return rows;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function fetchPayTableRowsViaHttp(hiduke) {
  const resultUrl = buildBoatracePayUrl(hiduke);
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

  return htmlToLines(await response.text());
}

function parseLinesToPayoutMap(lines) {
  const payoutMap = new Map();
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
      if (isDayLabel(line)) {
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
      if (!isRaceLabel(raceLine)) {
        break;
      }

      const raceNo = Number.parseInt(raceLine.replace("R", ""), 10);
      index += 1;

      const chunkLines = [];
      while (index < lines.length) {
        const line = lines[index];
        if (isRaceLabel(line) || resolvePlaceNo(line) || line.includes("組番")) {
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

export function buildBoatracePayUrl(hiduke) {
  return `https://www.boatrace.jp/owpc/pc/race/pay?hd=${hiduke}`;
}

export function buildBoatraceResultUrl({ hiduke, placeNo, raceNo }) {
  return `https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${raceNo}&jcd=${pad2(placeNo)}&hd=${hiduke}`;
}

export async function fetchBoatraceDailyPayouts(hiduke) {
  try {
    const rows = await extractPayTableRows(hiduke);
    return parseRowsToPayoutMap(rows);
  } catch (error) {
    console.warn(`[pay-table] Playwright fetch failed; falling back to HTTP :: ${error.message}`);
  }

  const lines = await fetchPayTableRowsViaHttp(hiduke);
  return parseLinesToPayoutMap(lines);
}

export async function fetchBoatraceRaceResult(race) {
  const resultUrl = buildBoatraceResultUrl(race);

  try {
    const response = await fetch(resultUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; kyoteibiyori-result-bot/1.0)",
        "accept-language": "ja,en-US;q=0.9,en;q=0.8"
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return {
        hiduke: race.hiduke,
        placeNo: race.placeNo,
        raceNo: race.raceNo,
        status: "missing",
        trifecta: {
          combination: null,
          payoutYen: null
        },
        finishOrder: null,
        resultUrl,
        note: `HTTP ${response.status}`
      };
    }

    const html = await response.text();
    const rows = extractRowsFromHtml(html);
    const bodyText = stripTags(html);
    const trifecta = extractTrifecta(rows, bodyText);
    const status = detectRaceResultStatus(bodyText, trifecta);

    return {
      hiduke: race.hiduke,
      placeNo: race.placeNo,
      raceNo: race.raceNo,
      status,
      trifecta: {
        combination: trifecta?.combination || null,
        payoutYen: trifecta?.payoutYen ?? null
      },
      finishOrder: finishOrderFromCombination(trifecta?.combination || null),
      resultUrl,
      note: status === "missing" && !trifecta ? "Unable to parse 3連単 result" : undefined
    };
  } catch (error) {
    return {
      hiduke: race.hiduke,
      placeNo: race.placeNo,
      raceNo: race.raceNo,
      status: "missing",
      trifecta: {
        combination: null,
        payoutYen: null
      },
      finishOrder: null,
      resultUrl,
      note: error.message
    };
  }
}

export function buildRaceResultFromPayoutMap({ hiduke, placeNo, raceNo, payoutMap }) {
  const resultUrl = buildBoatraceResultUrl({ hiduke, placeNo, raceNo });
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
