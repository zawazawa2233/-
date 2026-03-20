import { buildChunkedDiscordPayloads, deliverDiscordPayloads } from "./lib/discord.js";
import { queryKaime } from "./lib/kaime-service.js";

function parseEnvBoolean(value) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseEnvInt(value, name, { min = null, max = null, required = false } = {}) {
  const normalized = (value || "").trim();
  if (!normalized) {
    if (required) {
      throw new Error(`${name} is required`);
    }
    return null;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer`);
  }

  const parsed = Number.parseInt(normalized, 10);
  if (min !== null && parsed < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== null && parsed > max) {
    throw new Error(`${name} must be <= ${max}`);
  }

  return parsed;
}

function loadConfig() {
  const dryRun = parseEnvBoolean(process.env.DRY_RUN);
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim() || "";
  if (!webhookUrl && !dryRun) {
    throw new Error("DISCORD_WEBHOOK_URL is required unless DRY_RUN=1");
  }

  return {
    dryRun,
    webhookUrl,
    hiduke: process.env.HIDUKE?.trim() || undefined,
    placeNo: parseEnvInt(process.env.PLACE_NO, "PLACE_NO", { min: 1, max: 24 }),
    placeName: process.env.PLACE_NAME?.trim() || "",
    raceNo: parseEnvInt(process.env.RACE_NO, "RACE_NO", { min: 1, max: 12, required: true })
  };
}

async function main() {
  const config = loadConfig();
  const result = await queryKaime(config);

  const payloads = buildChunkedDiscordPayloads({
    baseTitle: "kyoteibiyori 買い目案",
    content: "買い目案",
    summary: result.text,
    blocks: [],
    color: 15844367
  });

  await deliverDiscordPayloads({
    webhookUrl: config.webhookUrl,
    payloads,
    dryRun: config.dryRun
  });

  console.log(`[done] hiduke=${result.hiduke} race=${result.race.placeName}-${result.race.raceNo} ana=${result.plans.ana.status} honmei=${result.plans.honmei.status}`);
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
