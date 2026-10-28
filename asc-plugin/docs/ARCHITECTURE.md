# Architecture & API coverage

## Layout

```
.claude-plugin/plugin.json        plugin manifest
.claude-plugin/marketplace.json   local marketplace so `claude plugin marketplace add <dir>` works
commands/*.md                     slash commands (/asc:readiness, /asc:ship, …) — thin prompts that call the CLI
skills/app-store-connect/SKILL.md when/how Claude should use the CLI, plus safety rules
bin/asc                           entry point
lib/client.mjs                    JWT (ES256) signing, fetch, retry/backoff, pagination, error formatting
lib/config.mjs                    config layering, credential validation
lib/core.mjs                      app/version/build resolvers shared by commands
lib/util.mjs                      arg helpers, tables, JSON:API payload builders, process runner
lib/cli.mjs                       arg parser, command registry, help + docs generator
lib/commands/*.mjs                one file per domain; each command is a plain object
test/asc.test.mjs                 mock-API tests
docs/                             this documentation (COMMANDS.md is generated)
```

## Design decisions

- **Zero dependencies.** Node's `crypto.sign('sha256', …, {dsaEncoding: 'ieee-p1363'})` produces the raw `r‖s` signature ES256 JWTs need, and `fetch` is built in. No install step, nothing to audit.
- **Commands are data.** `{ name, summary, usage, options, bool, run }`. Help, argument parsing and `docs/COMMANDS.md` are generated from the registry, so documentation cannot drift from behaviour.
- **Resolvers accept human references.** `--app` takes a numeric id, bundle id or name; `--version` takes a UUID, `1.2.3`, `latest` or `editable`; `--build` takes a UUID, build number or `latest`; groups take id or name.
- **Readiness checks are isolated.** Each check runs inside `Report.check`; an API error on one endpoint becomes a "could not verify" warning, not a crash.
- **Upload uses Apple's tool.** Binary delivery goes through `xcrun altool --upload-app` with the API key (the supported path for ipa/pkg); everything else is the REST API. Signing uses `xcodebuild … -allowProvisioningUpdates -authenticationKey*` so Xcode can manage certificates through the same key.
- **Secrets stay put.** The `.p8` is read only to sign a 15-minute JWT. The token is never logged. The user config is written with mode 600. `.asc.json` holds no credentials.

## Endpoint coverage

| Area | Endpoints used |
|---|---|
| Apps | `/v1/apps`, `/v1/apps/{id}` (PATCH) |
| Provisioning | `bundleIds`, `bundleIdCapabilities`, `certificates`, `devices`, `profiles` |
| Builds | `/v1/builds`, `preReleaseVersions`, `buildBetaDetails`, `betaBuildLocalizations` |
| App Store | `appStoreVersions` (+ build relationship, release requests, phased releases), `appStoreVersionLocalizations`, `appInfos`, `appInfoLocalizations`, `appCategories`, `ageRatingDeclarations`, `appScreenshotSets`, `appScreenshots`, `appStoreReviewDetails`, `reviewSubmissions`, `reviewSubmissionItems`, `appPriceSchedules`, `appPricePoints`, availability |
| TestFlight | `betaGroups` (+ builds relationship), `betaTesters`, `betaTesterInvitations`, `betaAppReviewSubmissions`, `betaAppLocalizations`, `betaAppReviewDetails`, `betaFeedbackScreenshotSubmissions` |
| Account | `users`, `userInvitations` |
| Anything else | `asc api` |

### Not covered (use `asc api` or the web UI)

Sales/finance reports, analytics reports, in-app purchases and subscriptions (catalog + pricing), Game Center, App Clips, Xcode Cloud, custom product pages, A/B tests, app events, paid price tiers (only `pricing set-free` is wrapped), app previews (videos), and App Privacy answers (not in the public API).

## Adding a command

1. Add an object to the relevant array in `lib/commands/*.mjs`:
   ```js
   { name: 'tf thing list', summary: 'One sentence.', usage: 'asc tf thing list …',
     options: [['--x', 'meaning']], bool: ['flag-without-value'],
     run: async (ctx) => { /* ctx.client, ctx.flags, ctx.args, ctx.cfg */ } }
   ```
2. Add a mock route and a test in `test/asc.test.mjs` if it has non-trivial logic.
3. `npm run docs`.

## Verification status

The JWT signer, HTTP client (retry, pagination, error formatting), argument parsing, config generation, destructive-action guards and the readiness report flow are covered by tests against a mock server. Individual endpoint payload shapes follow Apple's published API but were **not** exercised against a live account while this was built; the first real run of each write command should be treated as a smoke test (use `--verbose` to inspect traffic). Read-only commands and `readiness` are safe to run first.
