import {
  OfficialNightlyMergeSchema,
  OfficialNightlyMergeReviewSchema,
  type OfficialNightlyMerge,
  type OfficialNightlyMergeBeginSchema,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as OfficialNightly from "./OfficialNightly.ts";

const SHA = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Report = Schema.Struct({
  ...OfficialNightlyMergeReviewSchema.fields,
  preparedCommit: SHA,
  baseCommit: SHA,
  tag: Schema.String,
  upstreamCommit: SHA,
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/)),
  checks: Schema.Struct({
    changed: Schema.Literal(true),
    focused: Schema.Literal(true),
    client: Schema.Literal(true),
  }),
});
const Sessions = Schema.fromJsonString(Schema.Array(OfficialNightlyMergeSchema));

export class NightlyMergeError extends Schema.TaggedError<NightlyMergeError>()(
  "NightlyMergeError",
  {
    message: Schema.String,
  },
) {}

const encodeSessions = Schema.encodeEffect(Sessions);
const isNightlyMergeError = Schema.is(NightlyMergeError);

const requireCondition = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new NightlyMergeError({ message }));

export const make = Effect.fn("NightlyMerge.make")(function* (
  stateFile: string,
  currentVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const official = yield* OfficialNightly.OfficialNightly;
  const mutex = yield* Semaphore.make(1);
  const git = Effect.fn("NightlyMerge.git")(function* (cwd: string, args: ReadonlyArray<string>) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const process = yield* spawner.spawn(
          ChildProcess.make("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
            cwd,
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        const [output, code] = yield* Effect.all(
          [process.stdout.pipe(Stream.decodeText(), Stream.mkString), process.exitCode],
          { concurrency: "unbounded" },
        );
        yield* requireCondition(
          code === 0,
          "Could not verify the Signal Crew source checkout. Inspect the merge thread before retrying.",
        );
        return output.trim();
      }),
    );
  });
  const read = Effect.fn("NightlyMerge.read")(function* () {
    if (!(yield* fs.exists(stateFile))) return [];
    return yield* fs
      .readFileString(stateFile)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Sessions)));
  });
  const save = Effect.fn("NightlyMerge.save")(function* (
    sessions: ReadonlyArray<OfficialNightlyMerge>,
  ) {
    yield* fs.writeFileString(`${stateFile}.tmp`, yield* encodeSessions(sessions), {
      mode: 0o600,
    });
    yield* fs.rename(`${stateFile}.tmp`, stateFile);
  });
  const sessionFor = Effect.fn("NightlyMerge.sessionFor")(function* (tag: string) {
    const session = (yield* read()).find((item) => item.tag === tag);
    if (!session)
      return yield* new NightlyMergeError({
        message: "Start a merge agent for this nightly first.",
      });
    return session;
  });
  const inspect = Effect.fn("NightlyMerge.inspect")(function* (
    session: OfficialNightlyMerge,
    worktreePath: string,
  ) {
    const source = yield* fs.realPath(session.sourceDirectory);
    const worktree = yield* fs.realPath(worktreePath);
    yield* requireCondition(
      source !== worktree,
      "Prepare the merge in the agent’s separate worktree.",
    );
    const [sourceGit, worktreeGit, root] = yield* Effect.all(
      [
        git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        git(worktree, ["rev-parse", "--show-toplevel"]),
      ],
      { concurrency: "unbounded" },
    );
    yield* requireCondition(
      sourceGit === worktreeGit && root === worktree,
      "The prepared worktree must belong to the selected Signal Crew repository.",
    );
    const report = yield* fs
      .readFileString(`${worktree}/.t3/official-nightly-review.json`)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Report))));
    yield* requireCondition(
      report.tag === session.tag && report.upstreamCommit === session.upstreamCommit,
      "The prepared report is for another official nightly.",
    );
    const [head, dirty, tagCommit, base] = yield* Effect.all(
      [
        git(worktree, ["rev-parse", "HEAD"]),
        git(worktree, ["status", "--porcelain", "--untracked-files=normal"]),
        git(worktree, ["rev-parse", `refs/tags/${session.tag}^{commit}`]),
        git(worktree, ["rev-parse", "refs/remotes/fork/feat/signal-crew-office"]),
      ],
      { concurrency: "unbounded" },
    );
    yield* requireCondition(
      head === report.preparedCommit && dirty === "",
      "The prepared diff changed. Ask the agent to verify it again before approval.",
    );
    yield* requireCondition(
      tagCommit === session.upstreamCommit && base === report.baseCommit,
      "The official tag or maintained fork branch changed. Prepare a new review.",
    );
    yield* git(worktree, ["merge-base", "--is-ancestor", session.upstreamCommit, head]);
    yield* git(worktree, ["merge-base", "--is-ancestor", base, head]);
    yield* requireCondition(
      compareSemverVersions(report.version, currentVersion) > 0,
      "The prepared installer version must be newer than this app.",
    );
    return {
      preparedCommit: head,
      baseCommit: base,
      summary: report.summary,
      version: report.version,
    };
  });
  const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        isNightlyMergeError(error)
          ? error
          : new NightlyMergeError({
              message:
                "The merge review is unavailable. The agent must finish checks and write .t3/official-nightly-review.json in its worktree. Open the thread for details.",
            }),
      ),
    );
  return {
    get: Effect.fn("NightlyMerge.get")((tag: string) =>
      read().pipe(
        Effect.map((items) => items.find((item) => item.tag === tag) ?? null),
        wrap,
      ),
    ),
    begin: Effect.fn("NightlyMerge.begin")((input: typeof OfficialNightlyMergeBeginSchema.Type) =>
      mutex
        .withPermit(
          Effect.gen(function* () {
            const sessions = yield* read();
            const existing = sessions.find((item) => item.tag === input.tag);
            if (existing) return existing;
            const source = yield* official.check();
            yield* requireCondition(
              source?.status === "available" &&
                source.tag === input.tag &&
                source.commit === input.upstreamCommit,
              "Check official nightlies again before preparing this release.",
            );
            const root = yield* fs.realPath(input.sourceDirectory);
            yield* requireCondition(
              (yield* git(root, ["rev-parse", "--show-toplevel"])) === root,
              "Select the Signal Crew source project’s repository root.",
            );
            const remote = yield* git(root, ["remote", "get-url", "fork"]);
            yield* requireCondition(
              /(?:github\.com[:/])Ziad-NasrEldin\/t3code(?:\.git)?$/.test(remote) &&
                (yield* fs.exists(`${root}/scripts/release-signal-crew-local.sh`)),
              "Select the Signal Crew T3 Code source project with its fork remote configured.",
            );
            const session = {
              ...input,
              sourceDirectory: root,
              approvedCommit: null,
              approvedVersion: null,
            };
            yield* save([...sessions, session]);
            return session;
          }),
        )
        .pipe(wrap),
    ),
    review: Effect.fn("NightlyMerge.review")((tag: string, worktreePath: string) =>
      sessionFor(tag).pipe(
        Effect.flatMap((session) => inspect(session, worktreePath)),
        wrap,
      ),
    ),
    approve: Effect.fn("NightlyMerge.approve")(
      (tag: string, worktreePath: string, expectedCommit: string, expectedVersion: string) =>
        mutex
          .withPermit(
            Effect.gen(function* () {
              const session = yield* sessionFor(tag);
              const review = yield* inspect(session, worktreePath);
              yield* requireCondition(
                review.preparedCommit === expectedCommit && review.version === expectedVersion,
                "The reviewed commit or build version changed. Review the new diff before approving.",
              );
              const approved = {
                ...session,
                approvedCommit: expectedCommit,
                approvedVersion: review.version,
              };
              yield* save((yield* read()).map((item) => (item.tag === tag ? approved : item)));
              return approved;
            }),
          )
          .pipe(wrap),
    ),
  };
});

export class NightlyMerge extends Context.Service<
  NightlyMerge,
  Effect.Success<ReturnType<typeof make>>
>()("@t3tools/desktop/updates/NightlyMerge") {}

export const layer = Layer.effect(
  NightlyMerge,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(environment.stateDir, { recursive: true }).pipe(Effect.orDie);
    return yield* make(
      environment.path.join(environment.stateDir, "official-nightly-merges.json"),
      environment.appVersion,
    );
  }),
);
