import { useAtomValue } from "@effect/atom-react";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2OfficePage,
} from "@t3tools/contracts";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import { deriveOfficeActors } from "@t3tools/client-runtime/state/office";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentShell, useEnvironmentShellStatus } from "../../state/shell";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironment } from "../../state/environments";

class OfficeCursorError extends Schema.TaggedError<OfficeCursorError>()("OfficeCursorError", {}) {}

const generationAtom = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => get(environmentShell.stateValueAtom(id)).generation),
);
type OfficeInventory = Pick<OrchestrationV2OfficePage, "threads" | "children">;
// Keep only authoritative answers, independently of short-lived query readers.
// This is environment-scoped in-memory state; it keeps no connection or query alive.
const retainedInventory = Atom.family((_id: EnvironmentId) =>
  Atom.make<{ generation: number; value: OfficeInventory } | null>(null).pipe(Atom.keepAlive),
);
const inventory = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "office-inventory",
  staleTimeMs: Number.POSITIVE_INFINITY,
  idleTtlMs: 15_000,
  onAnswer: (
    target: { environmentId: EnvironmentId; input: { generation: number } },
    value: OfficeInventory,
    registry,
  ) =>
    Effect.sync(() => {
      if (registry.get(generationAtom(target.environmentId)) === target.input.generation)
        registry.set(retainedInventory(target.environmentId), {
          generation: target.input.generation,
          value,
        });
    }),
  execute: Effect.fn("Office.readInventory")(function* (_input: { generation: number }) {
    const threads: OrchestrationV2OfficePage["threads"][number][] = [];
    const children: OrchestrationV2OfficePage["children"][number][] = [];
    let after: OrchestrationV2OfficePage["next"] = null;
    do {
      const page: OrchestrationV2OfficePage = yield* request(
        ORCHESTRATION_V2_WS_METHODS.getOfficePage,
        { after },
      );
      threads.push(...page.threads);
      children.push(...page.children);
      if (page.next !== null && page.next === after) return yield* new OfficeCursorError();
      after = page.next;
    } while (after !== null);
    return { threads, children };
  }),
});

export function useOfficeData(environmentId: EnvironmentId, supported: boolean, active: boolean) {
  const generation = useAtomValue(generationAtom(environmentId));
  const atom = inventory({ environmentId, input: { generation } });
  const result = useAtomValue(atom);
  const retained = useAtomValue(retainedInventory(environmentId));
  const shellStatus = useEnvironmentShellStatus(environmentId);
  const environment = useEnvironment(environmentId);
  const shells = useQuietThreadShells();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coalesces authoritative shell notifications into bounded inventory reads without subscribing to transcripts
  useEffect(() => {
    if (!supported || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    const schedule = () => {
      dirty = true;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!dirty || appAtomRegistry.get(atom).waiting) return;
        dirty = false;
        appAtomRegistry.refresh(atom);
      }, 1500);
    };
    const release = appAtomRegistry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      schedule,
    );
    const releaseQuery = appAtomRegistry.subscribe(atom, (next) => {
      if (!next.waiting && dirty) schedule();
    });
    schedule();
    return () => {
      release();
      releaseQuery();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, atom, environmentId, supported]);
  const saved = retained?.value ?? { threads: [], children: [] };
  const byId = new Map(saved.threads.map((thread) => [thread.id, thread]));
  for (const shell of shells) {
    if (shell.environmentId !== environmentId) continue;
    const prior = byId.get(shell.id);
    if (
      !prior ||
      DateTime.toEpochMillis(shell.source.updatedAt) >= DateTime.toEpochMillis(prior.updatedAt)
    )
      byId.set(shell.id, shell.source);
  }
  const online = environment?.connection.phase === "connected";
  const ready =
    online &&
    (shellStatus === "live" || shellStatus === "synchronizing") &&
    generation > 0 &&
    retained?.generation === generation &&
    !AsyncResult.isFailure(result);
  const threads = [...byId.values()];
  return {
    actors: deriveOfficeActors(environmentId, threads, saved.children, online),
    children: saved.children,
    threads,
    online,
    ready,
    loading: result.waiting,
    failed: AsyncResult.isFailure(result),
    refresh: () => appAtomRegistry.refresh(atom),
  };
}
