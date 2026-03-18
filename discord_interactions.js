import { createPublicKey, verify as verifySignature } from "node:crypto";
import http from "node:http";

import fetch from "node-fetch";

import { queryKaime } from "./lib/kaime-service.js";

const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const INTERACTION_RESPONSE_PONG = 1;
const INTERACTION_RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const EPHEMERAL_FLAG = 64;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function loadConfig() {
  const publicKey = process.env.DISCORD_PUBLIC_KEY?.trim() || "";
  const applicationId = process.env.DISCORD_APPLICATION_ID?.trim() || "";
  const port = Number.parseInt(process.env.PORT || process.env.DISCORD_INTERACTIONS_PORT || "3000", 10);

  if (!publicKey) {
    throw new Error("DISCORD_PUBLIC_KEY is required");
  }
  if (!applicationId) {
    throw new Error("DISCORD_APPLICATION_ID is required");
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  return {
    publicKey,
    applicationId,
    port
  };
}

function createEd25519PublicKey(hex) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki"
  });
}

function isValidSignature(config, body, signature, timestamp) {
  if (!signature || !timestamp) {
    return false;
  }

  const publicKey = createEd25519PublicKey(config.publicKey);
  return verifySignature(
    null,
    Buffer.from(`${timestamp}${body}`),
    publicKey,
    Buffer.from(signature, "hex")
  );
}

function parseOptions(interaction) {
  const options = new Map(
    (interaction.data?.options || []).map((option) => [option.name, option.value])
  );

  return {
    placeName: typeof options.get("place") === "string" ? options.get("place") : "",
    raceNo: typeof options.get("race") === "number" ? options.get("race") : null,
    hiduke: typeof options.get("date") === "string" ? options.get("date") : undefined
  };
}

function trimMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

async function patchOriginalMessage({ applicationId, token, content }) {
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: trimMessage(content)
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to update Discord interaction response: HTTP ${response.status} ${body}`);
  }
}

async function handleKaimeCommand(config, interaction) {
  const { placeName, raceNo, hiduke } = parseOptions(interaction);

  try {
    const result = await queryKaime({
      hiduke,
      placeName,
      raceNo
    });

    await patchOriginalMessage({
      applicationId: config.applicationId,
      token: interaction.token,
      content: result.text
    });
  } catch (error) {
    await patchOriginalMessage({
      applicationId: config.applicationId,
      token: interaction.token,
      content: `見送り: ${error.message}`
    }).catch(() => {});
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const config = loadConfig();

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const body = await readRequestBody(request);
    const signature = request.headers["x-signature-ed25519"];
    const timestamp = request.headers["x-signature-timestamp"];

    if (
      typeof signature !== "string" ||
      typeof timestamp !== "string" ||
      !isValidSignature(config, body, signature, timestamp)
    ) {
      writeJson(response, 401, { error: "Invalid request signature" });
      return;
    }

    const interaction = JSON.parse(body);

    if (interaction.type === INTERACTION_PING) {
      writeJson(response, 200, { type: INTERACTION_RESPONSE_PONG });
      return;
    }

    if (
      interaction.type !== INTERACTION_APPLICATION_COMMAND ||
      interaction.data?.name !== "kaime"
    ) {
      writeJson(response, 400, { error: "Unsupported interaction" });
      return;
    }

    writeJson(response, 200, {
      type: INTERACTION_RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: EPHEMERAL_FLAG
      }
    });

    handleKaimeCommand(config, interaction).catch((error) => {
      console.error(`[interaction-failed] ${error.stack || error.message}`);
    });
  });

  server.listen(config.port, () => {
    console.log(`[start] discord interactions server listening on :${config.port}`);
  });
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
