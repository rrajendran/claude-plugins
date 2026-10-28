# Troubleshooting

## Authentication

| Symptom | Cause / fix |
|---|---|
| `Cannot read …p8: permission denied` | The key **directory** lacks the execute bit: `chmod 700 ~/.keys && chmod 600 ~/.keys/AuthKey_*.p8` |
| `Private key not found` | Wrong `keyPath`. `asc config show` |
| `Missing credentials: issuer id` | `asc config set issuerId <uuid>` (App Store Connect → Integrations) |
| `HTTP 401 NOT_AUTHORIZED` | Wrong key id or issuer id, key revoked, or system clock off by more than a few minutes. Check `date`. |
| `HTTP 403 FORBIDDEN_ERROR` | The key's role is too low for that endpoint (needs App Manager/Admin), or an agreement is unsigned (web UI → Business). |
| `Could not sign JWT` | The file isn't a PKCS#8 EC `.p8` from Apple (don't open and re-save it). |

`asc auth check --verbose` shows each request. `asc auth token` prints a JWT you can use with curl:

```sh
curl -H "Authorization: Bearer $(asc auth token)" https://api.appstoreconnect.apple.com/v1/apps
```

## Building and uploading

| Symptom | Fix |
|---|---|
| `No Xcode project configured` | Run `asc init` in the project root, or pass `--project/--workspace --scheme` |
| `conflicting provisioning settings … Apple Distribution has been manually specified` | Automatic signing + a pinned Distribution identity in Release. Set `"archiveSigningIdentity": "Apple Development"` in `.asc.json` (or `--archive-identity`): it archives with the dev identity and the export step re-signs for distribution |
| Archive fails with signing errors | Ensure the `teamId` in `.asc.json` is right and the bundle id is registered; the API key needs Admin/App Manager for cloud signing |
| `No profiles for 'x' were found` | `-allowProvisioningUpdates` needs the API key to have access; or register the bundle id (`asc bundle-ids create`) and enable required capabilities (`asc bundle-ids enable`) |
| `altool` "Unable to authenticate" | The key file name must be `AuthKey_<keyId>.p8` (asc handles a mismatch via symlink); recheck issuer id |
| macOS: `Invalid Code Signing … Realm_Realm.bundle must be signed with the certificate that is contained in the provisioning profile` (after upload, by email/`altool --build-status`) | SwiftPM resource bundles keep the development signature from the archive. `asc export` now strips them automatically when `archiveSigningIdentity` is set. `asc upload --validate` does **not** catch this; `asc ship` now reads Apple's delivery status and stops with the reason. |
| `upload` succeeded but build never appears | Processing takes 5–30 min, and invalid binaries fail by **email** with the reason. `asc builds wait --number N` |
| `ITMS-90683 missing purpose string` etc. | Fix Info.plist usage-description keys; re-archive with a new build number |
| Build number rejected / duplicate | Build numbers must increase per marketing version; `asc builds next-number` |
| macOS export finds no artifact | App Store macOS exports produce `.pkg`; check `asc/ExportOptions-appstore.plist` `method` |

## Metadata and review

| Symptom | Fix |
|---|---|
| `whatsNew` rejected on first version | Apple disallows it for v1.0 — leave `whats_new.txt` empty |
| `STATE_ERROR` when editing | The version isn't editable (e.g. `WAITING_FOR_REVIEW`). `asc review cancel <id>` or create a new version |
| Keywords error | ≤ 100 characters total, comma-separated, no spaces after commas needed |
| Screenshot stuck `AWAITING_UPLOAD` / FAILED | Wrong dimensions for the display type. Delete (`asc screenshots delete`) and re-upload at the exact size |
| `review submit` fails with missing items | Run `asc readiness --only appstore`; also check App Privacy in the web UI |
| 409 on `review submit` | An open submission already contains the version; `asc review status` |

## TestFlight

| Symptom | Fix |
|---|---|
| Testers don't see the build | Add it to their group: `asc tf builds add`; external groups need `asc tf submit` first |
| `tf review-contact set` says no record | Fill "Test Information" once in the web UI, then update via CLI |
| Build `MISSING_EXPORT_COMPLIANCE` | `asc builds encryption latest --uses-encryption false` |

## General

- Add `--verbose` to see every request and body.
- Rate limits (`429`) are retried automatically with backoff (honours `Retry-After`).
- Anything the CLI lacks can be done with `asc api`; see Apple's [App Store Connect API docs](https://developer.apple.com/documentation/appstoreconnectapi).
- Apple occasionally renames API fields (for example `appStoreState` → `appVersionState`). `asc` reads both; if a command breaks after an Apple change, `asc api GET <path>` shows the live shape, and the fix is usually one attribute name in `lib/commands/`.
