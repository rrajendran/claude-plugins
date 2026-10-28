---
description: "Submit the editable App Store version for App Review (runs readiness first)"
argument-hint: "[--version latest]"
---

Submitting to App Review is outward-facing. Steps:
1. Run `${CLAUDE_PLUGIN_ROOT}/bin/asc readiness --only appstore`. If anything is blocking (✘), stop and report it — do not submit.
2. Show the user the version and build that will be sent and ask for explicit confirmation.
3. Only after a clear yes, run `${CLAUDE_PLUGIN_ROOT}/bin/asc review submit --yes $ARGUMENTS`.
