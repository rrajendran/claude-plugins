# Workflows

All examples assume you ran `asc init` in the project root, so `--app`, `--scheme` etc. come from `.asc.json`.

## A. First release, end to end

```sh
# 0. One-time, in the web UI: create the app record (the API can't).
asc bundle-ids create --identifier com.acme.app --name "Acme"       # if not registered yet
asc bundle-ids enable com.acme.app --capability ICLOUD               # capabilities your entitlements need

# 1. Get a build into TestFlight
asc ship --group "Internal"

# 2. Create the version and fill the listing
asc versions create --version 1.0 --release-type MANUAL
asc metadata pull                         # scaffolds files from what exists
$EDITOR asc/metadata/en-US/*.txt
asc metadata push --dry-run && asc metadata push
asc app-info set --locale en-US --privacy-url https://acme.app/privacy \
                 --primary-category PRODUCTIVITY
asc age-rating set gambling=false unrestrictedWebAccess=false violenceCartoonOrFantasy=NONE   # …all keys from `asc age-rating show`
asc apps set --content-rights DOES_NOT_USE_THIRD_PARTY_CONTENT
asc pricing set-free
asc screenshots upload --display-type APP_IPHONE_67 --files AppStore/iPhone --replace
asc review details set --first Ada --last Lovelace --phone +14155550100 --email ada@acme.app \
                       --notes "Sign in is optional."
asc builds encryption latest --uses-encryption false   # skip if ITSAppUsesNonExemptEncryption is in Info.plist

# 3. Attach, verify, submit
asc versions set-build --build latest
asc readiness --only appstore            # must say READY
asc review submit --yes
asc review status
```

Manual items the API cannot do: create the app record, App Privacy answers, agreements/tax/banking, some availability settings. `readiness` reminds you.

## B. Shipping an update

```sh
asc versions create --version 1.1
asc loc set --locale en-US --whats-new-file asc/release-notes.txt
asc ship --attach --group Internal         # builds N+1, uploads, attaches to the editable version
asc readiness --only appstore && asc review submit --yes
# after approval, if release type is MANUAL:
asc versions release
```

`--build-number auto` (the default for `ship`) picks *highest existing build number + 1* across the app, so numbers never collide.

## C. TestFlight only

```sh
asc tf groups create --name "Friends" --public-link --limit 100
asc tf info set --locale en-US --description "Early access build" --feedback-email me@acme.app
asc tf review-contact set --first Ada --last Lovelace --phone +14155550100 --email ada@acme.app
asc tf whats-new --build latest --text "Please test sync across two devices"
asc tf builds add --build latest --group "Friends"
asc tf submit                              # external groups require beta app review once per version
asc tf status
asc tf testers add --email friend@x.com --first F --last L --group "Friends"
asc tf feedback
```

Internal groups (up to 100 App Store Connect users) receive builds without beta review. External groups need `tf submit` for the first build of each version.

## D. Build manually, step by step

```sh
asc builds next-number                       # → 43
asc archive --build-number 43 --scheme MyApp
asc export --archive build/MyApp-IOS.xcarchive
asc upload --validate build/export-MyApp-IOS/MyApp.ipa
asc upload build/export-MyApp-IOS/MyApp.ipa
asc builds wait --number 43
```

## E. Provisioning from scratch (usually unnecessary)

With automatic signing + the API key, Xcode manages certificates and profiles for you. Only do this for manual signing:

```sh
asc certs csr --email me@acme.app --out ~/.keys/dist           # key + CSR, key never leaves the Mac
asc certs create --type IOS_DISTRIBUTION --csr ~/.keys/dist.csr --out dist.cer
security import dist.cer -k ~/Library/Keychains/login.keychain-db
asc profiles create --name "Acme AppStore" --type IOS_APP_STORE \
    --bundle-id com.acme.app --certs <certId>
asc profiles download <profileId> --install
asc devices register --name "My iPhone" --udid 0000…            # ad-hoc/dev only
```

## F. Metadata as code

Commit `asc/metadata/**`. Review changes in PRs, then `asc metadata push` from CI or locally. `asc metadata pull` after editing in the web UI keeps the repo in sync. `--version editable` (the push default) targets whichever version is open for edits.

## G. CI (GitHub Actions sketch)

```yaml
- run: |
    mkdir -p ~/.keys && chmod 700 ~/.keys
    echo "$ASC_KEY_P8" > ~/.keys/AuthKey_$ASC_KEY_ID.p8 && chmod 600 ~/.keys/AuthKey_$ASC_KEY_ID.p8
    ./asc-plugin/bin/asc ship --group Internal --no-wait
  env:
    ASC_KEY_ID: ${{ secrets.ASC_KEY_ID }}
    ASC_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
    ASC_KEY_P8: ${{ secrets.ASC_KEY_P8 }}
    ASC_KEY_PATH: ~/.keys/AuthKey_${{ secrets.ASC_KEY_ID }}.p8
```

Use `asc readiness --json` as a gate: it exits 1 when anything is blocking and prints `{summary, checks[]}`.

## H. Scripting with `--json`

```sh
asc builds list --json | jq -r '.[] | select(.processingState=="VALID") | .version' | head -1
asc api GET /v1/apps/$APP/betaGroups --all | jq '.data[].attributes.name'
```
