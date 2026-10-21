# Strategist

A daily chief-of-staff for your business. Every morning it reads what you told it about your business, plus any notes you dropped in, convenes a council of seven world-class strategy thinkers (via Claude Code), and hands you one short brief: the three things that matter today, what is at risk, where the money is, and whether you are drifting off mission.

## What it actually does

Running a business means holding too much in your head. The Strategist takes that job. You describe your business once in a small config file. Each day you (optionally) drop quick notes about what happened. Then one command produces a brief with exactly these sections:

- Top 3 Today: the highest-leverage moves, ranked by money and time-sensitivity
- Follow-Through: whether the last Top 3 actually moved, stalled, or became a carried item that must be resolved
- Risk Radar: relationships and deadlines going stale
- Money Radar: money owed, leaking, or on the table
- Stuck On You vs Stuck On Others: what only you can unblock, and who to nudge
- Mission Check: one honest line about whether you are drifting
- Council verdict: a score out of 10, with disagreement preserved, not averaged away

The council is seven personas with distinct lenses: Ray Dalio (truth and synthesis), Alex Hormozi (offers), April Dunford (positioning), Roger Martin (where to play), Rita McGrath (when to cut), Charlie Munger (inversion and risk), and Greg McKeown (essential focus). Each reasons alone first, then the chairman synthesizes.

It is an advisor, not a doer. It never sends messages, never touches money, never calls any online service itself. The only thing it runs is the Claude Code command on your own machine, and the only thing it writes is a Markdown file in your briefs folder.

## Install

You need [Node.js](https://nodejs.org) and [Claude Code](https://claude.com/claude-code) installed. Then, from this folder:

```bash
node bin/strategist.js setup
```

Open `config/business.json` and replace every example value with the truth about your business, your mission, your goals, and your active projects. The brief is only as sharp as this file. Blunt honesty in, blunt clarity out.

## Daily use

```bash
node bin/strategist.js brief            # today's brief
node bin/strategist.js brief --weekly   # weekly portfolio review instead
node bin/strategist.js focus "rewriting the proposal"  # mid-day drift check
node bin/strategist.js triage "send the referral page; chase invoice 042; prep podcast pitch"  # rank a raw list
node bin/strategist.js decision "should I raise prices 20% for new members"  # frame a call with the council
node bin/strategist.js review           # audit whether recent Top 3 priorities actually moved
node bin/strategist.js check            # confirm config and setup are healthy
```

Briefs are saved to `briefs/YYYY-MM-DD.md`. If the `claude` command is not installed, the tool writes the full prompt to a file instead and tells you to paste it into Claude yourself. Same brief, one extra step.

`focus` prints a short, mid-day verdict: `ON TRACK`, `DRIFTING`, or `RABBIT HOLE`, tied to today's Top 3. It writes no brief on success. If no brief exists today, it assesses the current activity against the mission in your business config.

`triage` takes a semicolon- or newline-separated list of candidate priorities and ranks them by money impact and time-sensitivity against your business config. Useful when you have a pile of things and no idea which one actually matters today. Leave it empty and it triages from your config's goals, money watch, and active projects instead.

`decision` brings one specific decision to the same seven-persona council used for the daily brief, but scoped to just that call. Each persona gives a one-line take, the chairman synthesizes a recommendation with a confidence score, and dissent is preserved rather than averaged away.

`review` audits your recent briefs on their own, without generating a new one: which Top 3 items actually moved, which are being carried forward without progress, and whether that's becoming a pattern. Needs at least two previous briefs to say anything useful.

## Feeding it context

Two habits make the briefs dramatically better:

1. **Notes.** Drop short `.md` or `.txt` files into `notes/`: what happened, what you are worried about, what a client said. The five most recent notes are read before every brief (up to 8,000 characters each, so standing corrections at the end of a long note still count).

   **Pinned notes.** A note whose name starts with an underscore, such as `notes/_leads.md`, `notes/_open-invoices.md` or `notes/_revenue-scorecard.md`, is a pinned note: a live state file you or your agents keep current. Every pinned note is read before every brief, in name order, even on days it did not change, and the council treats it as current fact. Pinned notes are read up to 4,000 characters each, so keep them to the current state rather than a running history.

2. **Brief memory.** The three most recent briefs are read newest first. The council compares their Top 3 lists to today's facts, so recurring priorities cannot quietly roll forward forever.

Keep `config/business.json` current as your goals shift. The council scores time-boxed mission goals above everything else, so give your goals real dates.

## Automating it

To get the brief every morning without running anything, add a scheduled job. On a Mac or Linux machine, ask Claude Code to "schedule strategist brief daily at 7am" from this folder, or add a cron line yourself:

```
0 7 * * * node /path/to/strategist/bin/strategist.js brief >> /path/to/strategist/briefs/cron.log 2>&1
```

## Privacy

Everything stays on your machine: your config, your notes, your briefs. The business context is sent to Claude only when a brief is generated, through your own Claude Code login, under your own account.

## License

Personal Use License. You can use this for yourself, but you cannot resell it, share it, or use it in any commercial service. If you need to use it commercially, reach out through the distributor listed with your copy and we can figure out something that makes sense. See LICENSE for the full terms.

## Updates

This updates itself every week from this repo. Before it changes anything it backs up your own files, and if the self-test fails after an update it rolls back to the version you had. Your own files (config, notes, brand files, data) are never overwritten.

```
node scripts/self-update.js --status   # see the setting and the last check
node scripts/self-update.js --now      # check and update right now
node scripts/self-update.js --off      # turn weekly updates off
node scripts/self-update.js --on       # turn them back on
node scripts/self-update.js --realign  # only if it tells you to (see below)
```

### If the update says your copy "has its own commits"

In early October 2026 this repo's published history was rewritten once (the same files, with the author details on the old commits changed). A copy cloned before that still holds the old versions of those commits, so a plain update cannot move it forward and used to report "has your own commits" every week.

The updater now recognises that exact case: when every commit only your copy has is an old copy of one of this project's commits, and your files match the project exactly, it says so and offers a safe realignment:

```
node scripts/self-update.js --realign
```

That keeps your old history on a backup branch (`allsorted-backup/pre-realign-<date>`), backs up your config, notes and other personal files, moves your copy onto the current history without changing a single file, then updates normally (self-test and roll back included). Your `config/`, `notes/` and `briefs/` files are never touched.

If your copy is too old to have `scripts/self-update.js`, or you prefer to do it by hand, this is the same thing in four commands, run from this folder:

```
git status                                        # must show no changed tracked files
git branch allsorted-backup/pre-realign HEAD      # keep your old history
git fetch origin
git reset --keep origin/main                      # your untracked config, notes and briefs stay put
```

If you made commits of your own, the updater will not offer a realignment. Keep them on a branch (`git branch my-changes`) and ask your agent to re-apply them on top of `origin/main`.
