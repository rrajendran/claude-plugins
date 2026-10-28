# asc — App Store Connect plugin for Claude Code

A zero-dependency Node CLI (`asc`) that talks to the App Store Connect API with your `.p8` key, wrapped as a Claude Code plugin (slash commands + a skill) so you can say *"is Karatly ready for review?"* and have it checked, fixed and shipped.

| Capability | Commands |
|---|---|
| **Readiness audit** | `asc readiness` — dozens of checks across local toolchain, listing, build, screenshots, review, pricing, TestFlight |
| **Create all the configs** | `asc init` (`.asc.json`, ExportOptions plists, metadata folder) · `asc metadata pull/push` · `bundle-ids` · `certs` · `devices` · `profiles` · `app-info` · `age-rating` · `loc` |
| **Upload to App Store Connect** | `asc upload` · `asc archive` · `asc export` · `asc ship` (archive → export → upload → wait → TestFlight) |
| **TestFlight** | `asc tf groups / testers / builds / whats-new / submit / status / info / review-contact / feedback` |
| **Release** | `asc versions` · `asc screenshots` · `asc review details/submit/status/cancel` · `asc pricing` |
| **Everything else** | `asc api <METHOD> <path>` — raw authenticated access to every endpoint |

84 commands. Full reference: [docs/COMMANDS.md](docs/COMMANDS.md).

## Install

Requires Node ≥ 20 and Xcode (for `archive`/`export`/`upload`). No `npm install` needed.

**As a Claude Code plugin**

```sh
claude plugin marketplace add ~/stash/xcode/asc-plugin
claude plugin install asc@asc-local
```

Then use `/asc:readiness`, `/asc:init`, `/asc:upload`, `/asc:ship`, `/asc:testflight`, `/asc:status`, `/asc:metadata`, `/asc:submit`, `/asc:help`. Or try it without installing: `claude --plugin-dir ~/stash/xcode/asc-plugin`.

**As a plain CLI**

```sh
ln -s ~/stash/xcode/asc-plugin/bin/asc /usr/local/bin/asc   # or any dir on PATH
asc help
```

## Configure credentials (once)

You need three things from App Store Connect → *Users and Access → Integrations → App Store Connect API*:

| Value | Where it comes from |
|---|---|
| Private key `.p8` | Downloaded once. Default location used here: `~/.keys/AuthKey_VBM5T6WP94.p8` |
| Key ID | Inferred from the filename (`VBM5T6WP94`) |
| Issuer ID | UUID shown at the top of that page — **must be provided** |

```sh
chmod 700 ~/.keys && chmod 600 ~/.keys/AuthKey_VBM5T6WP94.p8   # directory needs the x bit
asc config set keyPath ~/.keys/AuthKey_VBM5T6WP94.p8
asc config set issuerId 00000000-0000-0000-0000-000000000000
asc auth check
```

Credentials are stored in `~/.config/asc-plugin/config.json` (mode 600) or supplied via `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID`. The key file is only ever read to sign short-lived (15 min) JWTs; it is never printed, copied or uploaded. Details: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## 60-second tour

```sh
cd ~/stash/xcode/karatly
asc init                      # detects project/scheme/bundle id/team → .asc.json + ExportOptions plists
asc readiness                 # what's blocking TestFlight / the App Store?
asc ship --group "Internal"   # archive, export, upload, wait for processing, add to TestFlight
asc readiness --only appstore # remaining listing gaps
asc review submit --yes       # send to App Review
```

## Documentation

- [Getting started](docs/GETTING_STARTED.md) — credentials, first run, API key roles
- [Configuration](docs/CONFIGURATION.md) — `.asc.json`, env vars, precedence, ExportOptions
- [Workflows](docs/WORKFLOWS.md) — first release, updates, TestFlight, metadata-as-code, CI
- [Readiness checks](docs/READINESS.md) — every check, what it means, how to fix it
- [Command reference](docs/COMMANDS.md) — generated from the code (`npm run docs`)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Architecture & API coverage](docs/ARCHITECTURE.md)

## Safety model

- Read-only commands never mutate anything. `readiness` is read-only.
- Destructive or outward-facing commands (`review submit`, `certs revoke`, `builds expire`, `*delete`, `*remove`) refuse to run without `--yes`; the slash commands additionally make Claude ask you first.
- `metadata push` skips empty files, so it can never blank out a remote value, and supports `--dry-run`.
- `--verbose` logs every request (never the token) to stderr.

## Development

```sh
npm test        # 9 tests: JWT validity, pagination, errors, CLI end-to-end against a mock API
npm run docs    # regenerate docs/COMMANDS.md
```

Tests run against a local mock server with a throwaway key — they never touch your account or real key.
