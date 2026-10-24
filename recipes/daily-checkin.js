"use strict";

const path = require("node:path");
const config = require("../lib/checkin-config");

// Read-only: what the daily check-in is set to, and how to set it up or change it.
const PKG_ROOT = path.resolve(__dirname, "..");

module.exports.runRecipe = async function runRecipe(input = {}) {
  const home = input.home ? path.resolve(String(input.home)) : process.env.STRATEGIST_HOME || PKG_ROOT;
  let cfg = null;
  try { cfg = config.readConfig(home); } catch (error) { return { status: "error", reply: error.message }; }
  const guide = "Interview and change steps: " + path.join(PKG_ROOT, "prompts", "checkin-interview.md");
  if (!config.isComplete(cfg)) {
    return {
      status: "ok",
      reply: ["The daily check-in is not set up yet.", "Run the interview: node strategist/bin/strategist.js checkin interview", guide].join("\n"),
      metadata: { configured: false, taskClass: "planning" },
    };
  }
  return {
    status: "ok",
    reply: [config.describe(cfg), guide].join("\n"),
    metadata: { configured: true, enabled: cfg.enabled === true, delivery: cfg.delivery.method, taskClass: "planning" },
  };
};
