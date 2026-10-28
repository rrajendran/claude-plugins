---
description: "Generate .asc.json, ExportOptions plists and a metadata folder for this Xcode project"
argument-hint: "[--scheme S] [--bundle-id id] [--team TEAMID] [--platform ios|macos]"
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/asc init $ARGUMENTS` in the project root, then read the generated `.asc.json` and confirm app (bundle id), teamId, scheme and platform are right. If a value was not detected, ask the user rather than guessing. Remind them credentials are NOT stored in `.asc.json`.
