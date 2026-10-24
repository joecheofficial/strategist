# Strategist brain

Strategist turns scattered business context into one short decision document. It is not another place to collect ideas. It reads the current config, recent notes, previous briefs, and lessons, then decides what deserves attention now.

## The reasoning policy

The prompt files are the reasoning policy:

- `prompts/council-brief-prompt.md` runs the seven-persona council and defines the daily brief and weekly review.
- `prompts/focus-check-prompt.md` compares the current activity with today's priorities and gives one direct next step.

The council reasons from separate lenses before the chairman synthesizes. Facts stay separate from inference. Deadlines and money come before interesting side projects. Dissent stays visible when a council member disagrees.

## What the agent can do

- Generate a daily brief with three ranked priorities.
- Generate a weekly review with portfolio calls and next week's top three.
- Check whether the current activity matches today's brief.
- Write the full prompt when the local Claude command line tool is unavailable.
- Send one daily check-in, set up by a short interview (CHECKIN.md), to the owner's own email or keep it on this computer.

## Boundaries

Strategist is an advisor. It does not move money or change another system. The only message it ever sends is the daily check-in, to the owner's own address, and only after the owner set it up. It reads local files, calls the local Claude command line tool when available, and writes Markdown files inside `briefs/`.

The output is short on purpose. The point is not more analysis. The point is a clearer next action.
