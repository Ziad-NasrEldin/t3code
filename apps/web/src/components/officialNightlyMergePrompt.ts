export function officialNightlyMergePrompt(tag: string, commit: string): string {
  return `Prepare a Signal Crew update from official T3 Code nightly ${tag} (${commit}).

The user approved starting preparation, conflict resolution, and verification. Final merge, publication, and installation are NOT approved by this request.

Work in this thread's isolated worktree. Verify this is the Signal Crew T3 Code source checkout. Preserve dirty user changes and all Signal Crew Office, usage, provider, updater, and application data customizations. Fetch the maintained feat/signal-crew-office branch from Ziad-NasrEldin/t3code into refs/remotes/fork/feat/signal-crew-office and the exact official tag into refs/tags/${tag} from pingdotgg/t3code. Verify the tag resolves to ${commit}; never substitute main or a newer nightly. Merge both revisions locally, resolve conflicts, commit the prepared result, and run check:changed against the fetched fork base plus focused updater, packaging, and Office tests. Use test-t3-app for real client verification with isolated state; use the free Replay provider for streaming tests. Do not push to the maintained branch yet.

Choose a Signal Crew nightly version newer than both the installed version and all published fork releases. After all validation passes and the worktree is clean, write the ignored file .t3/official-nightly-review.json in this worktree with this shape: {"tag":"${tag}","upstreamCommit":"${commit}","preparedCommit":"<full tested HEAD SHA>","baseCommit":"<fetched fork branch SHA>","version":"<new x.y.z-nightly.YYYYMMDD.N>","summary":"<changes, resolved conflicts, and exact validation results>","checks":{"changed":true,"focused":true,"client":true}}. Only mark a check true when it actually passed. If verification is blocked, report the blocker and leave this file absent. Keep reports and evidence out of git. The app independently verifies the commit, clean worktree, official tag, and fork ancestry before enabling approval.

Show the concrete diff, conflicts resolved, and validation results, then end your turn and wait for FINAL MERGE AND RELEASE APPROVAL. The app exposes an Approve merge and build button which sends that explicit approval as a new user message. If declined, preserve the prepared work and do not publish or install. Do not infer final approval from the initial Start merge agent click.

Only AFTER that explicit approval: merge the reviewed commit into the maintained fork branch, run scripts/release-signal-crew-local.sh with a monotonically newer x.y.z-nightly.YYYYMMDD.N version and upstream tag ${tag}. This signs/notarizes the custom Signal Crew installer and records its official source tag. Validate the signature, notarization, metadata, and packaged app; publish the prerelease to Ziad-NasrEldin/t3code. Return the release link and have the user approve Restart and install through Signal Crew's updater. Do not install an upstream binary, alter the updater to download upstream binaries, restart during active work, or write to the live database. If signing cannot complete on this machine, report the exact blocker and keep the update pending.`;
}

export function officialNightlyReleaseApproval(
  tag: string,
  commit: string,
  preparedCommit: string,
  version: string,
): string {
  return `FINAL MERGE AND RELEASE APPROVAL: I approve exactly prepared commit ${preparedCommit} as Signal Crew version ${version}, incorporating official nightly ${tag} (${commit}). Verify HEAD still equals ${preparedCommit}, the worktree is clean, both ancestry checks and all validation pass, and the fork branch has not advanced since the reviewed base. If any condition changed, stop and return for review. Push exactly this commit to Ziad-NasrEldin/t3code feat/signal-crew-office without force; do not modify another checkout or include new changes. Run scripts/release-signal-crew-local.sh ${version} ${tag}, validate the signed/notarized staged app, installer hashes, metadata, and packaged UI, then publish its draft with gh release edit v${version} --repo Ziad-NasrEldin/t3code --draft=false. Return the published link and tell me to use Check for installer in the official nightly dialog. Do not restart this app automatically; let me approve Restart and install in the updater. If building or publishing fails, keep the prepared work and report the exact blocker for retry.`;
}
