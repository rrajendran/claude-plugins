# Getting started

## 1. Create an API key

App Store Connect → **Users and Access → Integrations → App Store Connect API → Team Keys → +**.

| Key role | Can do |
|---|---|
| **App Manager** (recommended) | Everything in this plugin except managing users/certificates for the whole team |
| **Admin** | Everything, including `users invite`, `certs`, `bundle-ids delete` |
| **Developer** | Upload builds, read most things; most metadata writes fail with 403 |
| **Customer Support / Marketing** | Not useful here |

Download the `.p8` immediately — Apple lets you download it once. Note the **Key ID** and the **Issuer ID** (top of the page).

## 2. Store the key safely

```sh
mkdir -p ~/.keys && chmod 700 ~/.keys
mv ~/Downloads/AuthKey_VBM5T6WP94.p8 ~/.keys/ && chmod 600 ~/.keys/AuthKey_VBM5T6WP94.p8
```

The directory needs the execute bit (`700`). With `600` on the directory nothing — not even you — can open files inside it, and `asc` will report `permission denied`.

Keep the key out of git. `asc init` adds `build/` and `.asc.env` to `.gitignore`; credentials are never written to `.asc.json`.

## 3. Tell `asc` about it

```sh
asc config set keyPath ~/.keys/AuthKey_VBM5T6WP94.p8
asc config set issuerId <your-issuer-uuid>
asc auth check
# ✔ Authenticated with key VBM5T6WP94 (1 app(s) visible)
```

The key id is read from the filename, so `keyId` rarely needs setting. If you keep exactly one `AuthKey_*.p8` in `~/.keys`, `~/.appstoreconnect/private_keys`, `~/.private_keys` or `~/private_keys`, `asc` finds it with no configuration at all.

## 4. Create the app record (one-time, web only)

The API cannot create an app record. In App Store Connect → **Apps → +  → New App**, choose the bundle ID (register it first with `asc bundle-ids create` if needed), name, primary language and SKU.

## 5. Initialise your project

```sh
cd ~/stash/xcode/karatly
asc init
```

Generates (without overwriting existing files unless `--force`):

```
.asc.json                               app, platform, scheme, teamId, buildDir, exportOptions, testflight defaults
asc/ExportOptions-appstore.plist        method app-store-connect, automatic signing
asc/ExportOptions-adhoc.plist           method release-testing
asc/ExportOptions-development.plist     method debugging
asc/testflight-whats-new.txt            "What to Test" text used by `asc ship`
asc/metadata/en-US/*.txt                description, keywords, whats_new, promotional_text, name, subtitle, URLs
```

Review `.asc.json` — especially `app` (bundle id), `teamId`, `scheme`, `platform`.

## 6. First audit

```sh
asc readiness
```

Each ✘ line ends with the command that fixes it. See [READINESS.md](READINESS.md).

## Using it from Claude Code

After installing the plugin, just ask: *"check if Karatly is ready for TestFlight"*, *"upload the latest build and add it to the Internal group"*, or use `/asc:readiness`, `/asc:ship`, `/asc:submit`. Claude is instructed (see `skills/app-store-connect/SKILL.md`) to read before writing, never invent legal/contact text, and ask before any outward-facing action.
