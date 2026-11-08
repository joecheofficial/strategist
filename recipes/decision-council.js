"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STRATEGIST = path.resolve(__dirname, "..", "bin", "strategist.js");

function runRecipe(input = {}) {
  const decision = String(input.decision || input.question || "").trim();
  if (!decision) {
    return {
      status: "error",
      reply: "Tell Strategist what decision you are weighing so the council can frame it.",
      metadata: { code: "missing_decision", taskClass: "planning" },
    };
  }
  const env = { ...process.env };
  if (input.home) env.STRATEGIST_HOME = path.resolve(String(input.home));
  const result = spawnSync(process.execPath, [STRATEGIST, "decision", decision], { env, encoding: "utf8" });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    return {
      status: "error",
      reply: stderr || stdout || "Strategist could not frame the decision. Check the signed-in agent CLI.",
      metadata: { exitCode: result.status, taskClass: "planning" },
    };
  }
  return {
    status: "ok",
    reply: stdout || "Strategist's council framed the decision.",
    metadata: { taskClass: "planning" },
  };
}

module.exports = { runRecipe };
