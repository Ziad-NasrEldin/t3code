import { expect, it } from "vite-plus/test";
import { MessageId, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { deriveTimelineEntriesFromVisibleTurnItems, type TimelineEntry } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import type { ChatMessage } from "../../types";
import { cleanTranscript } from "./cleanTranscript";
import { deriveMessagesTimelineRowsWithState } from "./MessagesTimeline.logic";
const row = (id: string, metadata: Partial<ChatMessage> = {}): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: "2026-10-31T00:00:00Z",
  message: {
    id: MessageId.make(id),
    role: "user",
    text: id,
    runId: RunId.make("run"),
    streaming: false,
    createdAt: "2026-10-31T00:00:00Z",
    updatedAt: "2026-10-31T00:00:00Z",
    ...metadata,
  },
});
it("keeps human authored user content and attachments with intentional legacy handling", () => {
  const entries = [
    row("human", { createdBy: "user", creationSource: "web" }),
    row("legacy"),
    row("attachment", {
      createdBy: "user",
      text: "",
      attachments: [
        { id: "upload", type: "file", name: "brief.txt", mimeType: "text/plain", sizeBytes: 12 },
      ],
    }),
    row("agent", { createdBy: "agent", creationSource: "mcp" }),
    row("system", { createdBy: "system", creationSource: "server" }),
    row("compaction", { createdBy: "user", idleCompaction: "onReturn" }),
    row("delegated", { senderThreadId: ThreadId.make("sender") }),
    row("scheduled", { createdBy: "user", scheduledTaskId: ScheduledTaskId.make("schedule") }),
    row("provider", { creationSource: "provider" }),
  ];
  expect(cleanTranscript(entries)).toEqual(entries.slice(0, 3));
  expect(entries).toHaveLength(9); // Ordinary chat continues to consume the unchanged canonical entries.
});
it("keeps all complete final parts across runs and pages, excluding commentary and live text", () => {
  const entries = [
    row("progress", { role: "assistant", responseKind: "commentary" }),
    row("first", { role: "assistant", responseKind: "final" }),
    row("attachment", {
      role: "assistant",
      responseKind: "final",
      text: "",
      attachments: [
        { id: "result", type: "file", name: "result.txt", mimeType: "text/plain", sizeBytes: 5 },
      ],
    }),
    row("untracked", { role: "assistant", responseKind: "final", runId: null }),
    row("stream", { role: "assistant", responseKind: "final", streaming: true }),
    row("legacy-unknown", { role: "assistant" }),
  ];
  expect(cleanTranscript(entries)).toEqual(entries.slice(1, 4));
  expect(cleanTranscript(entries.slice(2))).toEqual(entries.slice(2, 4));
  const completed = row("stream", { role: "assistant", responseKind: "final" });
  expect(cleanTranscript([...entries.slice(0, 4), completed])).toEqual([
    ...entries.slice(1, 4),
    completed,
  ]);
  const input = {
    timelineEntries: cleanTranscript(entries),
    isWorking: true,
    latestRun: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    clean: true,
  };
  const projection = deriveMessagesTimelineRowsWithState(input);
  expect(projection.rows.map((entry) => entry.id)).toEqual(["first", "attachment", "untracked"]);
  expect(projection.rows.every((entry) => entry.kind === "message")).toBe(true);
  // Completed/live and clean/full transitions must invalidate the incremental row cache.
  const settled = deriveMessagesTimelineRowsWithState(
    { ...input, timelineEntries: cleanTranscript([...entries, completed]) },
    projection,
  );
  expect(settled.rows.map((entry) => entry.id)).toEqual([
    "first",
    "attachment",
    "untracked",
    "stream",
  ]);
  const full = deriveMessagesTimelineRowsWithState({ ...input, clean: false }, projection);
  expect(full.rows.some((entry) => entry.kind !== "message")).toBe(true);
});

it("excludes canonical tool traces and reasoning while ordinary timeline retains them", () => {
  const fixture = makeStreamingTimelineFixture("Working now");
  const items = fixture.visibleTurnItems.map((row) =>
    row.item.type === "assistant_message" && !row.item.streaming
      ? { ...row, item: { ...row.item, responseKind: "final" as const } }
      : row,
  );
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: items,
    optimisticMessages: [],
  });
  expect(entries.some((entry) => entry.kind === "work")).toBe(true);
  expect(cleanTranscript(entries).map((entry) => entry.id)).toEqual([
    "history-user",
    "history-assistant",
    "live-user",
  ]);
  expect(entries.some((entry) => entry.kind === "message" && entry.message.streaming)).toBe(true);
});
