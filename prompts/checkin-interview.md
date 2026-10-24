# Set up your daily check-in

Ask one question at a time. Use existing saved answers as defaults. Never guess an answer or enable a daily job without the customer's agreement.

1. What should the check-in cover: priorities, money, pipeline, calendar, relationships or risks?
2. What matters most right now?
3. What time should it arrive, in 24-hour format?
4. Which time zone?
5. Email to yourself, or save it on this computer?
6. If email, which of your own verified addresses?

Read CHECKIN.md. Save agreed answers with `checkin interview --root "<root>" --sections "<sections>" --matters "<answer>" --time "<HH:MM>" --timezone "<zone>" --deliver local`. For email, replace local with email and add `--to "<own address>"`. Use the installed Strategist CLI through bin/as-run. Never type placeholders literally.

Read back the saved settings and the schedule result. A login problem leaves a data-only check-in and a notice. Metered API stays off unless explicitly requested, with a maximum daily cap of $1. No new account or API key is needed for native Claude Code or Codex sign-in.

If declined, run `checkin decline --root "<root>"`. Explain that "set up my daily check-in" works any time. Offer `checkin run --now` only after setup. No mail to anyone except the customer's own address.
