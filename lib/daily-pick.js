import fetch from "node-fetch";

import { getJstDateString } from "./date.js";
import { buildChunkedDiscordPayloads, deliverDiscordPayloads } from "./discord.js";
import { buildPickedRaceState, writePickedRaceState } from "./pick-state.js";
import { getPlaceName } from "./places.js";
import { createBrowserContext, launchBrowser, NAVIGATION_TIMEOUT_MS, preparePage } from "./playwright.js";

const DEFAULT_PLACE_NOS = Array.from({ length: 24 }, (_, index) => index + 1);
const DEFAULT_RACE_NOS = Array.from({ length: 12 }, (_, index) => index + 1);
const REQUIRED_LABELS = ["差され", "捲られ", "捲られ差し", "差し", "捲り", "捲り差し"];
const LABEL_ALIASES = new Map([
  ["差され", ["差され", "差され率"]],
  ["捲られ", ["捲られ", "捲られ率", "まくられ", "まくられ率"]],
  ["捲られ差し", ["捲られ差し", "捲られ差し率", "捲られ差", "まくられ差", "まくられ差し", "まくられ差し率"]],
  ["差し", ["差し", "差し率"]],
  ["捲り", ["捲り", "捲り率", "まくり", "まくり率"]],
  ["捲り差し", ["捲り差し", "捲り差し率", "まくり差し", "まくり差し率", "捲差", "捲差率", "まく差", "まく差率"]]
]);
const RULES = [
  { attackLabel: "差し", defenseLabel: "差され", type: "差し" },
  { attackLabel: "捲り", defenseLabel: "捲られ", type: "捲り" },
  { attackLabel: "捲り差し", defenseLabel: "捲られ差し", type: "捲り差し" }
];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseCsvIntList(value, name, min, max) {
  if (!value) {
    return null;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }

  return items.map((item) => {
    if (!/^\d+$/.test(item)) {
      throw new Error(`${name} contains an invalid integer: ${item}`);
    }

    const parsed = Number.parseInt(item, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${name} values must be between ${min} and ${max}: ${item}`);
    }

    return parsed;
  });
}

function parseEnvInt(value, name, defaultValue, min) {
  if (!value) {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be >= ${min}`);
  }

  return parsed;
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

  const placeNos = parseCsvIntList(process.env.PLACE_NO_LIST, "PLACE_NO_LIST", 1, 24);
  const raceNos = parseCsvIntList(process.env.RACE_NO_LIST, "RACE_NO_LIST", 1, 12) || DEFAULT_RACE_NOS;
  const concurrency = parseEnvInt(process.env.CONCURRENCY, "CONCURRENCY", 2, 1);
  const throttleMs = parseEnvInt(process.env.THROTTLE_MS, "THROTTLE_MS", 250, 0);

  return {
    webhookUrl,
    hiduke,
    placeNos,
    raceNos,
    concurrency,
    throttleMs,
    dryRun,
    placeNosExplicit: Boolean(placeNos)
  };
}

function buildTargets(config) {
  const targets = [];
  for (const placeNo of config.placeNos) {
    for (const raceNo of config.raceNos) {
      targets.push({
        hiduke: config.hiduke,
        placeNo,
        raceNo,
        placeName: getPlaceName(placeNo),
        url: `https://kyoteibiyori.com/race_shusso.php?hiduke=${config.hiduke}&place_no=${placeNo}&race_no=${raceNo}`
      });
    }
  }
  return targets;
}

async function fetchActivePlaceNos(hiduke) {
  const url = `https://kyoteibiyori.com/index.php?hiduke=${hiduke}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch active place list: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const matches = [...html.matchAll(/\/race_ichiran\.php\?place_no=(\d+)&race_no=\d+&hiduke=\d{8}/g)];
  const placeNos = [...new Set(matches.map((match) => Number.parseInt(match[1], 10)).filter((value) => Number.isInteger(value) && value >= 1 && value <= 24))];

  return placeNos.sort((left, right) => left - right);
}

async function resolvePlaceNos(config) {
  if (config.placeNosExplicit) {
    return config.placeNos;
  }

  try {
    const activePlaceNos = await fetchActivePlaceNos(config.hiduke);
    if (activePlaceNos.length > 0) {
      console.log(`[active-places] auto-detected=${activePlaceNos.join(",")}`);
      return activePlaceNos;
    }

    console.warn("[active-places] no active venues detected from index page, falling back to all 24 places");
  } catch (error) {
    console.warn(`[active-places] auto-detect failed (${error.message}), falling back to all 24 places`);
  }

  return DEFAULT_PLACE_NOS;
}

async function waitForRenderedContent(page) {
  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText || "";
      const hasTargetTab = bodyText.includes("枠別勝率");
      const stillLoading = bodyText.includes("データ取得中");
      return hasTargetTab || !stillLoading;
    },
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
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

        const tag = element.tagName.toLowerCase();
        if (["button", "a", "summary"].includes(tag)) {
          score += 20;
        }
        if (element.getAttribute("role") === "tab") {
          score += 15;
        }
        if (element.className && String(element.className).match(/tab|menu|btn|button|link/i)) {
          score += 10;
        }

        return { element, score };
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

async function openTargetStatsView(page) {
  await clickFirstAvailableControl(page, ["枠別情報", "枠別勝率"]);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText || "";
      return bodyText.includes("直近6ヶ月") && bodyText.includes("差され");
    },
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
}

function normalizeLabel(value) {
  return (value || "").replace(/\s+/g, "").trim();
}

function lineHasCanonicalLabel(line, canonical) {
  const aliases = LABEL_ALIASES.get(canonical) || [];
  return aliases.some((alias) => line.includes(alias));
}

function parseKimariteTextBlock(bodyText) {
  const startIndex = bodyText.indexOf("決まり手");
  if (startIndex < 0) {
    return {};
  }

  let block = bodyText.slice(startIndex);
  const recentIndex = block.indexOf("直近6ヶ月");
  if (recentIndex < 0) {
    return {};
  }

  block = block.slice(recentIndex + "直近6ヶ月".length);

  const endMarkers = ["直近1年", "超展開", "決り手履歴", "決まり手数"];
  let endIndex = block.length;
  for (const marker of endMarkers) {
    const markerIndex = block.indexOf(marker);
    if (markerIndex >= 0 && markerIndex < endIndex) {
      endIndex = markerIndex;
    }
  }
  block = block.slice(0, endIndex);

  const lines = block
    .split(/\r?\n/)
    .map((line) => normalizeLabel(line))
    .filter(Boolean);

  const extracted = {};
  const rowPairs = [
    { defense: "差され", attack: "差し" },
    { defense: "捲られ", attack: "捲り" },
    { defense: "捲られ差し", attack: "捲り差し" }
  ];

  for (const pair of rowPairs) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!lineHasCanonicalLabel(line, pair.defense) || !lineHasCanonicalLabel(line, pair.attack)) {
        continue;
      }

      const values = [];
      for (let cursor = index + 1; cursor < lines.length && values.length < 6; cursor += 1) {
        const valueMatches = lines[cursor].match(/\d+(?:\.\d+)?[%％]/g);
        if (valueMatches) {
          values.push(...valueMatches);
        }
      }

      if (values.length >= 6) {
        extracted[pair.defense] = [values[0], "", "", "", "", ""];
        extracted[pair.attack] = ["", values[1], values[2], values[3], values[4], values[5]];
      }
      break;
    }
  }

  return extracted;
}

function parsePercent(value) {
  const normalized = (value || "").replace(/[%％]/g, "").replace(/\s+/g, "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

async function extractStatsRows(page) {
  const extracted = await page.evaluate(({ requiredLabels, labelAliases }) => {
    const normalize = (value) => (value || "").replace(/\s+/g, "").trim();
    const resolveCanonical = (value) => {
      const normalized = normalize(value);

      for (const [canonical, aliases] of labelAliases) {
        if (aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
          return canonical;
        }
      }

      return null;
    };
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const extractRows = (rows) => {
      const data = {};

      for (const row of rows) {
        if (!isVisible(row)) {
          continue;
        }

        const cells = [...row.querySelectorAll("th, td")]
          .filter((cell) => isVisible(cell))
          .map((cell) => normalize(cell.textContent));

        if (cells.length < 7) {
          continue;
        }

        const label = resolveCanonical(cells[0]);
        if (!label || !requiredLabels.includes(label)) {
          continue;
        }

        data[label] = cells.slice(1, 7);
      }

      return data;
    };

    const extractFromTextLines = (text) => {
      const lines = text
        .split("\n")
        .map((line) => normalize(line))
        .filter(Boolean);
      const data = {};

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
          if (/^-?\d+(?:\.\d+)?[%％]?$/.test(line)) {
            values.push(line);
          }
        }

        if (values.length >= 6) {
          data[label] = values.slice(0, 6);
        }
      }

      return data;
    };

    const tables = [...document.querySelectorAll("table")].filter((table) => isVisible(table));
    let bestData = {};
    let bestScore = -1;

    for (const table of tables) {
      const rows = [...table.querySelectorAll("tr")];
      const data = extractRows(rows);
      const score = requiredLabels.filter((label) => Object.prototype.hasOwnProperty.call(data, label)).length;
      if (score > bestScore) {
        bestData = data;
        bestScore = score;
      }
    }

    if (bestScore < 0) {
      bestData = extractRows([...document.querySelectorAll("tr")]);
    }

    const currentScore = requiredLabels.filter((label) => Object.prototype.hasOwnProperty.call(bestData, label)).length;
    if (currentScore < requiredLabels.length) {
      const textData = extractFromTextLines(document.body?.innerText || "");
      const textScore = requiredLabels.filter((label) => Object.prototype.hasOwnProperty.call(textData, label)).length;
      if (textScore > currentScore) {
        bestData = textData;
      }
    }

    return bestData;
  }, { requiredLabels: REQUIRED_LABELS, labelAliases: [...LABEL_ALIASES.entries()] });
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  const textExtracted = parseKimariteTextBlock(bodyText);

  for (const [label, row] of Object.entries(textExtracted)) {
    extracted[label] = row;
  }

  const rowsByLabel = new Map();
  for (const label of REQUIRED_LABELS) {
    const row = extracted[label];
    if (!row || row.length < 6) {
      throw new Error(`Missing required row: ${label}`);
    }

    const values = row.slice(0, 6).map((cell) => parsePercent(cell));
    if (values.length < 6) {
      throw new Error(`Row does not contain six values: ${label}`);
    }

    rowsByLabel.set(label, values);
  }

  return rowsByLabel;
}

function evaluateRace(rowsByLabel, target) {
  const matches = [];

  for (const rule of RULES) {
    const defenseRow = rowsByLabel.get(rule.defenseLabel);
    const attackRow = rowsByLabel.get(rule.attackLabel);

    if (!defenseRow || !attackRow) {
      continue;
    }

    const defense = defenseRow[0];
    if (defense === null || defense < 10) {
      continue;
    }

    for (let attackIndex = 1; attackIndex < 6; attackIndex += 1) {
      const attack = attackRow[attackIndex];
      if (attack === null || attack < 10) {
        continue;
      }
      if (attack <= defense) {
        continue;
      }

      matches.push({
        type: rule.type,
        defenseLabel: rule.defenseLabel,
        boat: attackIndex + 1,
        attack,
        defense
      });
    }
  }

  return {
    ...target,
    matches
  };
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function formatRaceBlock(result) {
  const lines = [
    `【${result.placeName} ${result.raceNo}R】`,
    `場番号: ${String(result.placeNo).padStart(2, "0")}`,
    `URL: ${result.url}`,
    "一致条件:"
  ];

  for (const match of result.matches) {
    lines.push(`・${match.type}: ${match.boat}号艇 ${formatPercent(match.attack)} > 1号艇${match.defenseLabel} ${formatPercent(match.defense)}`);
  }

  return lines.join("\n");
}

async function scrapeTarget(context, target) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const page = await context.newPage();
    try {
      await preparePage(page);
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      await waitForRenderedContent(page);
      if (await hasVisibleText(page, "データはありません")) {
        await page.close();
        return { result: { ...target, matches: [] }, parsed: false, noData: true };
      }
      await openTargetStatsView(page);
      const rowsByLabel = await extractStatsRows(page);
      const result = evaluateRace(rowsByLabel, target);
      await page.close();
      return { result, parsed: true, noData: false };
    } catch (error) {
      lastError = error;
      await page.close().catch(() => {});
      if (attempt < 2) {
        await sleep(600);
      }
    }
  }

  throw lastError;
}

async function runWorkers(context, targets, config) {
  const matchedResults = [];
  let parsedCount = 0;
  let failureCount = 0;
  let noDataCount = 0;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= targets.length) {
        return;
      }

      const target = targets[currentIndex];
      const jitterMs = Math.floor(Math.random() * 101);
      await sleep(config.throttleMs + jitterMs);

      try {
        const { result, parsed, noData } = await scrapeTarget(context, target);
        if (parsed) {
          parsedCount += 1;
        }
        if (noData) {
          noDataCount += 1;
        }
        if (result.matches.length > 0) {
          matchedResults.push(result);
        }
      } catch (error) {
        failureCount += 1;
        console.error(`[race-failed] ${target.placeNo}場 ${target.raceNo}R ${target.url} :: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  matchedResults.sort((left, right) => {
    if (left.placeNo !== right.placeNo) {
      return left.placeNo - right.placeNo;
    }
    return left.raceNo - right.raceNo;
  });

  return {
    matchedResults,
    parsedCount,
    failureCount,
    noDataCount
  };
}

export async function runDailyPick() {
  const baseConfig = loadConfig();
  const resolvedPlaceNos = await resolvePlaceNos(baseConfig);
  const config = {
    ...baseConfig,
    placeNos: resolvedPlaceNos
  };
  const targets = buildTargets(config);

  console.log(`[start] hiduke=${config.hiduke} places=${config.placeNos.join(",")} races=${config.raceNos.join(",")} concurrency=${config.concurrency} throttleMs=${config.throttleMs} dryRun=${config.dryRun}`);

  const browser = await launchBrowser();
  const context = await createBrowserContext(browser);

  try {
    const { matchedResults, parsedCount, failureCount, noDataCount } = await runWorkers(context, targets, config);
    const summaryLines = [
      `対象日: ${config.hiduke}`,
      `開催場: ${config.placeNos.map((placeNo) => `${getPlaceName(placeNo)}(${placeNo})`).join(", ")}`,
      `走査対象: ${config.placeNos.length}場 x ${config.raceNos.length}R = ${targets.length}レース`,
      `解析成功: ${parsedCount} / ${targets.length}`,
      `データなし: ${noDataCount}`,
      `失敗: ${failureCount}`,
      `一致レース: ${matchedResults.length}`,
      matchedResults.length > 0 ? "以下、条件一致レース一覧です。" : "条件一致レースはありません。"
    ];
    const raceBlocks = matchedResults.map((result) => formatRaceBlock(result));
    const payloads = buildChunkedDiscordPayloads({
      baseTitle: "[DRAFT] kyoteibiyori 条件一致レース",
      content: "[DRAFT] 条件一致レース通知",
      summary: summaryLines.join("\n"),
      blocks: raceBlocks
    });

    await deliverDiscordPayloads({
      webhookUrl: config.webhookUrl,
      payloads,
      dryRun: config.dryRun
    });

    if (!config.dryRun) {
      const state = buildPickedRaceState({
        hiduke: config.hiduke,
        matchedResults
      });
      const filePath = writePickedRaceState(state);
      console.log(`[pick-state] saved=${filePath} races=${state.raceCount}`);
    }

    console.log(`[done] scanned=${targets.length} parsed=${parsedCount} noData=${noDataCount} failed=${failureCount} matched=${matchedResults.length} discordMessages=${payloads.length}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
