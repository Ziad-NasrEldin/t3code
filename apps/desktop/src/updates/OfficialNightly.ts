import type { OfficialNightlyState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as DesktopConfig from "../app/DesktopConfig.ts";

const API = "https://api.github.com/repos/pingdotgg/t3code";
const NIGHTLY = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
const Releases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    published_at: Schema.NullOr(Schema.String),
  }),
);
class OfficialNightlyMissingError extends Schema.TaggedError<OfficialNightlyMissingError>()(
  "OfficialNightlyMissingError",
  {},
) {}

const Commit = Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) });

export class OfficialNightly extends Context.Service<
  OfficialNightly,
  {
    readonly check: (force?: boolean) => Effect.Effect<OfficialNightlyState | undefined>;
  }
>()("@t3tools/desktop/updates/OfficialNightly") {}

export const layer = Layer.effect(
  OfficialNightly,
  Effect.gen(function* () {
    const config = yield* DesktopConfig.DesktopConfig;
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("user-agent", "T3-Code-Signal-Crew")),
      HttpClient.filterStatusOk,
    );
    const latest = yield* Ref.make<OfficialNightlyState | undefined>(undefined);
    const checked = yield* Ref.make<number | undefined>(undefined);
    const mutex = yield* Semaphore.make(1);
    const integratedTag = Option.getOrNull(config.upstreamNightlyTag);
    return OfficialNightly.of({
      check: Effect.fn("OfficialNightly.check")(function* (force = false) {
        if (!Option.contains(config.edition, "signal-crew") || config.disableAutoUpdate) return;
        return yield* mutex.withPermit(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const previous = yield* Ref.get(checked);
            if (!force && previous !== undefined && now - previous < 15 * 60 * 1000)
              return yield* Ref.get(latest);
            const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            const result = yield* Effect.gen(function* () {
              const releases = yield* http
                .get(`${API}/releases?per_page=100`)
                .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Releases)));
              const release = releases
                .filter((r) => !r.draft && r.published_at !== null && NIGHTLY.test(r.tag_name))
                .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!))[0];
              if (!release) return yield* new OfficialNightlyMissingError();
              const commit = yield* http
                .get(`${API}/commits/${encodeURIComponent(release.tag_name)}`)
                .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Commit)));
              return {
                status:
                  release.tag_name === integratedTag
                    ? ("current" as const)
                    : ("available" as const),
                tag: release.tag_name,
                commit: commit.sha,
                releaseUrl: `https://github.com/pingdotgg/t3code/releases/tag/${release.tag_name}`,
                publishedAt: release.published_at,
                integratedTag,
                checkedAt,
                message: null,
              } satisfies OfficialNightlyState;
            }).pipe(
              Effect.scoped,
              Effect.timeout("15 seconds"),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning("Official T3 Code nightly discovery failed.", error);
                  const previous = yield* Ref.get(latest);
                  return {
                    tag: previous?.tag ?? null,
                    commit: previous?.commit ?? null,
                    releaseUrl: previous?.releaseUrl ?? null,
                    publishedAt: previous?.publishedAt ?? null,
                    integratedTag,
                    checkedAt,
                    status: "error" as const,
                    message: "Could not check official T3 Code nightlies. Try again.",
                  } satisfies OfficialNightlyState;
                }),
              ),
            );
            yield* Ref.set(checked, now);
            yield* Ref.set(latest, result);
            return result;
          }),
        );
      }),
    });
  }),
);
