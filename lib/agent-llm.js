"use strict";

const fs = require("node:fs");
const path = require("node:path");
const adapter = require("./cli-provider-adapter");

const NO_LOGIN = "No signed-in agent CLI could answer. Open Claude Code, Codex or Antigravity and sign in, then try again.";

function preference(root) {
  try {
    const defaults = JSON.parse(fs.readFileSync(path.join(root, "config", "llm-defaults.json"), "utf8"));
    const working = typeof defaults.workingLLM === "string" ? defaults.workingLLM.trim().toLowerCase() : "auto";
    return { claude: "claude-code", codex: "codex", antigravity: "antigravity" }[working];
  } catch { return undefined; }
}

const AGENT_TIMEOUT_MS = 16 * 60 * 1000;
const SAFETY_REFUSAL = "The agent provider could not run with its safety settings. Check the provider settings and try again.";

function routeSettings(root, options) {
  const provider = preference(root);
  return { ...options, provider, hostEnv: { ALLSORTED_UPDATE_UNATTENDED: "1" } };
}

async function choose(root, options = {}) {
  return adapter.choose(routeSettings(root, options));
}

async function ask(root, prompt, options = {}) {
  if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 126 * 1024) throw new Error("Agent input is empty or too large");
  const timeoutMs = options.timeoutMs == null ? AGENT_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Agent time limit must be a positive number");
  const deadline = Date.now() + timeoutMs;
  const settings = routeSettings(root, options);
  let chosen = await choose(root, options);
  let refused = chosen.refused || chosen.priorRefusal;
  const tried = new Set();
  while (chosen.ok && !tried.has(chosen.provider)) {
    tried.add(chosen.provider);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("The agent request timed out. Try again when you are ready.");
    try {
      return (await adapter.invokeAgentText({ ...settings, timeoutMs: remaining, chosen, provider: chosen.provider, model: settings.provider === chosen.provider ? options.model : undefined }, prompt)).text;
    } catch (error) {
      // Only a failed start or expired login permits another provider to receive the prompt.
      if (!["CLI_START_FAILED", "CLI_LOGIN_FAILED"].includes(error.code)) throw error;
    }
    chosen = { ok: false };
    for (const provider of adapter.PROVIDERS) {
      if (tried.has(provider)) continue;
      if (Date.now() >= deadline) throw new Error("The agent request timed out. Try again when you are ready.");
      const next = await adapter.probe(provider, settings);
      if (next.refused) refused = true;
      if (next.ok) { chosen = next; break; }
    }
  }
  if (refused) throw new Error(SAFETY_REFUSAL);
  throw new Error(NO_LOGIN);
}

async function main(argv) {
  let root;
  let probe = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) root = path.resolve(argv[++i]);
    else if (argv[i] === "--probe") probe = true;
    else throw new Error("Use --root followed by your All Sorted folder");
  }
  if (!root) throw new Error("Use --root followed by your All Sorted folder");
  if (probe) {
    const chosen = await choose(root);
    if (!chosen.ok) throw new Error(chosen.refused ? SAFETY_REFUSAL : NO_LOGIN);
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 126 * 1024) throw new Error("Agent input is too large");
    chunks.push(chunk);
  }
  process.stdout.write(await ask(root, Buffer.concat(chunks).toString("utf8")));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { ask, choose, preference };
