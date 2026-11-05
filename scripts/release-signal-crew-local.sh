#!/bin/bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
version="${1:?Usage: release-signal-crew-local.sh VERSION [OFFICIAL_NIGHTLY_TAG]}"
upstream_tag="${2:-}"
channel=latest
release_args=()
if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  [[ "$upstream_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]] || { echo 'Expected the official nightly tag for this build' >&2; exit 1; }
  git fetch https://github.com/pingdotgg/t3code.git "refs/tags/$upstream_tag"
  git merge-base --is-ancestor 'FETCH_HEAD^{commit}' HEAD || { echo 'Merge the official nightly before releasing' >&2; exit 1; }
  channel=nightly
  release_args+=(--prerelease)
else
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected stable or nightly semver' >&2; exit 1; }
fi
[[ -z "$(git status --porcelain)" ]] || { echo 'Release checkout must be clean' >&2; exit 1; }
export T3CODE_DESKTOP_EDITION=signal-crew
export T3CODE_DESKTOP_UPDATE_REPOSITORY=Ziad-NasrEldin/t3code
export CSC_NAME='Ziad Ahmed (377QC32T9T)'
export APPLE_KEYCHAIN_PROFILE=signal-crew
xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --output-format json >/dev/null
env -u T3CODE_DESKTOP_EDITION vp test run scripts/build-desktop-artifact.test.ts apps/desktop/src/updates/DesktopUpdates.test.ts packages/client-runtime/src/state/office.test.ts
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version "$version" --signed --output-dir "release/signal-crew-$version"
output="release/signal-crew-$version"
test -f "$output/$channel-mac.yml"
gh release create "v$version" "$output"/*.dmg "$output"/*.zip "$output"/*.yml "${release_args[@]}" --repo "$T3CODE_DESKTOP_UPDATE_REPOSITORY" --target "$(git rev-parse HEAD)" --draft --title "Signal Crew $version" --notes "Built and notarized on the maintainer Mac. Official nightly source: ${upstream_tag:-not applicable}. Review the installer and upgrade before publishing."
