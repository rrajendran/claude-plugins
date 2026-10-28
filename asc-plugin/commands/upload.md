---
description: "Upload an .ipa or .pkg to App Store Connect (optionally validate first)"
argument-hint: "<file.ipa|file.pkg> [--validate]"
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/asc upload $ARGUMENTS`. If the user has not asked to skip it, run once with `--validate` first and only proceed to the real upload if validation passes. Then suggest `asc builds wait --number <N>`.
