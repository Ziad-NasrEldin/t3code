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
import { cleanTranscript, hasUnknownResponseKind } from "./cleanTranscript";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * reasoning delta re-renders the timeline without re-rendering ChatView. Streamed
 * assistant text reaches only its own row, through useAssistantMessageText.
 */
export function ThreadTimeline({
  clean = false,
  threadDetailRef,
  entriesInput,
  draftEntries,
  activeThreadKey,
  syncing,
  detailLoading,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries"> & {
  clean?: boolean;
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
  const transcript = cleanTranscript(displayedEntries);
  const requests = displayedEntries.filter(
    (entry) =>
      entry.kind === "event" &&
      (entry.projectedItem.item.type === "secret_request" ||
        entry.projectedItem.item.type === "link_request"),
  );
  return (
    <>
      {hasUnknownResponseKind(displayedEntries) ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          Some responses have no final-response metadata. Open this thread in normal T3 chat to see
          its full history.
        </p>
      ) : null}
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
