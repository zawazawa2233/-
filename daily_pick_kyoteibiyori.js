import { runDailyPick } from "./lib/daily-pick.js";

runDailyPick().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
