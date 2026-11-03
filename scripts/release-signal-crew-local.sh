#!/bin/bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
version="${1:?Usage: release-signal-crew-local.sh VERSION}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected stable semver' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Release checkout must be clean' >&2; exit 1; }
export T3CODE_DESKTOP_EDITION=signal-crew
export T3CODE_DESKTOP_UPDATE_REPOSITORY=Ziad-NasrEldin/t3code
export CSC_NAME='Ziad Ahmed (377QC32T9T)'
export APPLE_KEYCHAIN_PROFILE=signal-crew
xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --output-format json >/dev/null
env -u T3CODE_DESKTOP_EDITION vp test run scripts/build-desktop-artifact.test.ts apps/desktop/src/updates/DesktopUpdates.test.ts packages/client-runtime/src/state/office.test.ts
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version "$version" --signed --output-dir "release/signal-crew-$version"
output="release/signal-crew-$version"
test -f "$output/latest-mac.yml"
gh release create "v$version" "$output"/*.dmg "$output"/*.zip "$output"/*.yml --repo "$T3CODE_DESKTOP_UPDATE_REPOSITORY" --target "$(git rev-parse HEAD)" --draft --title "Signal Crew $version" --notes 'Built and notarized on the maintainer Mac. Review the installer and upgrade before publishing.'
