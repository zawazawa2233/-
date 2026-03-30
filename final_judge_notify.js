import { runFinalJudge } from "./lib/final-judge.js";

runFinalJudge().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
