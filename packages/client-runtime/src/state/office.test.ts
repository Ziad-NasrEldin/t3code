import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  NodeId,
  ThreadId,
  RunId,
  type OrchestrationV2OfficeChild,
} from "@t3tools/contracts";
import { deriveOfficeActors, officeThreadStatus } from "./office.ts";
import { v2ThreadShell, v2Now } from "./orchestrationV2TestFixtures.ts";
const environmentId = EnvironmentId.make("office-a");
const parent = {
  ...v2ThreadShell,
  status: "completed" as const,
  latestRunId: RunId.make("parent-new-turn"),
};
const childId = ThreadId.make("child-native");
const native = {
  ...v2ThreadShell,
  id: childId,
  creationSource: "provider" as const,
  lineage: {
    rootThreadId: parent.id,
    parentThreadId: parent.id,
    relationshipToParent: "subagent" as const,
  },
  status: "completed" as const,
  latestRunId: RunId.make("child-completed-run"),
  settledAt: v2Now,
};
const child: OrchestrationV2OfficeChild = {
  id: NodeId.make("native-task"),
  threadId: parent.id,
  childThreadId: childId,
  origin: "provider_native",
  status: "completed",
  title: "Earlier completed child",
  result: "Delivered",
};
describe("office retained membership", () => {
  it("retains completed native children across later parent turns, remounts and automatic settlement", () => {
    for (const threads of [
      [parent, native],
      [parent],
      [{ ...parent, status: "running" as const }, native],
    ]) {
      const actors = deriveOfficeActors(environmentId, threads, [child], true);
      expect(
        actors
          .filter((actor) => actor.child)
          .map((actor) => [actor.threadRef.threadId, actor.status]),
      ).toEqual([[childId, "sleeping"]]);
    }
    expect(
      deriveOfficeActors(environmentId, [parent, native], [child], true).filter(
        (actor) => actor.child,
      ),
    ).toHaveLength(1);
  });
  it("distinguishes completion and cancellation from explicit release, including a settled parent", () => {
    const settledParent = { ...parent, settledAt: v2Now, settledOverride: "settled" as const };
    expect(deriveOfficeActors(environmentId, [settledParent, native], [child], true)).toHaveLength(
      1,
    );
    expect(
      deriveOfficeActors(
        environmentId,
        [{ ...settledParent, archivedAt: v2Now }, native],
        [child],
        true,
      ),
    ).toHaveLength(1);
    const cancelled = deriveOfficeActors(
      environmentId,
      [settledParent, native],
      [{ ...child, status: "cancelled" }],
      true,
    );
    expect(cancelled[0]?.status).toBe("interrupted");
    expect(
      deriveOfficeActors(
        environmentId,
        [settledParent, native],
        [{ ...child, closedAt: v2Now }],
        true,
      ),
    ).toEqual([]);
  });
  it("keeps child activity independent from its idle parent and routes native prompts to that parent", () => {
    const actors = deriveOfficeActors(
      environmentId,
      [parent, native],
      [{ ...child, status: "running" }],
      true,
    );
    const worker = actors.find((actor) => actor.child)!;
    expect(worker.status).toBe("working");
    expect(worker.chatRef.threadId).toBe(parent.id);
    expect(worker.native).toBe(true);
    const restarted = {
      ...native,
      status: "running" as const,
      activeRunId: RunId.make("child-restarted"),
      latestRunStartedAt: DateTime.add(v2Now, { seconds: 1 }),
    };
    expect(
      deriveOfficeActors(environmentId, [parent, restarted], [child], true).find(
        (actor) => actor.child,
      )?.status,
    ).toBe("working");
    expect(
      deriveOfficeActors(
        environmentId,
        [parent, restarted],
        [{ ...child, closedAt: v2Now }],
        true,
      ).find((actor) => actor.child)?.status,
    ).toBe("working");
    expect(officeThreadStatus({ ...parent, blockedOnThreadWait: true })).toBe("working");
  });
  it("uses owning environment keys, preserves offline occupants, and omits remote duplicates", () => {
    const a = deriveOfficeActors(environmentId, [parent, native], [child], false);
    const b = deriveOfficeActors(EnvironmentId.make("office-b"), [parent, native], [child], true);
    expect(a.every((actor) => actor.status === "offline")).toBe(true);
    expect(a[0]?.key).not.toBe(b[0]?.key);
    const remoteThread = {
      ...native,
      creationSource: "mcp" as const,
      delegatedFrom: {
        environmentId: EnvironmentId.make("parent-office"),
        threadId: parent.id,
        title: "Parent",
      },
      settlementSource: "automatic" as const,
    };
    const restored = deriveOfficeActors(environmentId, [remoteThread], [], true);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.status).toBe("sleeping");
    expect(
      deriveOfficeActors(
        environmentId,
        [{ ...remoteThread, settlementSource: "explicit", settledOverride: "settled" }],
        [],
        true,
      ),
    ).toHaveLength(0);
    expect(
      deriveOfficeActors(
        environmentId,
        [parent],
        [
          {
            ...child,
            childThreadId: null,
            remoteChild: {
              environmentId: EnvironmentId.make("elsewhere"),
              threadId: childId,
              label: "Remote",
            },
          },
        ],
        true,
      ),
    ).toHaveLength(1);
  });
  it("releases an app-owned child only after explicit child settlement", () => {
    const delegated = { ...child, origin: "app_owned" as const };
    expect(
      deriveOfficeActors(environmentId, [parent, native], [delegated], true).filter(
        (actor) => actor.child,
      ),
    ).toHaveLength(1);
    expect(
      deriveOfficeActors(
        environmentId,
        [
          parent,
          { ...native, settledOverride: "settled" as const, settlementSource: "explicit" as const },
        ],
        [delegated],
        true,
      ).filter((actor) => actor.child),
    ).toHaveLength(0);
  });
});
