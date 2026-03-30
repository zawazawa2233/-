import fetch from "node-fetch";

import { getJstDateString, getJstTimestamp } from "./date.js";
import { buildChunkedDiscordPayloads, deliverDiscordPayloads } from "./discord.js";
import { calculateSyntheticOdds, selectPrimaryMatchReason } from "./kaime.js";
import { getKaimeRule } from "./kaime-rules.js";
import { readPickedRaceState, writePickedRaceState } from "./pick-state.js";
import { createBrowserContext, launchBrowser, NAVIGATION_TIMEOUT_MS, preparePage } from "./playwright.js";

const FINAL_LOOKAHEAD_MINUTES = 15;
const FINAL_SEND_DEADLINE_MINUTES = 10;
const FINAL_MIN_SYNTHETIC_ODDS = 8.5;
const FINAL_MAX_TICKETS = 24;
const FINAL_INFO_LABEL_ALIASES = new Map([
  ["displayTopCount", ["1位回数"]],
  ["displayTime", ["展示タイム", "展示"]],
  ["st", ["ST"]]
]);
const SEASON_INFO_LABEL_ALIASES = new Map([
  ["seasonRank", ["今節順位", "順位"]],
  ["motor2Rate", ["モーター2連対率", "モーター2連率"]],
  ["frame2Rate", ["枠別2連対率", "枠別連対率", "艇番別2連対率", "艇番2連対率", "コース別2連対率", "2連対率"]]
]);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseEnvBoolean(value) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function loadConfig() {
  const dryRun = parseEnvBoolean(process.env.DRY_RUN);
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim() || "";
  if (!webhookUrl && !dryRun) {
    throw new Error("DISCORD_WEBHOOK_URL is required unless DRY_RUN=1");
  }

  const hiduke = process.env.HIDUKE?.trim() || getJstDateString();
  if (!/^\d{8}$/.test(hiduke)) {
    throw new Error("HIDUKE must be in YYYYMMDD format");
  }

  return {
    webhookUrl,
    hiduke,
    dryRun
  };
}

function normalizeLabel(value) {
  return (value || "").replace(/\s+/g, "").trim();
}

