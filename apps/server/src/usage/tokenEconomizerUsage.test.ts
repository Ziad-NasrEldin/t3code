import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readTokenEconomizerUsage } from "./tokenEconomizerUsage.ts";

const CUTOVER = "2026-11-03T00:00:00.000Z";
const START = Date.parse(CUTOVER) / 1000 + 1;

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const write = Effect.fn("test.writeEconomizerFixture")(function* (
    relative: string,
    value: unknown,
  ) {
    const target = path.join(home, relative);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, typeof value === "string" ? value : JSON.stringify(value));
  });
  const prefix = ".local/share/tokeneconomizer-rollout/2026-11-03";
  const seed = Effect.gen(function* () {
    yield* write(`${prefix}/baseline-native-usage.json`, {
      cutover: CUTOVER,
      repositories: {
        Example: [
          { session_id: "before", models_seen: ["model-a"], native_usage: { input_tokens: 1000 } },
          {
            session_id: "mixed",
            models_seen: ["model-a", "model-b"],
            native_usage: { input_tokens: 5000 },
          },
        ],
      },
    });
    yield* write(`${prefix}/preflight.json`, { repos: [{ name: "Example", root: "/example" }] });
    yield* write(".tokeneconomizer/index.json", {
      checkouts: { "/example": { key: "example-123" } },
    });
    yield* write(".tokeneconomizer/config.json", { enabled: false });
    yield* write(".tokeneconomizer/repos/example-123/config.json", { enabled: true });
  });
  const read = readTokenEconomizerUsage().pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
  );
  const ledger = ".tokeneconomizer/repos/example-123/codex/ledger.jsonl";
  return { write, seed, read, ledger, prefix };
});

function session(extra: Record<string, unknown> = {}) {
  return {
    kind: "session",
    session_id: "after",
    started: START,
    model: "model-a",
    input_tokens: 80,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 20,
    overhead: { optimizer_tokens: 10 },
    ...extra,
  };
}

describe("TokenEconomizer usage", () => {
  it.effect("omits the optional extension when no baseline is installed", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      assert.isUndefined(yield* f.read);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("matches exact models and includes cached input without output/reasoning weights", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed;
      yield* f.write(
        f.ledger,
        [session(), session({ session_id: "other", model: "model-b" })]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      const result = yield* f.read;
      assert.isDefined(result);
      assert.deepEqual(result?.repositories[0]?.cohorts, [
        {
          model: "model-a",
          beforeSessions: 1,
          afterSessions: 1,
          beforeInputTokens: 1000,
          afterInputTokens: 900,
        },
        {
          model: "model-b",
          beforeSessions: 0,
          afterSessions: 1,
          beforeInputTokens: 0,
          afterInputTokens: 900,
        },
      ]);
      assert.strictEqual(result?.excludedSessions, 1);
      assert.strictEqual(result?.overheadTokens, 20);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps no post-install data empty instead of reporting a zero-token saving", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed;
      const result = yield* f.read;
      assert.strictEqual(result?.repositories[0]?.cohorts[0]?.afterSessions, 0);
      assert.strictEqual(result?.repositories[0]?.enabled, true);
      assert.deepEqual(result?.warnings, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("deduplicates sessions and judge jobs, excluding shadow and pre-install work", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed;
      const judge = {
        kind: "overhead",
        session_id: "after",
        at: START,
        job: "job-1",
        overhead: { spiral_judge_tokens: 5 },
      };
      yield* f.write(
        f.ledger,
        [
          session({ input_tokens: 999 }),
          session(),
          judge,
          judge,
          session({ session_id: "shadow", shadow: true }),
          session({ session_id: "old", started: START - 10 }),
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      const result = yield* f.read;
      assert.strictEqual(result?.repositories[0]?.foldedSessions, 1);
      assert.strictEqual(result?.repositories[0]?.cohorts[0]?.afterInputTokens, 900);
      assert.strictEqual(result?.overheadTokens, 15);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains good ledger rows and reports malformed or incomplete records", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed;
      yield* f.write(
        f.ledger,
        `${JSON.stringify(session())}\n{broken\n${JSON.stringify(session({ session_id: "missing", input_tokens: null }))}\n`,
      );
      const result = yield* f.read;
      assert.strictEqual(result?.repositories[0]?.cohorts[0]?.afterSessions, 1);
      assert.strictEqual(result?.excludedSessions, 2);
      assert.strictEqual(result?.warnings.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not follow a traversal key from the optimizer checkout index", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.seed;
      yield* f.write(".tokeneconomizer/index.json", {
        checkouts: { "/example": { key: "../../outside" } },
      });
      const result = yield* f.read;
      assert.strictEqual(result?.repositories[0]?.enabled, false);
      assert.strictEqual(result?.repositories[0]?.foldedSessions, 0);
      assert.strictEqual(result?.warnings.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
