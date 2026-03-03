import { NAVIGATION_TIMEOUT_MS, preparePage } from "./playwright.js";

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeWhitespace(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function parseYen(value) {
  const match = String(value || "").match(/([0-9][0-9,]*)\s*円/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseCombination(value) {
  const compact = normalizeWhitespace(value);
  let match = compact.match(/([1-6])\s*[-=]\s*([1-6])\s*[-=]\s*([1-6])/);
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

function parseTrifectaWindow(text) {
  const normalized = normalizeWhitespace(text);
  const labelIndex = Math.max(normalized.indexOf("3連単"), normalized.indexOf("三連単"));
  const source = labelIndex >= 0 ? normalized.slice(labelIndex) : normalized;

  const directMatch = source.match(/(?:3連単|三連単)(.{0,80}?)([0-9][0-9,]*)\s*円/);
  if (directMatch) {
    const combination = parseCombination(directMatch[1]);
    const payoutYen = parseYen(directMatch[0]);
    if (combination && payoutYen !== null) {
      return { combination, payoutYen };
    }
  }

  const wideMatch = source.match(/(?:3連単|三連単)(.{0,160}?)([0-9][0-9,]*)\s*円/);
  if (wideMatch) {
    const combination = parseCombination(wideMatch[1]);
    const payoutYen = parseYen(wideMatch[0]);
    if (combination && payoutYen !== null) {
      return { combination, payoutYen };
    }
  }

  return null;
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

function detectStatus(bodyText, trifecta) {
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

export function buildBoatraceResultUrl({ hiduke, placeNo, raceNo }) {
  return `https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${raceNo}&jcd=${pad2(placeNo)}&hd=${hiduke}`;
}

export async function fetchBoatraceRaceResult(context, race) {
  const resultUrl = buildBoatraceResultUrl(race);
  const page = await context.newPage();

  try {
    await preparePage(page);
    const response = await page.goto(resultUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS
    });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

    if (!response || !response.ok()) {
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
        note: response ? `HTTP ${response.status()}` : "No response"
      };
    }

    const rows = await page.evaluate(() => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      return [...document.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("th, td")]
          .map((cell) => normalize(cell.textContent))
          .filter(Boolean)
      );
    });
    const bodyText = await page.locator("body").innerText();
    const trifecta = extractTrifecta(rows, bodyText);
    const status = detectStatus(bodyText, trifecta);

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
  } finally {
    await page.close().catch(() => {});
  }
}