function normalizeWhitespace(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function parseNumber(value) {
  const normalized = normalizeLabel(value).replace(/[,%％]/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value) {
  const match = String(value || "").match(/-?\d+/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[0], 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseStCell(value) {
  const raw = normalizeWhitespace(value);
  const numeric = parseNumber(raw);
  return {
    raw,
    value: numeric,
    flagged: /^[FL]/i.test(raw)
  };
}

function rankAscending(values) {
  const ranked = Array.from({ length: values.length }, () => null);
  const ordered = values
    .map((value, index) => ({ value, index }))
    .filter((item) => typeof item.value === "number" && Number.isFinite(item.value))
    .sort((left, right) => left.value - right.value);

  for (let index = 0; index < ordered.length; index += 1) {
    ranked[ordered[index].index] = index + 1;
  }

  return ranked;
}

function decodeHtmlEntities(value) {
  return (value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&yen;|&#165;/gi, "¥")
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

function parseCellSpan(cellHtml, attributeName) {
  const match = cellHtml.match(new RegExp(`${attributeName}\\s*=\\s*["']?(\\d+)["']?`, "i"));
  if (!match) {
    return 1;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function extractExpandedRowsFromHtml(html) {
  const rows = [];
  const pending = [];
  const rowMatches = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  for (const rowHtml of rowMatches) {
    const cells = rowHtml.match(/<(?:th|td)\b[\s\S]*?<\/(?:th|td)>/gi) || [];
    if (cells.length === 0) {
      continue;
    }

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

    for (const cellHtml of cells) {
      consumePending();

      const text = stripTags(cellHtml);
      const colspan = parseCellSpan(cellHtml, "colspan");
      const rowspan = parseCellSpan(cellHtml, "rowspan");

      for (let spanIndex = 0; spanIndex < colspan; spanIndex += 1) {
        output.push(text);
        if (rowspan > 1) {
          pending[columnIndex] = {
            text,
            remaining: rowspan - 1
          };
        } else {
          pending[columnIndex] = null;
        }
        columnIndex += 1;
      }
    }

    consumePending();

    if (output.some(Boolean)) {
      rows.push(output.map((cell) => normalizeWhitespace(cell)));
    }
  }

  return rows;
}

function buildOddsUrl({ hiduke, placeNo, raceNo }) {
  return `https://www.boatrace.jp/owpc/pc/race/odds3t?hd=${hiduke}&jcd=${String(placeNo).padStart(2, "0")}&rno=${raceNo}`;
}

function parseOddsCell(value) {
  const normalized = normalizeWhitespace(String(value || ""));
  if (!normalized || /^[-–ー]+$/.test(normalized)) {
    return null;
  }

  const match = normalized.match(/[0-9]+(?:\.[0-9]+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchTrifectaOdds({ hiduke, placeNo, raceNo }) {
  const response = await fetch(buildOddsUrl({ hiduke, placeNo, raceNo }));
  if (!response.ok) {
    throw new Error(`Failed to fetch trifecta odds: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const rows = extractExpandedRowsFromHtml(html);
  const oddsByCombination = new Map();

  for (const row of rows) {
    const groups = [];

    for (let index = 0; index + 2 < row.length; index += 3) {
      const second = parseInteger(row[index]);
      const third = parseInteger(row[index + 1]);
      const odds = parseOddsCell(row[index + 2]);
      groups.push({ second, third, odds });
    }

    if (groups.length < 6) {
      continue;
    }

    for (let headIndex = 0; headIndex < 6; headIndex += 1) {
      const group = groups[headIndex];
      const head = headIndex + 1;
      if (!group || !group.second || !group.third || typeof group.odds !== "number") {
        continue;
      }
      if (new Set([head, group.second, group.third]).size !== 3) {
        continue;
      }

      oddsByCombination.set(`${head}-${group.second}-${group.third}`, group.odds);
    }
  }

  if (oddsByCombination.size === 0) {
    throw new Error("No trifecta odds parsed");
  }

  return oddsByCombination;
}

async function waitForRenderedContent(page) {
  try {
    await page.waitForFunction(
      () => {
        const bodyText = document.body?.innerText || "";
        const stillLoading = bodyText.includes("データ取得中");
        return !stillLoading;
      },
      { timeout: NAVIGATION_TIMEOUT_MS }
    );
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (!bodyText || bodyText.includes("データ取得中")) {
      throw error;
    }
  }
}

async function hasVisibleText(page, text) {
  return page.evaluate((targetText) => {
    const bodyText = document.body?.innerText || "";
    return bodyText.includes(targetText);
  }, text);
}

async function clickVisibleControl(page, label) {
  const clicked = await page.evaluate((targetLabel) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const selectors = [
      "button",
      "a",
      "[role='tab']",
      "[role='button']",
      "li",
      "label",
      "summary",
      "div",
      "span"
    ];
    const candidates = [...document.querySelectorAll(selectors.join(","))]
      .filter((element) => isVisible(element))
      .map((element) => {
        const text = normalize(
          element.getAttribute("aria-label") ||
            element.textContent ||
            element.getAttribute("title") ||
            element.getAttribute("value")
        );

        if (!text) {
          return null;
        }

        let score = -1;
        if (text === targetLabel) {
          score = 100;
        } else if (text.includes(targetLabel)) {
          score = 60;
        } else {
          return null;
        }

        return {
          element,
          score
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);

    if (candidates.length === 0) {
      return false;
    }

    candidates[0].element.click();
    return true;
  }, label);

  if (!clicked) {
    throw new Error(`Control not found: ${label}`);
  }

  await sleep(400);
}

async function clickFirstAvailableControl(page, labels) {
  let lastError;

  for (const label of labels) {
    try {
      await clickVisibleControl(page, label);
      return label;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Control not found: ${labels.join(", ")}`);
}

async function openTab(page, labels, requiredTexts = []) {
  await clickFirstAvailableControl(page, labels);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  if (requiredTexts.length > 0) {
    await page.waitForFunction(
      (texts) => {
        const bodyText = document.body?.innerText || "";
        return texts.every((text) => bodyText.includes(text));
      },
      requiredTexts,
      { timeout: NAVIGATION_TIMEOUT_MS }
    ).catch(() => {});
  }
}

async function extractLabeledBoatRows(page, labelAliases) {
  const extracted = await page.evaluate((entries) => {
    const normalize = (value) => (value || "").replace(/\s+/g, "").trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const aliases = new Map(entries);
    const resolveCanonical = (value) => {
      const normalized = normalize(value);
      for (const [canonical, candidateAliases] of aliases.entries()) {
        if (candidateAliases.some((alias) => normalized === alias || normalized.includes(alias))) {
          return canonical;
        }
      }
      return null;
    };
    const scoreCells = (cells) => cells.filter((cell) => /^-?\d+(?:\.\d+)?[%％]?$/.test(cell) || /^[FL]?\.\d+$/.test(cell)).length;
    const data = {};

    const assignRow = (label, values) => {
      if (!label || values.length < 6) {
        return;
      }

      if (!data[label] || scoreCells(values) > scoreCells(data[label])) {
        data[label] = values.slice(0, 6);
      }
    };

    for (const table of [...document.querySelectorAll("table")].filter((table) => isVisible(table))) {
      for (const row of [...table.querySelectorAll("tr")]) {
        if (!isVisible(row)) {
          continue;
        }

        const cells = [...row.querySelectorAll("th, td")]
          .filter((cell) => isVisible(cell))
          .map((cell) => normalize(cell.textContent));

        if (cells.length < 7) {
          continue;
        }

        assignRow(resolveCanonical(cells[0]), cells.slice(1, 7));
      }
    }

    const lines = (document.body?.innerText || "")
      .split("\n")
      .map((line) => normalize(line))
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const label = resolveCanonical(lines[index]);
      if (!label || data[label]) {
        continue;
      }

      const values = [];
      for (let cursor = index + 1; cursor < lines.length && values.length < 6; cursor += 1) {
        const line = lines[cursor];
        if (resolveCanonical(line)) {
          break;
        }

        if (/^-?\d+(?:\.\d+)?[%％]?$/.test(line) || /^[FL]?\.\d+$/.test(line)) {
          values.push(line);
        }
      }

      assignRow(label, values);
    }

    return data;
  }, [...labelAliases.entries()]);

  return new Map(Object.entries(extracted));
}

function parseDeadlineTime(bodyText) {
  const match = String(bodyText || "").match(/締切(?:予定時刻)?[:：]?\s*([0-2]?\d:\d{2})/);
  return match ? match[1] : null;
}

function buildJstDate(hiduke, timeText) {
  if (!/^\d{8}$/.test(hiduke) || !/^\d{1,2}:\d{2}$/.test(timeText || "")) {
    return null;
  }

  const year = Number.parseInt(hiduke.slice(0, 4), 10);
  const month = Number.parseInt(hiduke.slice(4, 6), 10);
  const day = Number.parseInt(hiduke.slice(6, 8), 10);
  const [hourText, minuteText] = timeText.split(":");
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0));
}

function calculateRemainingMinutes(deadlineDate, now = new Date()) {
  return Math.floor((deadlineDate.getTime() - now.getTime()) / 60000);
}

function getMainPrediction(race) {
  return race.kaime?.primaryPrediction || selectPrimaryMatchReason(race.matchReasons || []);
}

function getArrayValue(values, index, parser = (value) => value) {
  if (!Array.isArray(values) || index < 0 || index >= values.length) {
    return null;
  }

  return parser(values[index]);
}

function buildBoatMetrics(snapshot) {
  const displayTimes = Array.from({ length: 6 }, (_, index) => getArrayValue(snapshot.displayTimeRow, index, parseNumber));
  const displayRanks = rankAscending(displayTimes);

  return Array.from({ length: 6 }, (_, index) => {
    const st = getArrayValue(snapshot.stRow, index, parseStCell) || { raw: "", value: null, flagged: false };
    return {
      boat: index + 1,
      displayTime: displayTimes[index],
      displayRank: displayRanks[index],
      displayTopCount: getArrayValue(snapshot.displayTopCountRow, index, parseInteger),
      seasonRank: getArrayValue(snapshot.seasonRankRow, index, parseInteger),
      motor2Rate: getArrayValue(snapshot.motor2RateRow, index, parseNumber),
      frame2Rate: getArrayValue(snapshot.frame2RateRow, index, parseNumber),
      st
    };
  });
}

function computeDisplayBonus(metric) {
  const topCount = metric.displayTopCount;
  const rank = metric.displayRank;
  if (!Number.isInteger(rank)) {
    return 0;
  }

  if (typeof topCount === "number" && topCount >= 80) {
    if (rank <= 2) {
      return 1;
    }
    if (rank >= 5) {
      return -2;
    }
    return 0;
  }

  if (typeof topCount === "number" && topCount >= 40) {
    if (rank === 1) {
      return 2;
    }
    if (rank === 2) {
      return 1;
    }
    if (rank >= 5) {
      return -1;
    }
    return 0;
  }

  if (rank === 1) {
    return 4;
  }
  if (rank === 2) {
    return 2;
  }
  return 0;
}

function computeSeasonRankScore(value) {
  if (value === 1) {
    return 3;
  }
  if (value === 2) {
    return 2;
  }
  if (value === 3) {
    return 1;
  }
  return 0;
}

function computeMotorScore(value) {
  if (typeof value !== "number") {
    return 0;
  }
  if (value >= 45) {
    return 3;
  }
  if (value >= 38) {
    return 2;
  }
  if (value >= 30) {
    return 1;
  }
  return 0;
}

function computeFrameScore(value) {
  if (typeof value !== "number") {
    return 0;
  }
  if (value >= 45) {
    return 2;
  }
  if (value >= 35) {
    return 1;
  }
  return 0;
}

function computeStBonus(metric) {
  if (metric.st.flagged || typeof metric.st.value !== "number") {
    return 0;
  }
  if (metric.st.value <= 0.05) {
    return 1;
  }
  if (metric.st.value <= 0.1) {
    return 0.5;
  }
  return 0;
}

function buildCandidatePool(mainPrediction) {
  const boats = [];
  const rule = getKaimeRule(mainPrediction.type, mainPrediction.boat);

  const append = (value) => {
    if (!Number.isInteger(value) || value < 2 || value > 6 || value === mainPrediction.boat || boats.includes(value)) {
      return;
    }
    boats.push(value);
  };

  if (mainPrediction.type !== "差し") {
    for (let boat = mainPrediction.boat + 1; boat <= 6; boat += 1) {
      append(boat);
    }
  }

  for (const collection of [
    rule?.secondHole || [],
    rule?.secondCover || [],
    rule?.thirdNarrow || [],
    rule?.thirdWide || []
  ]) {
    for (const boat of collection) {
      append(boat);
    }
  }

  return boats;
}

function computeAffinityBonus(mainPrediction, candidateBoat, candidatePool) {
  let score = 0;

  if (candidatePool.includes(candidateBoat)) {
    score += 1;
  }

  if (["捲り", "捲り差し"].includes(mainPrediction.type) && candidateBoat > mainPrediction.boat) {
    score += 1.5;
  }

  return score;
}

function inferExtraHeadType(mainPrediction, candidateBoat) {
  if (["捲り", "捲り差し"].includes(mainPrediction.type) && candidateBoat > mainPrediction.boat) {
    return "捲り差し";
  }
  return mainPrediction.type;
}

function shouldSkipMainHead(mainPrediction, metric) {
  if (!metric) {
    return {
      skip: false,
      note: null
    };
  }

  const displayBonus = computeDisplayBonus(metric);
  if (displayBonus <= -2 && (metric.st.flagged || typeof metric.st.value !== "number" || metric.st.value >= 0.15)) {
    return {
      skip: true,
      note: `主軸${mainPrediction.boat}号艇の展示気配が弱い`
    };
  }

  return {
    skip: false,
    note: null
  };
}

function buildExtraHeadCandidates(mainPrediction, metrics) {
  const candidatePool = buildCandidatePool(mainPrediction);
  const threshold = mainPrediction.type === "差し" ? 6 : 5;

  return candidatePool
    .map((boat) => {
      const metric = metrics[boat - 1];
      if (!metric) {
        return null;
      }

      const score = computeSeasonRankScore(metric.seasonRank) +
        computeMotorScore(metric.motor2Rate) +
        computeFrameScore(metric.frame2Rate) +
        computeDisplayBonus(metric) +
        computeStBonus(metric) +
        computeAffinityBonus(mainPrediction, boat, candidatePool);

      return {
        boat,
        type: inferExtraHeadType(mainPrediction, boat),
        score
      };
    })
    .filter((item) => item && item.score >= threshold)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.boat - right.boat;
    })
    .slice(0, 2);
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 1 && value <= 6))];
}

function buildTickets(headBoat, secondBoats, thirdBoats) {
  const tickets = [];

  for (const secondBoat of uniqueNumbers(secondBoats)) {
    if (secondBoat === headBoat) {
      continue;
    }

    for (const thirdBoat of uniqueNumbers(thirdBoats)) {
      if (thirdBoat === headBoat || thirdBoat === secondBoat) {
        continue;
      }

      tickets.push(`${headBoat}-${secondBoat}-${thirdBoat}`);
    }
  }

  return [...new Set(tickets)];
}

function buildPrioritizedTicketsForHead(headCandidate, headIndex, fallbackType = null) {
  const rule = getKaimeRule(headCandidate.type, headCandidate.boat) || (fallbackType ? getKaimeRule(fallbackType, headCandidate.boat) : null);
  if (!rule) {
    return [];
  }

  const phaseDefinitions = [
    { secondBoats: rule.secondMain, thirdBoats: rule.thirdNarrow, phasePriority: 0 },
    { secondBoats: rule.secondCover, thirdBoats: rule.thirdNarrow, phasePriority: 1 },
    { secondBoats: rule.secondHole, thirdBoats: rule.thirdNarrow, phasePriority: 2 },
    { secondBoats: rule.secondMain, thirdBoats: rule.thirdWide, phasePriority: 3 },
    { secondBoats: rule.secondCover, thirdBoats: rule.thirdWide, phasePriority: 4 },
    { secondBoats: rule.secondHole, thirdBoats: rule.thirdWide, phasePriority: 5 }
  ];

  return phaseDefinitions.flatMap((phase) => buildTickets(headCandidate.boat, phase.secondBoats, phase.thirdBoats).map((ticket) => ({
    ticket,
    priority: (headIndex * 10) + phase.phasePriority
  })));
}

function buildTicketSelection(mainPrediction, extraHeads, oddsByCombination) {
  const headCandidates = [
    {
      boat: mainPrediction.boat,
      type: mainPrediction.type
    },
    ...extraHeads
  ];

  const ticketEntries = headCandidates.flatMap((headCandidate, index) => buildPrioritizedTicketsForHead(headCandidate, index, mainPrediction.type));
  const deduped = new Map();

  for (const entry of ticketEntries) {
    if (!oddsByCombination.has(entry.ticket)) {
      continue;
    }

    const existing = deduped.get(entry.ticket);
    if (!existing || entry.priority < existing.priority) {
      deduped.set(entry.ticket, entry);
    }
  }

  let selected = [...deduped.values()]
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return (oddsByCombination.get(right.ticket) || 0) - (oddsByCombination.get(left.ticket) || 0);
    })
    .slice(0, FINAL_MAX_TICKETS);

  while (selected.length > 0) {
    const tickets = selected.map((item) => item.ticket);
    const syntheticOdds = calculateSyntheticOdds(tickets, oddsByCombination);
    if (typeof syntheticOdds === "number" && syntheticOdds >= FINAL_MIN_SYNTHETIC_ODDS) {
      return {
        status: "send",
        tickets,
        syntheticOdds
      };
    }

    selected.sort((left, right) => {
      const leftOdds = oddsByCombination.get(left.ticket) || Number.POSITIVE_INFINITY;
      const rightOdds = oddsByCombination.get(right.ticket) || Number.POSITIVE_INFINITY;
      if (leftOdds !== rightOdds) {
        return leftOdds - rightOdds;
      }
      return right.priority - left.priority;
    });
    selected.shift();
  }

  return {
    status: "skip",
    tickets: [],
    syntheticOdds: null
  };
}

function formatPercent(value) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "-";
}

function formatOdds(value) {
  return typeof value === "number" ? `${value.toFixed(1)}倍` : "-";
}

function formatSt(raw, value) {
  if (raw) {
    return raw;
  }
  if (typeof value === "number") {
    return value.toFixed(2);
  }
  return "-";
}

function formatTicketLines(tickets) {
  if (tickets.length === 0) {
    return ["- なし"];
  }

  const grouped = new Map();

  for (const ticket of tickets) {
    const [head, second, third] = ticket.split("-");
    const key = `${head}-${second}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    const thirds = grouped.get(key);
    if (!thirds.includes(third)) {
      thirds.push(third);
    }
  }

  return [...grouped.entries()].map(([key, thirds]) => `- ${key}-${thirds.join(",")}`);
}

function buildRaceBlock(race, remainingMinutes, decision, metrics) {
  const mainMetric = metrics[decision.mainHead - 1] || null;
  const lines = [
    `【${race.placeName} ${race.raceNo}R】 最終判定`,
    `締切まで: ${remainingMinutes}分`,
    `主軸頭: ${decision.mainHead}号艇 ${decision.mainType}`,
    `展開頭: ${decision.extraHeads.length > 0 ? decision.extraHeads.map((boat) => `${boat}号艇`).join(", ") : "なし"}`,
    `合成オッズ: ${formatOdds(decision.syntheticOdds)}`,
    mainMetric
      ? `主軸気配: 展示${mainMetric.displayTime ?? "-"} / ST ${formatSt(mainMetric.st.raw, mainMetric.st.value)} / モーター${formatPercent(mainMetric.motor2Rate)}`
      : null,
    "買い目:",
    ...formatTicketLines(decision.tickets)
  ].filter(Boolean);

  return lines.join("\n");
}

async function scrapeRaceSnapshot(context, race) {
  const page = await context.newPage();

  try {
    await preparePage(page);
    await page.goto(race.sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS
    });
    await waitForRenderedContent(page);

    if (await hasVisibleText(page, "データはありません")) {
      return {
        status: "no-data"
      };
    }

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const deadlineTime = parseDeadlineTime(bodyText);

    await openTab(page, ["直前情報"], ["ST"]);
    const finalInfoRows = await extractLabeledBoatRows(page, FINAL_INFO_LABEL_ALIASES);

    let seasonRows = new Map();
    try {
      await openTab(page, ["今節成績"], []);
      seasonRows = await extractLabeledBoatRows(page, SEASON_INFO_LABEL_ALIASES);
    } catch {
      seasonRows = new Map();
    }

    return {
      status: "ok",
      deadlineTime,
      displayTopCountRow: finalInfoRows.get("displayTopCount") || null,
      displayTimeRow: finalInfoRows.get("displayTime") || null,
      stRow: finalInfoRows.get("st") || null,
      seasonRankRow: seasonRows.get("seasonRank") || null,
      motor2RateRow: seasonRows.get("motor2Rate") || null,
      frame2RateRow: seasonRows.get("frame2Rate") || null
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function applyPendingUpdate(race, snapshot, deadlineAtJst, remainingMinutes, note) {
  race.final = {
    ...race.final,
    status: race.final.status === "sent" ? "sent" : "pending",
    lastEvaluatedAtJst: getJstTimestamp(),
    deadlineAtJst,
    remainingMinutes,
    decisionStatus: note ? "skip" : "pending",
    note,
    mainHead: null,
    mainType: null,
    extraHeads: [],
    tickets: [],
    syntheticOdds: null
  };
}

function applyDecision(race, deadlineAtJst, remainingMinutes, decision) {
  race.final = {
    ...race.final,
    status: decision.status === "send" ? "sent" : race.final.status,
    lastEvaluatedAtJst: getJstTimestamp(),
    sentAtJst: decision.status === "send" ? getJstTimestamp() : race.final.sentAtJst,
    deadlineAtJst,
    remainingMinutes,
    decisionStatus: decision.status,
    note: decision.note || null,
    mainHead: decision.mainHead,
    mainType: decision.mainType,
    extraHeads: decision.extraHeads,
    tickets: decision.tickets,
    syntheticOdds: decision.syntheticOdds
  };
}

async function processRace(context, race, config) {
  if (race.final?.status === "sent" || race.final?.status === "missed") {
    return null;
  }

  const snapshot = await scrapeRaceSnapshot(context, race);
  if (snapshot.status !== "ok") {
    applyPendingUpdate(race, snapshot, null, null, "直前データ取得失敗");
    return null;
  }

  if (!snapshot.deadlineTime) {
    applyPendingUpdate(race, snapshot, null, null, "締切時刻を取得できない");
    return null;
  }

  const deadlineDate = buildJstDate(config.hiduke, snapshot.deadlineTime);
  if (!deadlineDate) {
    applyPendingUpdate(race, snapshot, null, null, "締切時刻の解釈に失敗");
    return null;
  }

  const deadlineAtJst = `${config.hiduke.slice(0, 4)}-${config.hiduke.slice(4, 6)}-${config.hiduke.slice(6, 8)}T${snapshot.deadlineTime}:00+09:00`;
  const remainingMinutes = calculateRemainingMinutes(deadlineDate);

  if (remainingMinutes < FINAL_SEND_DEADLINE_MINUTES) {
    race.final = {
      ...race.final,
      status: "missed",
      lastEvaluatedAtJst: getJstTimestamp(),
      deadlineAtJst,
      remainingMinutes,
      decisionStatus: "missed",
      note: "送信期限を過ぎた",
      mainHead: race.final.mainHead,
      mainType: race.final.mainType,
      extraHeads: race.final.extraHeads || [],
      tickets: race.final.tickets || [],
      syntheticOdds: race.final.syntheticOdds
    };
    return null;
  }

  if (remainingMinutes > FINAL_LOOKAHEAD_MINUTES) {
    applyPendingUpdate(race, snapshot, deadlineAtJst, remainingMinutes, null);
    return null;
  }

  const mainPrediction = getMainPrediction(race);
  if (!mainPrediction) {
    applyPendingUpdate(race, snapshot, deadlineAtJst, remainingMinutes, "主軸頭を決められない");
    return null;
  }

  const metrics = buildBoatMetrics(snapshot);
  const mainMetric = metrics[mainPrediction.boat - 1];
  const mainGate = shouldSkipMainHead(mainPrediction, mainMetric);
  if (mainGate.skip) {
    applyDecision(race, deadlineAtJst, remainingMinutes, {
      status: "skip",
      note: mainGate.note,
      mainHead: mainPrediction.boat,
      mainType: mainPrediction.type,
      extraHeads: [],
      tickets: [],
      syntheticOdds: null
    });
    return null;
  }

  const extraHeads = buildExtraHeadCandidates(mainPrediction, metrics);
  let oddsByCombination;

  try {
    oddsByCombination = await fetchTrifectaOdds({
      hiduke: config.hiduke,
      placeNo: race.placeNo,
      raceNo: race.raceNo
    });
  } catch (error) {
    applyDecision(race, deadlineAtJst, remainingMinutes, {
      status: "skip",
      note: `オッズ取得失敗: ${error.message}`,
      mainHead: mainPrediction.boat,
      mainType: mainPrediction.type,
      extraHeads: extraHeads.map((item) => item.boat),
      tickets: [],
      syntheticOdds: null
    });
    return null;
  }

  const ticketSelection = buildTicketSelection(mainPrediction, extraHeads, oddsByCombination);
  if (ticketSelection.status !== "send") {
    applyDecision(race, deadlineAtJst, remainingMinutes, {
      status: "skip",
      note: `合成オッズ${FINAL_MIN_SYNTHETIC_ODDS}倍未満`,
      mainHead: mainPrediction.boat,
      mainType: mainPrediction.type,
      extraHeads: extraHeads.map((item) => item.boat),
      tickets: [],
      syntheticOdds: null
    });
    return null;
  }

  const decision = {
    status: "send",
    note: null,
    mainHead: mainPrediction.boat,
    mainType: mainPrediction.type,
    extraHeads: extraHeads.map((item) => item.boat),
    tickets: ticketSelection.tickets,
    syntheticOdds: ticketSelection.syntheticOdds
  };
  applyDecision(race, deadlineAtJst, remainingMinutes, decision);

  return {
    race,
    remainingMinutes,
    decision,
    metrics
  };
}

async function sendFinalJudgement(config, items) {
  if (items.length === 0) {
    return 0;
  }

  const payloads = buildChunkedDiscordPayloads({
    baseTitle: "kyoteibiyori 展示後最終ジャッジ",
    content: "展示後最終ジャッジ",
    summary: [
      `対象日: ${config.hiduke}`,
      `送信レース: ${items.length}`,
      `条件: 締切${FINAL_LOOKAHEAD_MINUTES}分以内 / 合成オッズ${FINAL_MIN_SYNTHETIC_ODDS}倍以上 / 最大${FINAL_MAX_TICKETS}点`
    ].join("\n"),
    blocks: items.map((item) => buildRaceBlock(item.race, item.remainingMinutes, item.decision, item.metrics)),
    color: 15105570
  });

  await deliverDiscordPayloads({
    webhookUrl: config.webhookUrl,
    payloads,
    dryRun: config.dryRun
  });

  return payloads.length;
}

export async function runFinalJudge() {
  const config = loadConfig();
  const state = readPickedRaceState(config.hiduke);

  if (!state) {
    console.log(`[done] hiduke=${config.hiduke} skipped=missing-pick-state`);
    return;
  }

  if (state.races.length === 0) {
    console.log(`[done] hiduke=${config.hiduke} skipped=no-picked-races`);
    return;
  }

  console.log(`[start] hiduke=${state.hiduke} races=${state.races.length} dryRun=${config.dryRun}`);

  const browser = await launchBrowser();
  const context = await createBrowserContext(browser);

  try {
    const sentItems = [];

    for (const race of state.races) {
      try {
        const result = await processRace(context, race, config);
        if (result) {
          sentItems.push(result);
        }
      } catch (error) {
        race.final = {
          ...race.final,
          status: race.final?.status === "sent" ? "sent" : "pending",
          lastEvaluatedAtJst: getJstTimestamp(),
          decisionStatus: "skip",
          note: error.message,
          mainHead: race.final?.mainHead ?? null,
          mainType: race.final?.mainType ?? null,
          extraHeads: race.final?.extraHeads || [],
          tickets: race.final?.tickets || [],
          syntheticOdds: race.final?.syntheticOdds ?? null
        };
        console.error(`[final-judge-failed] ${race.placeName} ${race.raceNo}R :: ${error.message}`);
      }
    }

    const messages = await sendFinalJudgement(config, sentItems);
    if (!config.dryRun) {
      const filePath = writePickedRaceState(state);
      console.log(`[pick-state] saved=${filePath} sent=${sentItems.length}`);
    }
    console.log(`[done] hiduke=${state.hiduke} sent=${sentItems.length} missed=${state.races.filter((race) => race.final?.status === "missed").length} discordMessages=${messages}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
