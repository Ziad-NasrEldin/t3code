import type { TokenEconomizerCohort, TokenEconomizerUsage } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Baseline = Schema.Struct({
  cutover: Schema.String,
  repositories: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        session_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
        models_seen: Schema.Array(Schema.String),
        native_usage: Schema.Struct({ input_tokens: Schema.optionalKey(Schema.Number) }),
      }),
    ),
  ),
});
const Preflight = Schema.Struct({
  repos: Schema.Array(Schema.Struct({ name: Schema.String, root: Schema.String })),
});
const Index = Schema.Struct({
  checkouts: Schema.Record(Schema.String, Schema.Struct({ key: Schema.String })),
});
const Config = Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) });
const LedgerRow = Schema.Struct({
  kind: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  started: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  folded_at: Schema.optionalKey(Schema.Number),
  at: Schema.optionalKey(Schema.Number),
  job: Schema.optionalKey(Schema.String),
  shadow: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
  input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  overhead: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
});
type LedgerRow = typeof LedgerRow.Type;
const decodeRow = Schema.decodeOption(Schema.fromJsonString(LedgerRow));
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const OVERHEAD_KEYS = ["optimizer_tokens", "spiral_judge_tokens", "spiral_nudge_writer_tokens"];

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cohort(map: Map<string, TokenEconomizerCohort>, model: string): TokenEconomizerCohort {
  let entry = map.get(model);
  if (entry === undefined) {
    entry = {
      model,
      beforeSessions: 0,
      afterSessions: 0,
      beforeInputTokens: 0,
      afterInputTokens: 0,
    };
    map.set(model, entry);
  }
  return entry;
}

