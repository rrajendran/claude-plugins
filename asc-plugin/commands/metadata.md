---
description: "Pull or push localized App Store metadata as plain text files"
argument-hint: "pull|push [--dir asc/metadata] [--dry-run]"
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/asc metadata $ARGUMENTS`. For `push`, always do `--dry-run` first, show the user which locales/fields will change, and only then push for real. Empty files are skipped by design (they never erase remote values).
