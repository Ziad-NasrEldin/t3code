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
import { useEffect, useId, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentShell, useEnvironmentShellStatus } from "../../state/shell";
import { useQuietThreadShells } from "../../state/entities";

class OfficeCursorError extends Schema.TaggedError<OfficeCursorError>()("OfficeCursorError", {}) {}

const inventory = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "office-inventory",
  staleTimeMs: Number.POSITIVE_INFINITY,
  idleTtlMs: 15_000,
  execute: Effect.fn("Office.readInventory")(function* (_input: {
    generation: number;
    lease: string;
    epoch: number;
  }) {
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

const generationAtom = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => get(environmentShell.stateValueAtom(id)).generation),
);
export function useOfficeData(environmentId: EnvironmentId, supported: boolean, active: boolean) {
  const lease = useId();
  const [activation, setActivation] = useState({ active, epoch: 0 });
  if (activation.active !== active)
    setActivation({ active, epoch: activation.epoch + (active ? 1 : 0) });
  const generation = useAtomValue(generationAtom(environmentId));
  const atom = inventory({ environmentId, input: { generation, lease, epoch: activation.epoch } });
  const result = useAtomValue(atom);
  const shellStatus = useEnvironmentShellStatus(environmentId);
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
  const saved = AsyncResult.getOrElse(result, () => ({ threads: [], children: [] }));
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
  const online = shellStatus === "live" && generation > 0 && AsyncResult.isSuccess(result);
  const threads = [...byId.values()];
  return {
    actors: deriveOfficeActors(environmentId, threads, saved.children, online),
    children: saved.children,
    threads,
    online,
    loading: result.waiting,
    failed: AsyncResult.isFailure(result),
    refresh: () => appAtomRegistry.refresh(atom),
  };
}
