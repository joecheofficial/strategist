"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STRATEGIST = path.resolve(__dirname, "..", "bin", "strategist.js");

function runRecipe(input = {}) {
  const args = [STRATEGIST, "brief"];
  if (input.weekly || input.mode === "weekly") args.push("--weekly");
  if (input.printPrompt) args.push("--print-prompt");
  const env = { ...process.env };
  if (input.home) env.STRATEGIST_HOME = path.resolve(String(input.home));
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    return {
      status: "error",
      reply: stderr || stdout || "Strategist could not generate the brief. Run setup and check the signed-in agent CLI.",
      metadata: { exitCode: result.status, taskClass: "planning" },
    };
  }
  return {
    status: "ok",
    reply: stdout || "Strategist generated the brief.",
    metadata: { weekly: args.includes("--weekly"), promptOnly: args.includes("--print-prompt"), taskClass: "planning" },
  };
}

module.exports = { runRecipe };
