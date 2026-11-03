# Signal Crew updates

The maintained branch is `feat/signal-crew-office` in `Ziad-NasrEldin/t3code`.
The upstream check runs every six hours once its workflow is on that repository's default branch and scheduled workflows are enabled. It selects the most recently published official nightly by publication time, ignoring stable releases and drafts, and prepares a uniquely named merge branch for its commit. Conflicts fail the run and list affected files; no release is published and the maintained branch is not changed. Review, test, and merge the prepared branch before releasing.

Run **Signal Crew release** on the maintained branch with a new stable semver greater than the installed version and all previous Signal Crew releases. It runs focused checks, builds an Apple Silicon installer and ZIP, and creates a draft release. Install the draft on a test copy, verify the Office view and data paths, and test an update from the previous signed Signal Crew build before publishing. The draft is invisible to the updater until published. Keep official releases out of this fork's release feed.

Signal Crew's release versions are independent of the upstream nightly versions. Keep clients on the Signal Crew feed; selecting the official nightly channel would not preserve the custom edition.

Configure repository secrets `CSC_LINK` (base64 Developer ID Application certificate export), `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `MACOS_PROVISIONING_PROFILE` (base64). Set repository variable `APPLE_TEAM_ID`. The provisioning profile must match `com.t3tools.t3code.signalcrew` and the passkey entitlements required by the existing packaging script. The workflow fails if any signing input is missing.

Signal Crew packaging uses `T3CODE_DESKTOP_EDITION=signal-crew` and `T3CODE_DESKTOP_UPDATE_REPOSITORY=Ziad-NasrEldin/t3code`. It retains the installed edition's `t3code-signal-crew/home` and `t3code-signal-crew/electron` paths. Install the first signed release manually to bootstrap the update feed. Subsequent published releases are delivered by the existing desktop updater. Do not replace the running app during active work.

A workflow file in a local checkout is not an activated service. Repository credentials, workflow deployment, a signed initial installer, and an observed update between two versions are required before claiming automatic updates work. Back up application data before the upgrade test; database migrations may prevent simply reinstalling an older version.

## Build on the maintainer Mac

The local route keeps the Developer ID private key on the Mac. Store notarization credentials once with `xcrun notarytool store-credentials signal-crew`, then run `bash scripts/release-signal-crew-local.sh VERSION` from a clean release checkout. The script tests, signs with the existing certificate, notarizes using the Keychain profile, and uploads a draft release. No Apple credentials are sent to GitHub. Signal Crew can build without a provisioning profile; in that case the optional in-app browser passkey entitlements are omitted, matching the original custom installation. Official builds continue to require their profile.
