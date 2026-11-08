"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STRATEGIST = path.resolve(__dirname, "..", "bin", "strategist.js");

function runRecipe(input = {}) {
  const items = String(input.items || input.list || "").trim();
  const env = { ...process.env };
  if (input.home) env.STRATEGIST_HOME = path.resolve(String(input.home));
  const result = spawnSync(process.execPath, [STRATEGIST, "triage", items], { env, encoding: "utf8" });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    return {
      status: "error",
      reply: stderr || stdout || "Strategist could not triage the priorities. Check the signed-in agent CLI.",
      metadata: { exitCode: result.status, taskClass: "planning" },
    };
  }
  return {
    status: "ok",
    reply: stdout || "Strategist triaged the priorities.",
    metadata: { taskClass: "planning" },
  };
}

module.exports = { runRecipe };
