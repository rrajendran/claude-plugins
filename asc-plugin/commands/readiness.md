---
description: "Audit App Store / TestFlight readiness for the current project"
argument-hint: "[--platform ios|macos] [--only appstore|testflight|local]"
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/asc readiness $ARGUMENTS` from the project directory.

Then summarize the result for the user: group blocking failures (✘) first with the exact fix command shown in each line, then warnings (▲). Offer to fix the ones that are safe to automate (metadata, categories, export compliance, review contact). Never invent values for legal or contact fields (privacy URL, support URL, review phone/email, age-rating answers) — ask the user.
