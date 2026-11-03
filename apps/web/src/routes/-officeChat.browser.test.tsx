import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { Route } from "./_chat";

const ChatRouteLayout = Route.options.component!;

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const router = await importOriginal<typeof import("@tanstack/react-router")>();
  const { use } = await import("react");
  const { OfficeChatContext } = await import("../components/office/OfficeChatContext");
  const { EnvironmentId, ThreadId } = await import("@t3tools/contracts");
  return {
    ...router,
    useMatches: ({ select }: { select: (matches: { pathname: string }[]) => unknown }) =>
      select([{ pathname: "/office" }]),
    Outlet: function OfficeEntry() {
      const chat = use(OfficeChatContext);
      return (
        <button
          onClick={() =>
            chat.open({
              environmentId: EnvironmentId.make("local"),
              threadId: ThreadId.make("chat"),
            })
          }
        >
          Open office chat
        </button>
      );
    },
  };
});
vi.mock("../hooks/useThreadRouteTarget", () => ({ useThreadRouteTarget: () => null }));
vi.mock("../components/ThreadRouteView", () => ({
  ThreadRouteView: () => <textarea aria-label="Chat composer" />,
}));
vi.mock("../components/promptLinks/ThreadLinkPrompt", () => ({ ThreadLinkPrompt: () => null }));

it("dismisses office chat with the close button and Escape when focus is outside the host", async () => {
  await using screen = await render(<ChatRouteLayout />);
  await screen.getByRole("button", { name: "Open office chat", exact: true }).click();
  await expect.element(screen.getByRole("dialog", { name: "Office chat" })).toBeVisible();
  await screen.getByRole("button", { name: "Close office chat" }).click();
  await expect.element(screen.getByRole("dialog", { name: "Office chat" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Open office chat", exact: true }).click();
  await expect.element(screen.getByRole("dialog", { name: "Office chat" })).toBeVisible();
  const backdrop = screen.container.querySelector('[aria-hidden="true"].fixed')!;
  backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await expect.element(screen.getByRole("dialog", { name: "Office chat" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Open office chat", exact: true }).click();
  await expect.element(screen.getByRole("dialog", { name: "Office chat" })).toBeVisible();
  // Electron can leave focus on the document after a native titlebar interaction.
  (document.activeElement as HTMLElement).blur();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("dialog", { name: "Office chat" })).not.toBeInTheDocument();
});
