# Your daily check-in

Once a day, at a time you choose, the Strategist sends you a short check-in: the two to four things that matter today, and only the other sections you asked for. By default it is an email to yourself. Nothing is sent to anyone else, ever.

## Set it up: the interview

Say "set up my daily check-in" to your AI assistant, or run this in a terminal and answer the questions:

```sh
node strategist/bin/strategist.js checkin interview
```

It asks six short things:

1. What you want to see. Any of: `priorities`, `money`, `pipeline`, `calendar`, `relationships`, `risks`.
2. What matters most to you right now, in a sentence or two.
3. What time it should arrive.
4. Your time zone.
5. Where it goes: `email` to yourself (the default), or `local`, kept on this computer and shown in Mission Control.
6. Which of your own email addresses.

Your answers are saved in `strategist/config/daily-checkin.json`. The daily job reads that file every day, so changing it changes the next check-in.

### For the AI assistant running the interview

Ask the six questions above one at a time, in plain words, and suggest the default for each. For the address, offer the owner address this install already knows (the email agent's `ownerEmail` or their connected Google account). Never pick an address that is not theirs. Then save every answer in one command:

```sh
node "<root>/strategist/bin/strategist.js" checkin interview --root "<root>" --sections "priorities,money,calendar,risks" --matters "<their words>" --time 07:30 --timezone "<their time zone>" --deliver email --to "<their own address>"
```

Read the output back to them: what they will see, when, and where. Then offer to make today's check-in now with `checkin run --now`. Do not turn on the metered API fallback unless they ask for it by name.

## Change it later

```sh
node strategist/bin/strategist.js checkin show                         # see your settings
node strategist/bin/strategist.js checkin set --to <your own address>     # another of your own addresses
node strategist/bin/strategist.js checkin set --deliver local          # keep it on this computer instead
node strategist/bin/strategist.js checkin set --time 08:00 --timezone America/New_York
node strategist/bin/strategist.js checkin set --sections priorities,pipeline,relationships
node strategist/bin/strategist.js checkin interview                    # all the questions again
node strategist/bin/strategist.js checkin off                          # stop it; your answers are kept
node strategist/bin/strategist.js checkin on                           # start it again
```

You can also edit `strategist/config/daily-checkin.json` by hand, then run `checkin on` so the new time is used.

## Where it goes

- **Email to yourself.** It uses the mail sender your install already has: the Resend module, with your own address as `ownerEmail` and a sender on your verified domain as `updateNotifications.from` in `email-agent/config/email-agent.config.json`. No new service or account. It only ever sends to an address this install knows is yours.
- **On this computer.** Every check-in is also saved in `strategist/briefs/checkin-YYYY-MM-DD.md` and shown in Mission Control under Memory. If email is not set up, or a send fails, this is where it goes, with a note on how to connect email.

## Who writes it

1. Manual and scheduled check-ins use All Sorted Dispatch. It tries the owner's `workingLLM` in `config/llm-defaults.json` first, then another signed-in CLI. `auto` means no preference.
2. Installed copies use the shared runtime. Standalone copies include the same runner. Tools and MCP are disabled, API keys are removed, and the typed reply must match the request hash.
3. The metered Anthropic API is used only if you turned it on (`checkin set --metered-api on`), with your own key from your private settings, and never more than your daily cap (at most 1 USD a day).
4. If no permitted route can answer, you get the data-only check-in, built from your files. It says why at the bottom.

Nothing fails silently: each run writes a receipt in `strategist/briefs/checkin-receipts/`.

## The daily job

On a Mac it is a launchd job named `ai.allsorted.strategist-checkin`. It is added only after you finish the interview, does nothing while the check-in is off, and is removed by `checkin off` or when the Strategist is uninstalled. Updates never turn it back on.

## Feed it

The check-in reads your Strategist files: `config/business.json`, your latest brief, and your pinned notes. Keep these current and the matching sections fill in:

- `notes/_90-day-plan.md` for Focus today. Keep this week's approved next actions as a short bullet list in priority order. Put the full plan in your project folder and refresh this list when the plan changes.
- `notes/_cash-received.md` for Money in. Add confirmed receipts as bullets with date, amount, currency, and source. Record each receipt once.
- `notes/_open-invoices.md` for Money on the table. Add unpaid items and their next action separately from money you already received. Older money notes still appear under Money notes to review until you classify their entries.
- `notes/_leads.md` for Pipeline
- `notes/_follow-ups.md` for People to follow up with
- `notes/_deadlines.md` for Risks

Calendar comes from your connected Google account, read only.

## First use

Strategist offers the setup interview once on first use. The reusable prompt is `prompts/checkin-interview.md`. Use `checkin decline` to leave setup for later; `checkin interview` always works. The post-install next-task list includes **Set up your daily check-in**.
