import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as OfficialNightly from "./OfficialNightly.ts";

it.effect(
  "detects official nightlies, resolves their exact commit, and keeps the last offer on failure",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let unavailable = false;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.equal(request.headers["user-agent"], "T3-Code-Signal-Crew");
          calls.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            unavailable
              ? new Response("unavailable", { status: 503 })
              : Response.json(
                  request.url.includes("/commits/")
                    ? { sha: "a".repeat(40) }
                    : [
                        { tag_name: "v9.0.0", draft: false, published_at: "2026-11-06T01:00:00Z" },
                        {
                          tag_name: "v0.1.8-nightly.20261106.2",
                          draft: true,
                          published_at: "2026-11-06T01:00:00Z",
                        },
                        {
                          tag_name: "v0.1.8-nightly.20261105.1",
                          draft: false,
                          published_at: "2026-11-05T01:00:00Z",
                        },
                      ],
                ),
          );
        }),
      );
      yield* Effect.gen(function* () {
        const source = yield* OfficialNightly.OfficialNightly;
        const available = yield* source.check();
        assert.equal(available?.status, "available");
        assert.equal(available?.tag, "v0.1.8-nightly.20261105.1");
        assert.equal(available?.commit, "a".repeat(40));
        assert.isTrue(
          calls.every((url) => url.startsWith("https://api.github.com/repos/pingdotgg/t3code/")),
        );
        yield* source.check();
        assert.equal(calls.length, 2);
        unavailable = true;
        const failed = yield* source.check(true);
        assert.equal(failed?.status, "error");
        assert.equal(failed?.tag, available?.tag);
        assert.equal(failed?.commit, available?.commit);
      }).pipe(
        Effect.provide(OfficialNightly.layer),
        Effect.provideService(HttpClient.HttpClient, http),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          DesktopConfig.layerTest({ T3CODE_DESKTOP_EDITION: "signal-crew" }),
        ),
      ),
    ),
);

it.effect("does not probe upstream for ordinary T3 builds", () =>
  Effect.gen(function* () {
    const source = yield* OfficialNightly.OfficialNightly;
    assert.isUndefined(yield* source.check());
  }).pipe(
    Effect.provide(OfficialNightly.layer),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected request")),
    ),
    Effect.provide(DesktopConfig.layerTest({})),
  ),
);

it.effect("marks the embedded official tag current and rejects malformed commit metadata", () =>
  Effect.gen(function* () {
    let malformed = false;
    const tag = "v0.1.8-nightly.20261105.1";
    const http = HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.includes("/commits/")
              ? { sha: malformed ? "not-a-commit" : "a".repeat(40) }
              : [{ tag_name: tag, draft: false, published_at: "2026-11-05T01:00:00Z" }],
          ),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const source = yield* OfficialNightly.OfficialNightly;
      assert.equal((yield* source.check())?.status, "current");
      malformed = true;
      const failed = yield* source.check(true);
      assert.equal(failed?.status, "error");
      assert.equal(failed?.commit, "a".repeat(40));
      assert.equal(failed?.integratedTag, tag);
      malformed = false;
      assert.equal((yield* source.check(true))?.status, "current");
    }).pipe(
      Effect.provide(OfficialNightly.layer),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  }).pipe(
    Effect.provide(
      DesktopConfig.layerTest({
        T3CODE_DESKTOP_EDITION: "signal-crew",
        T3CODE_UPSTREAM_NIGHTLY_TAG: "v0.1.8-nightly.20261105.1",
      }),
    ),
  ),
);
