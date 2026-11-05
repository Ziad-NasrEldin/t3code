import * as DateTime from "effect/DateTime";
import type {
  EnvironmentId,
  OrchestrationV2OfficeChild,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { scopeThreadRef, scopedThreadKey } from "../environment/index.ts";

export type OfficeStatus =
  | "starting"
  | "working"
  | "thinking"
  | "streaming"
  | "waiting"
  | "ready"
  | "idle"
  | "sleeping"
  | "interrupted"
  | "error"
  | "offline";
export interface OfficeActor {
  readonly key: string;
  readonly projectId: OrchestrationV2ThreadShell["projectId"];
  readonly title: string;
  readonly child: boolean;
  readonly native: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly chatRef: ScopedThreadRef;
  readonly status: OfficeStatus;
  readonly bubble: string;
  readonly shell: OrchestrationV2ThreadShell;
  readonly closureKnown: boolean;
}
export const OFFICE_STATUS_LABELS: Record<OfficeStatus, string> = {
  starting: "Starting",
  working: "Working",
  thinking: "Thinking",
  streaming: "Responding",
  waiting: "Needs your input",
  ready: "Ready",
  idle: "Turn complete",
  sleeping: "Complete · retained",
  interrupted: "Interrupted",
  error: "Error",
  offline: "Connection lost · state unknown",
};
export function officeThreadStatus(thread: OrchestrationV2ThreadShell): OfficeStatus {
  if (thread.pendingRuntimeRequest !== null || thread.hasActionableProposedPlan) return "waiting";
  if (thread.lastError || thread.status === "failed") return "error";
  const status = thread.activityRunStatus ?? thread.status;
  if (status === "preparing" || status === "queued" || status === "starting") return "starting";
  if (status === "running") return "working";
  if (
    status === "waiting" ||
    thread.blockedOnThreadWait ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  )
    return "working";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  return thread.latestRunId === null ? "ready" : "idle";
}
export function officeExcerpt(text: string | null | undefined, fallback: string): string {
  return text?.replace(/\s+/g, " ").trim().slice(0, 180) || fallback;
}
export function deriveOfficeActors(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  children: ReadonlyArray<OrchestrationV2OfficeChild>,
  online: boolean,
): ReadonlyArray<OfficeActor> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const actors = new Map<string, OfficeActor>();
  const represented = new Set(
    children.flatMap((child) => (child.childThreadId ? [child.childThreadId] : [])),
  );
  for (const thread of threads) {
    if (thread.deletedAt || represented.has(thread.id)) continue;
    const native =
      thread.creationSource === "provider" && thread.lineage.relationshipToParent === "subagent";
    const child =
      native || thread.lineage.relationshipToParent === "subagent" || thread.delegatedFrom != null;
    if (thread.archivedAt && !child) continue;
    const retainChild = child && thread.settlementSource !== "explicit";
    if (!native && !retainChild && thread.settledAt !== null && thread.settledOverride !== "active")
      continue;
    const ref = scopeThreadRef(environmentId, thread.id);
    const state = officeThreadStatus(thread);
    const status = !online ? "offline" : child && state === "idle" ? "sleeping" : state;
    const chatRef = native ? scopeThreadRef(environmentId, thread.lineage.rootThreadId) : ref;
    actors.set(scopedThreadKey(ref), {
      key: scopedThreadKey(ref),
      projectId: thread.projectId,
      title: thread.title,
      child,
      native,
      threadRef: ref,
      chatRef,
      status,
      bubble: officeExcerpt(
        status === "offline"
          ? null
          : (thread.lastError ??
              (thread.latestVisibleMessage?.role === "assistant"
                ? thread.latestVisibleMessage.text
                : null)),
        OFFICE_STATUS_LABELS[status],
      ),
      shell: thread,
      closureKnown: false,
    });
  }
  for (const child of children) {
    if (child.remoteChild) continue;
    const owner = byId.get(child.threadId);
    if (!owner || owner.deletedAt) continue;
    const thread = child.childThreadId ? byId.get(child.childThreadId) : undefined;
    const threadState = thread ? officeThreadStatus(thread) : null;
    const activeThread =
      threadState === "starting" || threadState === "working" || threadState === "waiting";
    const started = thread?.latestRunStartedAt ?? thread?.latestRunRequestedAt;
    if (
      child.closedAt != null &&
      !(
        activeThread &&
        started != null &&
        DateTime.toEpochMillis(started) > DateTime.toEpochMillis(child.closedAt)
      )
    )
      continue;
    if (
      child.origin === "app_owned" &&
      thread?.settledOverride === "settled" &&
      thread.settlementSource === "explicit"
    )
      continue;
    const ref = scopeThreadRef(environmentId, child.childThreadId ?? owner.id);
    const key = child.childThreadId
      ? scopedThreadKey(ref)
      : `${scopedThreadKey(ref)}:child:${child.id}`;
    const native = child.origin === "provider_native";
    const status: OfficeStatus = !online
      ? "offline"
      : activeThread
        ? threadState!
        : child.status === "completed" ||
            (child.status === "idle" && (child.completedAt != null || child.result != null))
          ? "sleeping"
          : child.status === "idle"
            ? "ready"
            : child.status === "failed"
              ? "error"
              : child.status === "cancelled" || child.status === "interrupted"
                ? "interrupted"
                : child.status === "waiting"
                  ? "working"
                  : child.status === "pending"
                    ? "starting"
                    : "working";
    const chatRef =
      native || !thread ? scopeThreadRef(environmentId, owner.lineage.rootThreadId) : ref;
    actors.set(key, {
      key,
      projectId: owner.projectId,
      title: child.title ?? thread?.title ?? "Subagent",
      child: true,
      native: native || !thread,
      threadRef: ref,
      chatRef,
      status,
      bubble: officeExcerpt(
        status === "offline" ? null : child.progress || child.result,
        OFFICE_STATUS_LABELS[status],
      ),
      shell: thread ?? owner,
      closureKnown: child.closedAt !== undefined,
    });
  }
  return [...actors.values()].sort((a, b) => a.key.localeCompare(b.key));
}