/** Input totals avoid the plugin's version-dependent output/reasoning and pricing weights. */
export const readTokenEconomizerUsage = Effect.fn("UsageService.readTokenEconomizerUsage")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    const now = yield* DateTime.now;
    const stateRoot = env.TOKENECONOMIZER_HOME?.trim() || path.join(home, ".tokeneconomizer");
    const rolloutRoot = path.join(home, ".local", "share", "tokeneconomizer-rollout");
    const warnings = new Set<string>();

    const read = Effect.fn("UsageService.readEconomizerFile")(function* (file: string) {
      return yield* Effect.gen(function* () {
        const stat = yield* fs.stat(file);
        if (Number(stat.size) > MAX_FILE_BYTES) {
          warnings.add(
            "Some optimizer data is too large to read. The comparison may be incomplete.",
          );
          return undefined;
        }
        return yield* fs.readFileString(file);
      }).pipe(
        Effect.orElseSucceed((error) => {
          if (error.reason._tag !== "NotFound") {
            warnings.add(
              "Some optimizer files are unavailable. Check file access, then refresh Usage.",
            );
          }
          return undefined;
        }),
      );
    });
    const readJson = Effect.fn("UsageService.readEconomizerJson")(function* <A>(
      file: string,
      schema: Schema.Codec<A, unknown>,
    ) {
      const text = yield* read(file);
      if (text === undefined) return undefined;
      const decoded = Schema.decodeOption(Schema.fromJsonString(schema))(text);
      if (Option.isNone(decoded))
        warnings.add("Some optimizer files could not be read. The comparison may be incomplete.");
      return Option.getOrUndefined(decoded);
    });

    const folders = yield* fs
      .readDirectory(rolloutRoot)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    let snapshot: typeof Baseline.Type | undefined;
    let preflight: typeof Preflight.Type | undefined;
    for (const folder of folders
      .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
      .sort()
      .toReversed()
      .slice(0, 60)) {
      const candidate = yield* readJson(
        path.join(rolloutRoot, folder, "baseline-native-usage.json"),
        Baseline,
      );
      const roots = yield* readJson(path.join(rolloutRoot, folder, "preflight.json"), Preflight);
      if (
        candidate !== undefined &&
        roots !== undefined &&
        Number.isFinite(Date.parse(candidate.cutover))
      ) {
        snapshot = candidate;
        preflight = roots;
        break;
      }
    }
    if (snapshot === undefined || preflight === undefined) return undefined;
    const baseline = snapshot;
    const cutover = Date.parse(baseline.cutover) / 1000;
    const index = yield* readJson(path.join(stateRoot, "index.json"), Index);
    const globalConfig = yield* readJson(path.join(stateRoot, "config.json"), Config);
    if (index === undefined)
      warnings.add("Optimizer state is unavailable. Refresh after a new Codex session.");
    let overheadTokens = 0;
    let excludedSessions = 0;
    const repositories: TokenEconomizerUsage["repositories"][number][] = [];

    for (const repo of preflight.repos.slice(0, 100)) {
      if (repo.name.trim().length === 0) continue;
      const cohorts = new Map<string, TokenEconomizerCohort>();
      const seenBefore = new Set<string>();
      for (const row of (baseline.repositories[repo.name] ?? []).slice(0, 1000)) {
        const model = row.models_seen.length === 1 ? row.models_seen[0]?.trim() : undefined;
        if (!model || !row.session_id || !nonNegative(row.native_usage.input_tokens)) {
          excludedSessions += 1;
          continue;
        }
        if (seenBefore.has(row.session_id)) continue;
        seenBefore.add(row.session_id);
        const before = cohort(cohorts, model);
        cohorts.set(model, {
          ...before,
          beforeSessions: before.beforeSessions + 1,
          beforeInputTokens: before.beforeInputTokens + row.native_usage.input_tokens,
        });
      }

      const key = index?.checkouts[repo.root]?.key;
      let enabled = false;
      const sessions = new Map<string, LedgerRow>();
      const overheadRows = new Map<string, LedgerRow>();
      if (key !== undefined && /^[a-z0-9-]+$/.test(key)) {
        const config = yield* readJson(path.join(stateRoot, "repos", key, "config.json"), Config);
        enabled = config?.enabled ?? globalConfig?.enabled ?? true;
        const text = yield* read(path.join(stateRoot, "repos", key, "codex", "ledger.jsonl"));
        for (const line of text?.split("\n") ?? []) {
          if (!line.trim()) continue;
          const decoded = decodeRow(line);
          if (Option.isNone(decoded)) {
            warnings.add(
              "Some optimizer records could not be read. The comparison may be incomplete.",
            );
            continue;
          }
          const row = decoded.value;
          if (row.kind === "session" && row.session_id) sessions.set(row.session_id, row);
          else if (row.kind === "overhead" && nonNegative(row.at) && row.at >= cutover) {
            overheadRows.set(row.job ?? `${row.session_id}:${row.at}`, row);
          }
        }
      } else {
        warnings.add(
          "Some repositories have no optimizer state yet. Start a fresh Codex conversation there.",
        );
      }
      let foldedSessions = 0;
      for (const row of sessions.values()) {
        if (row.shadow || !nonNegative(row.started) || row.started < cutover) continue;
        foldedSessions += 1;
        overheadRows.set(`session:${row.session_id}`, row);
        const model = row.model?.trim();
        if (
          row.error ||
          !model ||
          !nonNegative(row.input_tokens) ||
          !nonNegative(row.cache_read_input_tokens) ||
          !nonNegative(row.cache_creation_input_tokens)
        ) {
          excludedSessions += 1;
          continue;
        }
        const after = cohort(cohorts, model);
        cohorts.set(model, {
          ...after,
          afterSessions: after.afterSessions + 1,
          afterInputTokens:
            after.afterInputTokens +
            row.input_tokens +
            row.cache_read_input_tokens +
            row.cache_creation_input_tokens,
        });
      }
      for (const row of overheadRows.values()) {
        if (row.shadow) continue;
        for (const name of OVERHEAD_KEYS) {
          const value = row.overhead?.[name];
          if (nonNegative(value)) overheadTokens += value;
        }
      }
      repositories.push({
        name: repo.name,
        enabled,
        foldedSessions,
        cohorts: [...cohorts.values()].sort((a, b) => a.model.localeCompare(b.model)),
      });
    }
    return {
      installationId: baseline.cutover,
      cutover: baseline.cutover,
      readAt: DateTime.formatIso(now),
      overheadTokens,
      excludedSessions,
      repositories,
      warnings: [...warnings],
    } satisfies TokenEconomizerUsage;
  },
);
