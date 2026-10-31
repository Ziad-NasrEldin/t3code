import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ComponentProps, useLayoutEffect } from "react";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useTimelineVisibleTurnItems } from "../../state/entities";
import {
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
} from "../ChatView.logic";
import { LinkRequestCard } from "./LinkRequestCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { MessagesTimeline } from "./MessagesTimeline";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * reasoning delta re-renders the timeline without re-rendering ChatView. Streamed
 * assistant text reaches only its own row, through useAssistantMessageText.
 */
export function ThreadTimeline({
  clean = false,
  completedRunIds = [],
  threadDetailRef,
  entriesInput,
  draftEntries,
  activeThreadKey,
  syncing,
  detailLoading,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries"> & {
  clean?: boolean;
  completedRunIds?: ReadonlyArray<string>;
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  threadDetailRef: ScopedThreadRef | null;
  entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  /** A local draft's optimistic rows; null for a server thread. */
  draftEntries: ReadonlyArray<TimelineEntry> | null;
  activeThreadKey: string | null;
  syncing: boolean;
  detailLoading: boolean;
}) {
  const visibleTurnItems = useTimelineVisibleTurnItems(threadDetailRef);
  const serverEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems,
  });
  const entries = draftEntries ?? serverEntries;
  const displayedEntries = resolveThreadSwitchTimeline({
    loading: entries.length === 0 && syncing,
    activeThreadKey,
    nextEntries: entries,
    rememberedForActive: peekRememberedThreadTimeline<typeof entries>(activeThreadKey),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stores the committed ready timeline in the module-level cache used during thread switches
  useLayoutEffect(() => {
    if (detailLoading || entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
      return;
    }
    rememberReadyThreadTimeline({ threadKey: activeThreadKey, entries });
  }, [activeThreadKey, detailLoading, entries]);
  if (!clean) return <MessagesTimeline {...timelineProps} timelineEntries={displayedEntries} />;
  const completed = new Set(completedRunIds);
  const lastResponses = new Map<string, string>();
  for (const entry of displayedEntries) {
    if (
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      !entry.message.streaming &&
      (entry.message.runId === null || completed.has(entry.message.runId))
    )
      lastResponses.set(entry.message.runId ?? entry.id, entry.id);
  }
  const transcript = displayedEntries.filter(
    (entry) =>
      entry.kind === "message" &&
      (entry.message.role === "user" ||
        (entry.message.role === "assistant" &&
          lastResponses.get(entry.message.runId ?? entry.id) === entry.id)),
  );
  const requests = displayedEntries.filter(
    (entry) =>
      entry.kind === "event" &&
      (entry.projectedItem.item.type === "secret_request" ||
        entry.projectedItem.item.type === "link_request"),
  );
  return (
    <>
      {requests.length > 0 ? (
        <section
          aria-label="Operational requests"
          className="flex max-h-52 min-h-0 shrink-0 flex-col border-b"
        >
          <p className="px-4 py-2 text-xs font-medium text-muted-foreground">
            Requests and decisions
          </p>
          <div className="overflow-auto px-4 pb-3">
            {threadDetailRef
              ? requests.map((entry) => {
                  if (entry.kind !== "event") return null;
                  const { item, visibility } = entry.projectedItem;
                  return item.type === "secret_request" ? (
                    <SecretRequestCard
                      key={entry.id}
                      environmentId={threadDetailRef.environmentId}
                      item={item}
                      visibility={visibility}
                    />
                  ) : item.type === "link_request" ? (
                    <LinkRequestCard
                      key={entry.id}
                      environmentId={threadDetailRef.environmentId}
                      item={item}
                      visibility={visibility}
                    />
                  ) : null;
                })
              : null}
          </div>
        </section>
      ) : null}
      <MessagesTimeline {...timelineProps} timelineEntries={transcript} />
    </>
  );
}
