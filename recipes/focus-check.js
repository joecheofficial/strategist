"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STRATEGIST = path.resolve(__dirname, "..", "bin", "strategist.js");

function runRecipe(input = {}) {
  const activity = String(input.activity || "").trim();
  if (!activity) {
    return {
      status: "error",
      reply: "Tell Strategist what you are doing so it can compare the activity with today's priorities.",
      metadata: { code: "missing_activity", taskClass: "planning" },
    };
  }
  const env = { ...process.env };
  if (input.home) env.STRATEGIST_HOME = path.resolve(String(input.home));
  const result = spawnSync(process.execPath, [STRATEGIST, "focus", activity], { env, encoding: "utf8" });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    return {
      status: "error",
      reply: stderr || stdout || "Strategist could not run the focus check. Check the signed-in agent CLI.",
      metadata: { exitCode: result.status, taskClass: "planning" },
    };
  }
  return {
    status: "ok",
    reply: stdout || "Strategist completed the focus check.",
    metadata: { taskClass: "planning" },
  };
}

module.exports = { runRecipe };
