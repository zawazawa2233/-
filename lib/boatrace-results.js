import fetch from "node-fetch";

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeWhitespace(value) {
  return (value || "").replace(/\s+/g, " ").trim();
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

export async function fetchBoatraceRaceResult(_context, race) {
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
