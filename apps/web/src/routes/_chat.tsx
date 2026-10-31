import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { OfficeChatContext } from "../components/office/OfficeChatContext";
import { useNativeTitlebarHeight } from "../lib/windowControlsOverlay";
import { Button } from "../components/ui/button";
import { XIcon } from "lucide-react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const officeOpen = useMatches({
    select: (matches) => matches.some((match) => match.pathname === "/office"),
  });
  const [officeTarget, setOfficeTarget] = useState<ScopedThreadRef | null>(null);
  if (!officeOpen && officeTarget !== null) setOfficeTarget(null);
  const officeChatOpen = officeOpen && officeTarget !== null;
  const shownTarget: ThreadRouteTarget | null = officeChatOpen
    ? { kind: "server", threadRef: officeTarget }
    : modalOpen
      ? backgroundTarget
      : threadTarget;
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const chatHost = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- traps keyboard focus in the shared mounted chat host and restores its triggering office control
  useEffect(() => {
    if (!officeChatOpen) return;
    const previous = document.activeElement;
    const root = chatHost.current;
    if (!root) return;
    const focusable = () =>
      [
        ...root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, textarea, [tabindex="0"], [contenteditable="true"]',
        ),
      ].filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setOfficeTarget(null);
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [officeChatOpen]);
  return (
    <OfficeChatContext
      value={{ open: setOfficeTarget, close: () => setOfficeTarget(null), isOpen: officeChatOpen }}
    >
      <div
        ref={chatHost}
        style={officeChatOpen ? { top: Math.max(32, nativeTitlebarHeight + 8) } : undefined}
        role={officeChatOpen ? "dialog" : undefined}
        aria-modal={officeChatOpen || undefined}
        aria-label={officeChatOpen ? "Office chat" : undefined}
        className={
          officeChatOpen
            ? "fixed inset-x-3 bottom-3 top-[max(2rem,var(--native-titlebar-height,0px))] z-50 mx-auto flex max-w-4xl flex-col overflow-hidden rounded-2xl bg-background shadow-2xl sm:inset-x-12 sm:bottom-10 sm:top-[max(3rem,var(--native-titlebar-height,0px))]"
            : "contents"
        }
      >
        {officeChatOpen ? (
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
            <span className="text-sm font-medium">Chat · user messages and final responses</span>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close office chat"
              onClick={() => setOfficeTarget(null)}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
        {shownTarget?.kind === "server" && !modalOpen ? (
          <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
        ) : null}
        {shownTarget ? (
          <ThreadRouteView
            target={shownTarget}
            background={modalOpen && !officeChatOpen}
            office={officeChatOpen}
          />
        ) : modalOpen ? (
          <SidebarInset className="h-dvh" />
        ) : (
          <Outlet />
        )}
      </div>
      {modalOpen ? <Outlet /> : null}
    </OfficeChatContext>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
