---
description: "Archive, export, upload, wait for processing and distribute to TestFlight in one go"
argument-hint: "[--build-number auto|N] [--group names] [--submit-beta] [--attach]"
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/asc ship $ARGUMENTS`. This is a long-running command (archive + processing can take 10-40 minutes): run it in the background and report progress when it finishes. Before running, confirm with the user: the scheme/platform in `.asc.json`, the TestFlight groups, and whether `--submit-beta` (external beta review) is wanted — do not add that flag unprompted.
