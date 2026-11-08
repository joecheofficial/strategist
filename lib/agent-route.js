"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function installRoot() {
  if (process.env.ALLSORTED_ROOT) return path.resolve(process.env.ALLSORTED_ROOT);
  const home = path.resolve(process.env.STRATEGIST_HOME || path.join(__dirname, "../.."));
  const parent = path.dirname(home);
  // Keep standalone and installed lookup identical to checkin-cli locate().
  const isInstall = ["allsorted-dist.lock.json", path.join("bin", "as-run"), ".allsorted-update-runtime"].some(name => fs.existsSync(path.join(parent, name)));
  return isInstall ? parent : home;
}
function trustedHelper(file) {
  try {
    // Like resolveBinary, follow links and validate the real file and its parent.
    const real = fs.realpathSync(file);
    const stat = fs.statSync(real);
    const parent = fs.statSync(path.dirname(real));
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (stat.isFile() && !(stat.mode & 0o022) && [0, uid].includes(stat.uid) && !((parent.mode & 0o002) && !(parent.mode & 0o1000))) return real;
  } catch { /* Missing, unsafe or broken link. */ }
  throw new Error("The agent helper could not be loaded safely. Check your All Sorted installation and try again.");
}
function helper(root) {
  const runtime = path.join(root, ".allsorted-update-runtime/install/lib/agent-llm.js");
  try { fs.lstatSync(runtime); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return trustedHelper(path.join(__dirname, "agent-llm.js"));
  }
  return trustedHelper(runtime);
}
function run(prompt, probe = false) {
  if (process.env.STRATEGIST_OFFLINE === "1") return { ok: false, detail: "Offline test mode: no model call made." };
  let file;
  const root = installRoot();
  try { file = helper(root); }
  catch (error) { return { ok: false, detail: error.message }; }
  const result = spawnSync(process.execPath, [file, "--root", root, ...(probe ? ["--probe"] : [])], {
    input: probe ? "" : prompt, encoding: "utf8", timeout: 16 * 60 * 1000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || (!probe && !String(result.stdout || "").trim())) {
    const reason = String(result.stderr || "").trim().slice(0, 2000);
    return { ok: false, detail: result.error?.code === "ETIMEDOUT" ? "The agent request timed out. Try again when you are ready." : reason || "No signed-in agent CLI could answer. Open Claude Code, Codex or Antigravity and sign in, then try again." };
  }
  return { ok: true, text: String(result.stdout || "").trim() };
}
module.exports = { run, helper, installRoot };
