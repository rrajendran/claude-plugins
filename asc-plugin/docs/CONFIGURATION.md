# Configuration

## Precedence

Highest wins:

1. CLI flags — `--app`, `--platform`, `--key-path`, `--key-id`, `--issuer`
2. Environment — `ASC_APP`, `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID`
3. Project file — nearest `.asc.json` walking up from the current directory
4. User file — `~/.config/asc-plugin/config.json` (written by `asc config set`, mode 600)
5. Auto-discovery — a single `AuthKey_*.p8` in `~/.keys`, `~/.appstoreconnect/private_keys`, `~/.private_keys`, `~/private_keys`

`asc config show` prints the resolved result.

## Credentials

| Key | Env | Notes |
|---|---|---|
| `keyPath` | `ASC_KEY_PATH` | Path to `AuthKey_<ID>.p8` |
| `keyId` | `ASC_KEY_ID` | Defaults to the `<ID>` in the filename |
| `issuerId` | `ASC_ISSUER_ID` | UUID; no default |

For CI, use env vars only (store the `.p8` contents as a secret, write it to a temp file with mode 600).

`altool` (used for `upload`) locates keys by the name `AuthKey_<keyId>.p8`. If your file is named differently, `asc` transparently symlinks it into a temp directory and sets `API_PRIVATE_KEYS_DIR`.

## `.asc.json`

```jsonc
{
  "app": "com.example.myapp",  // bundle id, numeric app id, or exact app name
  "platform": "IOS",                          // IOS | MAC_OS | TV_OS | VISION_OS (override with --platform)
  "project": "MyApp.xcodeproj",             // or "workspace": "X.xcworkspace"
  "scheme": "MyApp",
  "configuration": "Release",
  "teamId": "8DS3387949",
  "buildDir": "build",                        // archives and exports go here
  "exportOptions": "asc/ExportOptions-appstore.plist",   // or per platform: {"IOS": "…", "MAC_OS": "…"}
  "archiveSigningIdentity": "Apple Development", // optional: CODE_SIGN_IDENTITY override for archive only
  "metadataDir": "asc/metadata",
  "testflight": {
    "groups": ["Internal"],                   // groups `asc ship` adds each build to
    "notify": false,
    "whatsNewFile": "asc/testflight-whats-new.txt"
  }
}
```

Safe to commit: it contains no secrets. Paths are relative to the directory containing `.asc.json`.

### Multi-platform apps (iOS + macOS)

App Store versions are per platform. Keep `platform` as the common one and override per call:

```sh
asc readiness --platform macos
asc ship --platform macos --scheme MyApp
```

macOS archives export a `.pkg`; iOS exports an `.ipa`. `asc upload` picks `-t ios` / `-t macos` accordingly.

## ExportOptions plists

| File | `method` | Use |
|---|---|---|
| `ExportOptions-appstore.plist` | `app-store-connect` | App Store + TestFlight (default) |
| `ExportOptions-adhoc.plist` | `release-testing` | Ad-hoc distribution to registered devices |
| `ExportOptions-development.plist` | `debugging` | Development builds |

Signing is `automatic`; `asc archive`/`export` pass `-allowProvisioningUpdates` with your API key, so Xcode creates/refreshes certificates and profiles through the API (no manual certs needed). `manageAppVersionAndBuildNumber` is `false` because `asc ship` controls the build number itself (`CURRENT_PROJECT_VERSION=<N>` override — no project file edits).

## Metadata directory layout

```
asc/metadata/<locale>/
  description.txt  keywords.txt  whats_new.txt  promotional_text.txt
  support_url.txt  marketing_url.txt                    → version localization
  name.txt  subtitle.txt  privacy_policy_url.txt  privacy_choices_url.txt   → app info localization
```

`asc metadata pull` fills it from App Store Connect; `asc metadata push` uploads it. Empty files are skipped. Add a locale by creating a new folder (e.g. `fr-FR/`). Note: Apple rejects `whats_new` on an app's very first version.

## Info.plist recommendation

Add `ITSAppUsesNonExemptEncryption = NO` (if the app only uses OS-provided/exempt encryption) so builds don't need manual export-compliance answers. Otherwise answer per build with `asc builds encryption latest --uses-encryption false`.
