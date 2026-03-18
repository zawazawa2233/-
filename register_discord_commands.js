import fetch from "node-fetch";

function loadConfig() {
  const applicationId = process.env.DISCORD_APPLICATION_ID?.trim() || "";
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim() || "";
  const guildId = process.env.DISCORD_GUILD_ID?.trim() || "";

  if (!applicationId) {
    throw new Error("DISCORD_APPLICATION_ID is required");
  }
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  return {
    applicationId,
    botToken,
    guildId
  };
}

function buildCommandDefinition() {
  return [
    {
      name: "kaime",
      description: "条件一致レースの買い目案を返す",
      options: [
        {
          type: 3,
          name: "place",
          description: "レース場名 例: 大村",
          required: true
        },
        {
          type: 4,
          name: "race",
          description: "レース番号 1-12",
          required: true,
          min_value: 1,
          max_value: 12
        },
        {
          type: 3,
          name: "date",
          description: "日付 YYYYMMDD 省略時は今日",
          required: false
        }
      ]
    }
  ];
}

async function main() {
  const config = loadConfig();
  const scopePath = config.guildId
    ? `/applications/${config.applicationId}/guilds/${config.guildId}/commands`
    : `/applications/${config.applicationId}/commands`;

  const response = await fetch(`https://discord.com/api/v10${scopePath}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${config.botToken}`
    },
    body: JSON.stringify(buildCommandDefinition())
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to register commands: HTTP ${response.status} ${body}`);
  }

  const commands = await response.json();
  console.log(`[done] registered=${Array.isArray(commands) ? commands.length : 0} scope=${config.guildId ? `guild:${config.guildId}` : "global"}`);
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
