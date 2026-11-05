import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NightlyMerge from "./NightlyMerge.ts";
import * as OfficialNightly from "./OfficialNightly.ts";

it.live(
  "persists one merge thread and binds final approval to a clean, verified merge commit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped();
        const source = `${root}/source`;
        const worktree = `${root}/prepared`;
        yield* fs.makeDirectory(source);
        const git = (cwd: string, args: string[]) =>
          spawner.string(ChildProcess.make("git", args, { cwd }));
        yield* git(source, ["init", "--quiet"]);
        yield* git(source, ["config", "user.email", "test@example.com"]);
        yield* git(source, ["config", "user.name", "Test"]);
        yield* fs.makeDirectory(`${source}/scripts`);
        yield* fs.writeFileString(`${source}/scripts/release-signal-crew-local.sh`, "release");
        yield* fs.writeFileString(`${source}/.gitignore`, ".t3/\n");
        yield* git(source, ["add", "."]);
        yield* git(source, ["commit", "-qm", "Signal Crew base"]);
        const baseCommit = (yield* git(source, ["rev-parse", "HEAD"])).trim();
        const tag = "v0.1.8-nightly.20261105.1";
        yield* git(source, ["tag", tag]);
        yield* git(source, [
          "remote",
          "add",
          "fork",
          "https://github.com/Ziad-NasrEldin/t3code.git",
        ]);
        yield* git(source, ["update-ref", "refs/remotes/fork/feat/signal-crew-office", baseCommit]);
        yield* git(source, ["worktree", "add", "-qb", "merge-nightly", worktree]);
        const input = {
          tag,
          upstreamCommit: baseCommit,
          sourceDirectory: source,
          environmentId: EnvironmentId.make("local"),
          projectId: ProjectId.make("source"),
          threadId: ThreadId.make("merge"),
          messageId: MessageId.make("prepare"),
          approvalMessageId: MessageId.make("approve"),
        };
        const make = NightlyMerge.make(`${root}/sessions.json`, "0.1.9").pipe(
          Effect.provideService(OfficialNightly.OfficialNightly, {
            check: () =>
              Effect.succeed({
                status: "available",
                tag,
                commit: baseCommit,
                releaseUrl: null,
                publishedAt: null,
                integratedTag: null,
                checkedAt: "2026-11-05T00:00:00Z",
                message: null,
              }),
          }),
        );
        const service = yield* make;
        assert.isNull(yield* service.get(tag));
        assert.isNull((yield* service.begin(input)).approvedCommit);
        const duplicate = yield* service.begin({ ...input, threadId: ThreadId.make("duplicate") });
        assert.equal(duplicate.threadId, input.threadId);
        const restored = yield* make;
        assert.equal((yield* restored.get(tag))?.threadId, input.threadId);
        assert.isTrue(
          Option.isSome(yield* service.review(tag, worktree).pipe(Effect.flip, Effect.option)),
        );
        yield* fs.makeDirectory(`${worktree}/.t3`);
        const report = {
          tag,
          upstreamCommit: baseCommit,
          preparedCommit: baseCommit,
          baseCommit,
          version: "0.1.10-nightly.20261105.1",
          summary: "Resolved conflicts; Office retained.",
          checks: { changed: true, focused: true, client: true },
        };
        const writeReport = (value: unknown) =>
          fs.writeFileString(`${worktree}/.t3/official-nightly-review.json`, JSON.stringify(value));
        yield* writeReport({ ...report, checks: { changed: false, focused: true, client: true } });
        assert.isTrue(
          Option.isSome(yield* service.review(tag, worktree).pipe(Effect.flip, Effect.option)),
        );
        yield* writeReport(report);
        assert.equal((yield* service.review(tag, worktree)).preparedCommit, baseCommit);
        yield* fs.writeFileString(`${worktree}/unreviewed.txt`, "changed");
        assert.isTrue(
          Option.isSome(
            yield* service
              .approve(tag, worktree, baseCommit, report.version)
              .pipe(Effect.flip, Effect.option),
          ),
        );
        yield* git(worktree, ["add", "unreviewed.txt"]);
        yield* git(worktree, ["commit", "-qm", "Another change"]);
        assert.isTrue(
          Option.isSome(
            yield* service
              .approve(tag, worktree, baseCommit, report.version)
              .pipe(Effect.flip, Effect.option),
          ),
        );
        const reviewed = (yield* git(worktree, ["rev-parse", "HEAD"])).trim();
        yield* writeReport({ ...report, preparedCommit: reviewed });
        assert.isTrue(
          Option.isSome(
            yield* service
              .approve(tag, worktree, reviewed, "0.1.11-nightly.20261105.1")
              .pipe(Effect.flip, Effect.option),
          ),
        );
        const approved = yield* service.approve(tag, worktree, reviewed, report.version);
        assert.equal(approved.approvedCommit, reviewed);
        assert.equal((yield* restored.get(tag))?.approvedCommit, reviewed);
        assert.isTrue(
          Option.isSome(yield* service.review(tag, source).pipe(Effect.flip, Effect.option)),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
