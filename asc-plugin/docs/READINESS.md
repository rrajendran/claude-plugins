# Readiness checks

`asc readiness [--platform P] [--only local|appstore|testflight] [--json]`

Result levels: **✔ pass**, **▲ warn** (won't block but worth fixing, or could not be verified), **✘ fail** (blocks submission), **ℹ info**. Exit code is `1` when any ✘ exists. A check that errors out (e.g. HTTP 403 on one endpoint) is downgraded to ▲ "could not verify" so the rest of the report still runs.

## Local toolchain (`--only local`)

| Check | Fails/warns when | Fix |
|---|---|---|
| API key file | file readable by group/others | `chmod 600` the `.p8` |
| Xcode | `xcodebuild` missing | Install Xcode; `xcode-select --switch` |
| Distribution signing identity | (info only) none in keychain | Fine with API-key cloud signing; else `asc certs csr` / `certs create` |
| `.asc.json` / ExportOptions | missing | `asc init` |

## App record

| Check | Fix |
|---|---|
| App exists | Create the app record in the web UI |
| **Content rights declaration** ✘ | `asc apps set --content-rights DOES_NOT_USE_THIRD_PARTY_CONTENT` (or `USES_…`) |
| Bundle ID registered | `asc bundle-ids create` |

## App Store version

| Check | Fix |
|---|---|
| Version exists and is editable (`PREPARE_FOR_SUBMISSION`, rejected states) | `asc versions create --version X` |
| **Build attached**, `VALID`, not expired | `asc ship --attach` or `asc versions set-build --build latest` |
| **Export compliance** answered | `asc builds encryption latest --uses-encryption false` or `ITSAppUsesNonExemptEncryption` in Info.plist |
| Per locale: description, keywords, support URL | `asc loc set` / `asc metadata push` |
| Keywords ≤ 100 characters | shorten |
| What's New (warn on updates) | `asc loc set --whats-new …` |
| **Screenshots** per locale: at least one non-empty set, no failed assets | `asc screenshots upload` |
| **Review contact** (first/last name, phone, email) | `asc review details set` |
| Demo account, if marked required | add username + password or unmark |

## App information

| Check | Fix |
|---|---|
| **Primary category** | `asc app-info set --primary-category X` (`asc categories`) |
| App name per locale | `asc app-info set --name` |
| **Privacy policy URL** per locale | `asc app-info set --privacy-url` |
| **Age rating** — no unanswered questions | `asc age-rating show` then `asc age-rating set k=v …` |

## Pricing & availability

| Check | Fix |
|---|---|
| **Price schedule** set | `asc pricing set-free`, or choose a tier in the web UI |
| **Territory availability** configured | Web UI → Pricing and Availability |

## TestFlight (`--only testflight`)

| Check | Meaning |
|---|---|
| Latest build `VALID` | Processing finished (warn if still `PROCESSING`) |
| TestFlight states | info: internal/external build state |
| Beta app description + feedback email | Required for **external** testing: `asc tf info set` |
| Beta review contact | Required for external testing |
| Groups exist | `asc tf groups create` |

## Manual items (never verifiable via the API)

- **App Privacy** ("nutrition label") answers — App Store Connect → App Privacy.
- **Agreements, tax and banking** — the Paid Apps Agreement must be active for paid apps and in-app purchases.
- Export-compliance *documentation* if you use non-exempt encryption.
- App Review Guidelines compliance itself (sign-in with Apple, account deletion, privacy manifests, etc.).

## JSON output

```json
{ "summary": { "pass": 14, "warn": 2, "fail": 3 },
  "checks": [ { "section": "App Store version", "status": "fail",
                "name": "Build attached", "detail": "no build selected — …" } ] }
```
