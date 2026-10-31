import { createRef, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { ThreadTimeline } from "./ThreadTimeline";

// SSR drives the actual filter -> row projection -> message renderer without a browser.
// Stores are isolated, diff workers are inactive, and the viewport virtualizer materializes
// every row. Filtering, projection, message/Markdown and attachment renderers are real.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: ReadonlyArray<{ id: string }>;
    renderItem: (input: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <>
      {ListHeaderComponent}
      {data.map((item) => (
        <div key={item.id}>{renderItem({ item })}</div>
      ))}
      {ListFooterComponent}
    </>
  ),
}));
vi.mock(import("../../state/entities"), () => ({
  useTimelineVisibleTurnItems: () => [],
  useAssistantMessageText: () => null,
  useProject: () => null,
  useProjects: () => [],
  useThreadShell: () => null,
  useQuietThreadShell: () => null,
}));
vi.mock(import("../../hooks/useIncrementalTimelineEntries"), () => ({
  useIncrementalTimelineEntries: () => [],
}));
vi.mock(import("../DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useDiffWorkerPool: () => undefined,
}));

it("renders every clean final part and attachment without a work disclosure or empty reply", () => {
  const at = "2026-10-31T00:00:00Z";
  const row = (id: string, text: string, metadata: Partial<ChatMessage> = {}): TimelineEntry => ({
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text,
      runId: RunId.make("multipart"),
      streaming: false,
      createdAt: at,
      updatedAt: at,
      responseKind: "final",
      ...metadata,
    },
  });
  const entries = [
    row("human", "Keep all final outputs", { role: "user", createdBy: "user" }),
    row("commentary", "INTERNAL_COMMENTARY", { responseKind: "commentary" }),
    {
      id: "tool",
      kind: "work" as const,
      createdAt: at,
      entry: {
        id: "tool",
        createdAt: at,
        label: "INTERNAL_TOOL",
        tone: "tool" as const,
        detail: "INTERNAL_REASONING",
        runId: RunId.make("multipart"),
      },
    },
    row("first", "Final part one"),
    row("second", "Final part two"),
    row("attachment", "", {
      attachments: [
        { id: "result", type: "file", name: "result.txt", mimeType: "text/plain", sizeBytes: 5 },
        {
          id: "future",
          type: "future-type",
          name: "future-output.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        },
      ],
    }),
    row("image", "", {
      attachments: [
        {
          id: "image",
          type: "image",
          name: "result.png",
          mimeType: "image/png",
          sizeBytes: 68,
          previewUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/paV8AAAAASUVORK5CYII=",
        },
      ],
    }),
  ];
  const props: ComponentProps<typeof ThreadTimeline> = {
    clean: true,
    threadDetailRef: null,
    entriesInput: { optimisticMessages: [] },
    draftEntries: entries,
    activeThreadKey: "environment-local:clean-render",
    syncing: false,
    detailLoading: false,
    isWorking: false,
    listRef: createRef(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: "environment-local:clean-render",
    onOpenThread: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    onIsAtEndChange: () => {},
    liveFollowEnabled: true,
  };
  const html = renderToStaticMarkup(<ThreadTimeline {...props} />);
  for (const text of [
    "Keep all final outputs",
    "Final part one",
    "Final part two",
    "result.txt",
    "future-output.bin",
    'aria-label="Preview result.txt"',
    'alt="result.png"',
    'aria-label="Preview result.png"',
  ])
    expect(html).toContain(text);
  for (const text of [
    "INTERNAL_COMMENTARY",
    "INTERNAL_TOOL",
    "INTERNAL_REASONING",
    "Worked",
    "(empty response)",
    "turn-fold",
  ])
    expect(html).not.toContain(text);
});
