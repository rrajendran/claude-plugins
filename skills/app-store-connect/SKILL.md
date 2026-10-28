---
name: app-store-connect
description: Use when the user wants to check App Store / TestFlight readiness, create release configs, upload a build, manage TestFlight testers or groups, edit App Store metadata or screenshots, or submit an app for review. Drives the `asc` CLI bundled with this plugin (App Store Connect API via a .p8 key).
---

# App Store Connect via `asc`

The CLI is `${CLAUDE_PLUGIN_ROOT}/bin/asc` (Node ≥ 20, no dependencies). It authenticates with an App Store Connect API key (`.p8`), key id and issuer id. Full reference: `${CLAUDE_PLUGIN_ROOT}/docs/COMMANDS.md`; `asc help [group]` prints the same.

## First: is it configured?

1. `asc config show` — keyPath, keyId, issuerId must all be set. Key id is inferred from `AuthKey_<ID>.p8`. The **issuer id** (a UUID) is the one thing that cannot be inferred: ask the user for it (App Store Connect → Users and Access → Integrations → App Store Connect API) and run `asc config set issuerId <uuid>`.
2. `asc auth check` — proves the credentials work. Fix this before anything else.
3. In a project: `asc init` creates `.asc.json` (app, platform, scheme, team, export options) so `--app` can be omitted.

Never print or cat the `.p8` file, and never put the issuer id/key in committed files.

## Which command for which intent

| Intent | Command |
|---|---|
| "Is my app ready?" | `asc readiness` (exit 1 = blockers; each line names the fix command) |
| Generate project/release configs | `asc init`, `asc metadata pull` |
| Fix listing gaps | `asc loc set`, `asc app-info set`, `asc age-rating set`, `asc apps set --content-rights …`, `asc review details set`, `asc screenshots upload`, `asc metadata push` |
| Provisioning | `asc bundle-ids …`, `asc certs …`, `asc devices …`, `asc profiles …` |
| Ship a build | `asc ship` (or `asc archive` → `asc export` → `asc upload` → `asc builds wait`) |
| TestFlight | `asc tf groups|testers|builds|whats-new|submit|status|info` |
| App Review | `asc versions create`, `asc versions set-build`, `asc review submit --yes`, `asc review status` |
| Anything not wrapped | `asc api GET|POST|PATCH|DELETE <path> [--data json]` |

## Rules of engagement

- **Read before write.** Run `readiness` / `list` / `show` commands first and base fixes on what is actually there.
- **Don't invent legal or contact content.** Privacy policy URL, support URL, review contact phone/email, demo credentials, age-rating answers, export-compliance answers and "What's New" text come from the user.
- **Confirm outward-facing actions** with the user before running them: `review submit`, `tf submit`, `tf testers add/invite`, `versions release`, `certs revoke`, `builds expire`, deleting anything. Destructive commands require `--yes`; do not add it until the user has agreed to that specific action.
- **Long jobs** (`ship`, `archive`, `builds wait`) can take 10–45 minutes — run them in the background.
- Build numbers must increase per app; `--build-number auto` uses (highest existing + 1).
- `--platform` matters for multi-platform apps (iOS + macOS have separate App Store versions).
- On `error: … HTTP 403` the API key role is too low (needs App Manager or Admin for most writes); on `401` check key id/issuer/clock.
- App Privacy "nutrition labels" and agreements/tax/banking are not exposed by the API — `readiness` lists them as manual items.
