import fetch from "node-fetch";

export const DISCORD_DESCRIPTION_MAX_LENGTH = 3500;

export function buildChunkedDiscordPayloads({
  baseTitle,
  content,
  summary,
  blocks = [],
  maxLength = DISCORD_DESCRIPTION_MAX_LENGTH,
  color = 3447003
}) {
  const chunkBodies = [];

  if (blocks.length === 0) {
    chunkBodies.push(summary);
  } else {
    let currentBody = summary;

    for (const block of blocks) {
      const addition = `${currentBody ? "\n\n" : ""}${block}`;
      if (`${currentBody}${addition}`.length > maxLength && currentBody) {
        chunkBodies.push(currentBody);
        currentBody = block;
        continue;
      }

      currentBody += addition;
    }

    if (currentBody) {
      chunkBodies.push(currentBody);
    }
  }

  return chunkBodies.map((description, index) => {
    const suffix = chunkBodies.length === 1 ? "" : ` (${index + 1}/${chunkBodies.length})`;
    return {
      content: `${content}${suffix}`,
      embeds: [
        {
          title: `${baseTitle}${suffix}`,
          description,
          color
        }
      ]
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function postWebhook(webhookUrl, payload) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        return;
      }

      let retryDelay = 1000;
      let responseBody = "";
      try {
        responseBody = await response.text();
        const parsed = responseBody ? JSON.parse(responseBody) : null;
        if (parsed && typeof parsed.retry_after === "number") {
          retryDelay = parsed.retry_after < 100 ? parsed.retry_after * 1000 : parsed.retry_after;
        }
      } catch {
        responseBody = responseBody || "";
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await sleep(retryDelay);
        continue;
      }

      throw new Error(`Discord webhook failed with status ${response.status}: ${responseBody || response.statusText}`);
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }

      await sleep(1000 * attempt);
    }
  }
}

export async function deliverDiscordPayloads({ webhookUrl, payloads, dryRun, logger = console }) {
  if (dryRun) {
    for (const payload of payloads) {
      logger.log(`[dry-run-payload] ${JSON.stringify(payload)}`);
    }
    return;
  }

  for (const payload of payloads) {
    await postWebhook(webhookUrl, payload);
  }
}
