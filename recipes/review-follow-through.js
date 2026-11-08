"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STRATEGIST = path.resolve(__dirname, "..", "bin", "strategist.js");

function runRecipe(input = {}) {
  const env = { ...process.env };
  if (input.home) env.STRATEGIST_HOME = path.resolve(String(input.home));
  const result = spawnSync(process.execPath, [STRATEGIST, "review"], { env, encoding: "utf8" });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    return {
      status: "error",
      reply: stderr || stdout || "Strategist could not review follow-through. Check the signed-in agent CLI.",
      metadata: { exitCode: result.status, taskClass: "planning" },
    };
  }
  return {
    status: "ok",
    reply: stdout || "Strategist reviewed follow-through on recent priorities.",
    metadata: { taskClass: "planning" },
  };
}

module.exports = { runRecipe };
