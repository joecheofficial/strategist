"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Zero-network configuration check. This module needs no API key and no
// account: it calls the local `claude` command line tool and reads local files.
//
// The one environment variable the shipped code reads is STRATEGIST_HOME
// (bin/strategist.js home()), which relocates the folder holding
// config/business.json, notes, and briefs. It defaults to the installed
// package folder.
//
// The real "is this configured" question is whether config/business.json
// exists and has been filled in, which is what cmdCheck() in bin/strategist.js
// validates. This check applies the same two rules on the two required fields
// without spawning anything, so it never runs the command line tool and never
// writes a brief.
const PKG_ROOT = path.resolve(__dirname, "..");

function homeDir(input) {
  if (input.home) return path.resolve(String(input.home));
  return process.env.STRATEGIST_HOME || PKG_ROOT;
}

module.exports.runRecipe = async function runRecipe(input = {}) {
  const home = homeDir(input);
  const checkin = require("../lib/checkin-cli");
  const offer = checkin.offer(checkin.locate(home, input.root));
  const configPath = path.join(home, "config", "business.json");
  const overridden = Boolean(process.env.STRATEGIST_HOME);

  if (!fs.existsSync(configPath)) {
    return {
      status: "ok",
      reply: [
        offer,
        "Not configured yet.",
        "",
        "Credentials required: none. It uses your local Claude command line tool, not an API key.",
        `Home folder: ${home}${overridden ? " (set by STRATEGIST_HOME)" : " (default)"}`,
        `Business config: missing at ${configPath}`,
        "",
        "Run the setup command to create the starter config, then fill in your name and your business name.",
      ].join("\n"),
      metadata: { taskClass: "planning", configured: false, network: false, requiredCredentials: [], home, homeFromEnvironment: overridden, configPath, configPresent: false, problems: ["business config is missing"] },
    };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    return {
      status: "error",
      reply: `The business config at ${configPath} is not valid JSON: ${error.message}`,
      metadata: { taskClass: "planning", configured: false, network: false, configPath, configPresent: true },
    };
  }

  const problems = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) problems.push("config is not a JSON object");
  else {
    if (!config.owner || /your name/i.test(String(config.owner))) problems.push("owner: still the placeholder, put your actual name in config/business.json");
    if (!config.business || !config.business.name) problems.push("business.name: describe your business in config/business.json");
  }

  const configured = problems.length === 0;

  return {
    status: "ok",
    reply: [
      offer,
      configured ? "Ready to use." : "Configured, but the business config needs attention.",
      "",
      "Credentials required: none. It uses your local Claude command line tool, not an API key.",
      `Home folder: ${home}${overridden ? " (set by STRATEGIST_HOME)" : " (default)"}`,
      `Business config: ${configPath}`,
      configured ? "Business config: ok" : `Business config problems:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
      "",
      "This check read local files only. It ran no command line tool, called no network, and wrote no brief.",
    ].join("\n"),
    metadata: {
      taskClass: "planning",
      configured,
      network: false,
      requiredCredentials: [],
      home,
      homeFromEnvironment: overridden,
      configPath,
      configPresent: true,
      problems,
    },
  };
};
