import {
  lazy,
  Suspense,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  OFFICE_STATUS_LABELS,
  officeExcerpt,
  type OfficeActor,
  type OfficeStatus,
} from "@t3tools/client-runtime/state/office";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ArrowLeftIcon,
  Building2Icon,
  CheckIcon,
  CircleAlertIcon,
  CoffeeIcon,
  HandIcon,
  LampDeskIcon,
  MapIcon,
  MessageCircleIcon,
  MoonIcon,
  PauseIcon,
  SearchIcon,
  Settings2Icon,
  SofaIcon,
  SparklesIcon,
  Volume2Icon,
  VolumeXIcon,
  WifiOffIcon,
  XIcon,
  KeyboardIcon,
  DicesIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useNativeTitlebarHeight } from "../../lib/windowControlsOverlay";
import { isElectron } from "../../env";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useQuietThreadShells, useThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useStableCallback } from "../../hooks/useStableCallback";
import { deriveCanInterruptRunningThread } from "../../session-logic";
import { OfficeChatContext } from "./OfficeChatContext";
import { useCloseAppModal } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { OfficeAudio, readOfficePreferences, type OfficePreferences } from "./officeAudio";
import { OfficeMotion, type Amenity } from "./officeMotion";
import { useOfficeData } from "./useOfficeData";
import { useOfficeWorld } from "./useOfficeWorld";
import { projectRoomKey } from "./officeLayout";
import type { OfficeFocus } from "./OfficeScene";
import { cn } from "../../lib/utils";

const OfficeScene = lazy(() =>
  import("./OfficeScene").then((module) => ({ default: module.OfficeScene })),
);
const STATUS_ICONS: Record<OfficeStatus, typeof CheckIcon> = {
  starting: SparklesIcon,
  working: KeyboardIcon,
  thinking: LoaderCircleIcon,
  streaming: MessageCircleIcon,
  waiting: HandIcon,
  ready: CheckIcon,
  idle: CheckIcon,
  sleeping: MoonIcon,
  interrupted: PauseIcon,
  error: CircleAlertIcon,
  offline: WifiOffIcon,
};
function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}
function visibilitySnapshot() {
  return document.visibilityState === "visible";
}
function Status({ status }: { status: OfficeStatus }) {
  const Icon = STATUS_ICONS[status];
  return (
    <Icon
      aria-label={OFFICE_STATUS_LABELS[status]}
      className={cn(
        "size-4 shrink-0",
        status === "waiting" ? "text-warning" : status === "error" ? "text-error" : "text-current",
      )}
    />
  );
}
function ActivityBubble({ actor, motion }: { actor: OfficeActor; motion: OfficeMotion }) {
  useEnvironmentThread(actor.threadRef.environmentId, actor.threadRef.threadId);
  const items = useThreadVisibleTurnItems(actor.threadRef);
  const latest = items.at(-1)?.item;
  const text =
    latest?.type === "reasoning"
      ? latest.text
      : latest?.type === "assistant_message"
        ? latest.text
        : latest?.title;
  const excerpt = officeExcerpt(text, actor.bubble);
  const activity: OfficeStatus =
    actor.status === "working" && latest?.type === "reasoning"
      ? "thinking"
      : actor.status === "working" && latest?.type === "assistant_message" && latest.streaming
        ? "streaming"
        : actor.status;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes provider-visible activity changes to the independent actor pose controller without rebuilding geometry per token
  useEffect(() => {
    motion.setActivity(actor.key, activity);
    return () => motion.setActivity(actor.key, null);
  }, [actor.key, activity, motion]);
  const [shown, setShown] = useState(excerpt);
  const updateExcerpt = useEffectEvent(() => setShown(excerpt));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bounds live selected-bubble text updates independently of scene geometry and pose updates
  useEffect(() => {
    const timer = setInterval(() => updateExcerpt(), 350);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="flex max-w-64 items-center gap-1.5 text-xs">
      <Status status={activity} />
      <span className="truncate">{shown}</span>
    </span>
  );
}
function ActorActions({
  actor,
  online,
  onDismiss,
}: {
  actor: OfficeActor;
  online: boolean;
  onDismiss: () => void;
}) {
  const chat = use(OfficeChatContext),
    actions = useThreadActions();
  const canOperate = useEnvironmentScope(
    actor.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const interrupt = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<"settle" | "pause" | null>(null),
    [error, setError] = useState<string | null>(null);
  const shell = presentThreadShell(actor.threadRef.environmentId, actor.shell);
  const canInterrupt =
    !actor.native && online && canOperate && deriveCanInterruptRunningThread(true, shell.runtime);
  const canSettle =
    !actor.native &&
    online &&
    canOperate &&
    actor.status !== "waiting" &&
    !deriveCanInterruptRunningThread(true, shell.runtime);
  const run = async (operation: "settle" | "pause") => {
    if (pending !== null) return;
    setPending(operation);
    setError(null);
    const target = actor.threadRef;
    const result =
      operation === "settle"
        ? await actions.settleThread(target)
        : await interrupt({
            environmentId: target.environmentId,
            input: { threadId: target.threadId },
          });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : "The operation failed. The agent remains in its actual state.",
      );
    }
    setPending(null);
  };
  return (
    <div
      className="pointer-events-auto mt-2 flex max-w-[min(32rem,90vw)] flex-col gap-2 rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg"
      role="group"
      aria-label={`${actor.title} actions`}
    >
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => chat.open(actor.chatRef)}>
          <MessageCircleIcon />
          {actor.native ? "Open parent chat" : "Open chat"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canSettle || pending !== null}
          onClick={() => void run("settle")}
        >
          <SparklesIcon />
          {pending === "settle" ? "Settling…" : "Settle thread"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canInterrupt || pending !== null}
          onClick={() => void run("pause")}
        >
          <PauseIcon />
          {pending === "pause" ? "Stopping…" : "Pause chat"}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Dismiss actions" onClick={onDismiss}>
          <XIcon />
        </Button>
      </div>
      <p className="px-2 text-2xs text-muted-foreground">
        {actor.native
          ? "Child controls belong to the parent. Completion stays visible until explicit release is known."
          : "Pause stops the current turn. Settle retains the normal Undo action."}
      </p>
      {error ? (
        <p role="alert" className="max-w-sm px-2 text-xs text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
function Preferences({
  prefs,
  onChange,
  audio,
}: {
  prefs: OfficePreferences;
  onChange: (prefs: OfficePreferences) => void;
  audio: OfficeAudio;
}) {
  const update = (next: OfficePreferences) => {
    audio.unlock();
    onChange(next);
  };
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Office preferences">
            <Settings2Icon />
          </Button>
        }
      />
      <PopoverPopup className="w-72" align="end">
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">Office preferences</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => update({ ...prefs, mute: !prefs.mute })}
            >
              {prefs.mute ? <VolumeXIcon /> : <Volume2Icon />}
              {prefs.mute ? "Unmute" : "Mute"}
            </Button>
          </div>
          <label className="flex flex-col gap-2">
            Music · {Math.round(prefs.music * 100)}%
            <Input
              nativeInput
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={prefs.music}
              onChange={(event) => update({ ...prefs, music: Number(event.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-2">
            Effects · {Math.round(prefs.effects * 100)}%
            <Input
              nativeInput
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={prefs.effects}
              onChange={(event) => update({ ...prefs, effects: Number(event.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={prefs.reducedMotion}
              onCheckedChange={(checked) => onChange({ ...prefs, reducedMotion: checked === true })}
            />
            Reduce office motion
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={prefs.bubbles}
              onCheckedChange={(checked) => onChange({ ...prefs, bubbles: checked === true })}
            />
            Show activity excerpts
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={prefs.quality === "low"}
              onCheckedChange={(checked) =>
                onChange({ ...prefs, quality: checked ? "low" : "standard" })
              }
            />
            Lower graphics load
          </label>
          <p className="text-xs text-muted-foreground">
            Music is opt-in. Office sounds pause while hidden. Input and completion notifications
            use T3's normal controls.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
function OfficeFloor({
  environmentId,
  prefs,
  audio,
  visible,
  onRemote,
}: {
  environmentId: EnvironmentId;
  prefs: OfficePreferences;
  audio: OfficeAudio;
  visible: boolean;
  onRemote: (ref: ScopedThreadRef) => void;
}) {
  const chat = use(OfficeChatContext),
    data = useOfficeData(environmentId, true, visible && !chat.isOpen),
    projects = useProjects();
  const titles = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const [motion] = useState(() => new OfficeMotion()),
    [labels] = useState(() => new Map<string, HTMLElement>());
  const world = useOfficeWorld(
    environmentId,
    data.actors,
    titles,
    data.online,
    data.ready,
    motion,
    visible && !chat.isOpen,
  );
  const [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    [directory, setDirectory] = useState(true),
    [attentionOnly, setAttentionOnly] = useState(false),
    [directoryPage, setDirectoryPage] = useState(0),
    [overlayKeys, setOverlayKeys] = useState<{
      actors: ReadonlyArray<string>;
      rooms: ReadonlyArray<string>;
    }>({ actors: [], rooms: [] }),
    [lamp, setLamp] = useState(true),
    [notice, setNotice] = useState<string | null>(null),
    [metrics, setMetrics] = useState("Graphics loading…");
  const [focus, setFocus] = useState<OfficeFocus>({ x: 0, z: 0, span: 54, serial: 0 });
  const systemReduced = useMediaQuery("(prefers-reduced-motion: reduce)"),
    reduced = systemReduced || prefs.reducedMotion;
  const directoryRef = useRef<HTMLInputElement>(null);
  const soundedTransitions = useRef(new Set<string>());
  const actor = data.actors.find((actor) => actor.key === selected) ?? null;
  const select = (key: string) => {
    setSelected(key);
    const life = motion.lives.get(key),
      entry = world.actors.find((v) => v.actor.key === key),
      room = world.rooms.find(
        (room) =>
          room.id === (entry ? projectRoomKey(entry.actor.projectId, world.slots[key] ?? 0) : null),
      );
    if (life)
      setFocus({
        x: life.position.x,
        z: life.position.z,
        span: 19,
        serial: focus.serial + 1,
      });
    else if (room)
      setFocus({
        x: room.site.x,
        z: room.site.z,
        span: 19,
        serial: focus.serial + 1,
      });
  };
  const selectStable = useStableCallback(select);
  const amenity = (key: Amenity | "lamp" | "directory", projectId?: string) => {
    audio.unlock();
    if (key === "lamp") {
      setLamp(!lamp);
      return;
    }
    if (key === "directory") {
      setDirectory(true);
      directoryRef.current?.focus();
      return;
    }
    if (!data.online || !data.ready) {
      setNotice(
        data.online
          ? "Waiting for this environment's current inventory before starting a visit."
          : "Reconnect this environment before starting a visit.",
      );
      return;
    }
    if (reduced) {
      setNotice(
        "Decorative performances are disabled while reduced motion is enabled. Thread controls remain available.",
      );
      return;
    }
    if (!selected) {
      setNotice(
        "Select an agent in the scene or directory first. Visits are cosmetic and never send a prompt.",
      );
      return;
    }
    if (
      projectId &&
      (!actor || projectRoomKey(actor.projectId, world.slots[actor.key] ?? 0) !== projectId)
    ) {
      setNotice("Select an agent in this project before using its keyboard.");
      return;
    }
    setNotice(motion.request(selected, key));
  };
  const amenityStable = useStableCallback(amenity);
  const reportMetrics = useStableCallback(setMetrics);
  const reportVisible = useStableCallback(
    (actorKeys: ReadonlyArray<string>, roomKeys: ReadonlyArray<string>) =>
      setOverlayKeys((previous) =>
        previous.actors.join("|") === actorKeys.join("|") &&
        previous.rooms.join("|") === roomKeys.join("|")
          ? previous
          : { actors: actorKeys, rooms: roomKeys },
      ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- emits quiet lifecycle sounds only for newly observed live arrivals and persisted settlements
  useEffect(() => {
    const next = new Set(
      world.actors
        .filter((v) => v.transition !== "none")
        .map((v) => `${v.actor.key}:${v.transition}`),
    );
    const fresh = [...next].filter((key) => !soundedTransitions.current.has(key));
    soundedTransitions.current = next;
    if (!visible || !data.online) return;
    if (fresh.some((key) => key.endsWith(":departing"))) audio.cue("settle");
    else if (fresh.some((key) => key.endsWith(":arriving"))) audio.cue("arrival");
  }, [audio, visible, data.online, world.actors]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases cosmetic reservations and DOM anchor registrations when switching environments or leaving Office
  useEffect(
    () => () => {
      motion.clear();
      labels.clear();
    },
    [labels, motion],
  );
  const matches = data.actors.filter(
    (actor) =>
      (!attentionOnly || actor.status === "waiting" || actor.status === "error") &&
      `${actor.title} ${titles.get(actor.projectId) ?? ""} ${OFFICE_STATUS_LABELS[actor.status]}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const remoteChildren = data.children.filter(
    (child) => child.remoteChild && child.closedAt == null,
  );
  const totalPages = Math.max(1, Math.ceil(Math.max(matches.length, remoteChildren.length) / 200)),
    page = Math.min(directoryPage, totalPages - 1);
  const directoryRows = matches.slice(page * 200, (page + 1) * 200);
  const focusLobby = () => setFocus({ ...focus, x: 0, z: 0, span: 25, serial: focus.serial + 1 });
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="relative min-h-0 min-w-0 flex-1 bg-background">
        <Suspense
          fallback={
            <p className="absolute inset-x-4 top-8 text-center text-sm text-white">
              Loading the Signal Crew office…
            </p>
          }
        >
          <OfficeScene
            actors={world.actors}
            rooms={world.rooms}
            slots={world.slots}
            rests={world.rests}
            motion={motion}
            focus={focus}
            selected={selected}
            onSelect={selectStable}
            labels={labels}
            visible={visible && !chat.isOpen}
            reduced={reduced}
            lowQuality={prefs.quality === "low"}
            lamp={lamp}
            onAmenity={amenityStable}
            onMetrics={reportMetrics}
            onVisible={reportVisible}
          />
        </Suspense>
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          aria-hidden={chat.isOpen}
        >
          {world.actors
            .filter(
              (visual) =>
                visual.transition !== "departing" && overlayKeys.actors.includes(visual.actor.key),
            )
            .map(({ actor: entry }) => (
              <div
                key={entry.key}
                ref={(element) => {
                  if (element) {
                    labels.set(entry.key, element);
                    motion.wake();
                    return () => {
                      labels.delete(entry.key);
                    };
                  }
                }}
                className="pointer-events-auto absolute left-0 top-0 flex max-w-72 flex-col items-center gap-1"
                hidden
              >
                <Button
                  variant="media-close"
                  size="xs"
                  className="max-w-52"
                  onClick={() => setSelected(entry.key)}
                  aria-label={`${entry.title}, ${OFFICE_STATUS_LABELS[entry.status]}, ${titles.get(entry.projectId) ?? "Project"}`}
                >
                  <Status status={entry.status} />
                  <span className="truncate">{entry.title}</span>
                </Button>
                {prefs.bubbles && (entry.key === selected || entry.status === "waiting") ? (
                  <div className="max-w-64 rounded-md bg-background px-2 py-1 text-foreground shadow-sm">
                    {entry.key === selected &&
                    entry.status !== "offline" &&
                    visible &&
                    !chat.isOpen ? (
                      <ActivityBubble actor={entry} motion={motion} />
                    ) : (
                      <span className="block max-w-64 truncate text-xs">
                        {officeExcerpt(entry.bubble, OFFICE_STATUS_LABELS[entry.status])}
                      </span>
                    )}
                  </div>
                ) : null}
                {entry.key === selected && actor ? (
                  <ActorActions
                    actor={actor}
                    online={data.online && data.ready}
                    onDismiss={() => setSelected(null)}
                  />
                ) : null}
              </div>
            ))}
        </div>
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {world.rooms
            .filter((room) => overlayKeys.rooms.includes(room.id))
            .map((room) => (
              <div
                key={room.id}
                ref={(element) => {
                  if (element) {
                    labels.set(`room:${room.id}`, element);
                    motion.wake();
                    return () => {
                      labels.delete(`room:${room.id}`);
                    };
                  }
                }}
                hidden
                className="pointer-events-auto absolute left-0 top-0 max-w-52"
              >
                <Button
                  size="xs"
                  variant="media-close"
                  onClick={() =>
                    setFocus({
                      x: room.site.x,
                      z: room.site.z,
                      span: 18,
                      serial: focus.serial + 1,
                    })
                  }
                >
                  <span className="truncate">{room.title}</span>
                  <span className="text-2xs">
                    {room.projectId === null
                      ? "Rest terrace"
                      : data.actors.filter(
                          (actor) =>
                            projectRoomKey(actor.projectId, world.slots[actor.key] ?? 0) ===
                            room.id,
                        ).length}
                  </span>
                </Button>
              </div>
            ))}
        </div>
        <div className="absolute left-3 top-3 flex flex-wrap gap-1 rounded-xl bg-background p-1 shadow-md">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFocus({ x: 0, z: 0, span: 54, serial: focus.serial + 1 })}
          >
            <MapIcon />
            Overview
          </Button>
          <Button variant="ghost" size="sm" onClick={focusLobby}>
            <Building2Icon />
            Lobby
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDirectory(!directory)}>
            <SearchIcon />
            Directory
          </Button>
        </div>
        <div
          className="absolute bottom-10 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1 rounded-xl bg-background p-1 shadow-md"
          role="group"
          aria-label="Cosmetic amenities"
        >
          <Button variant="ghost" size="sm" onClick={() => amenity("coffee")}>
            <CoffeeIcon />
            Coffee
          </Button>
          <Button variant="ghost" size="sm" onClick={() => amenity("sofa")}>
            <SofaIcon />
            Sofa
          </Button>
          <Button variant="ghost" size="sm" onClick={() => amenity("keyboard")}>
            <KeyboardIcon />
            Keyboard
          </Button>
          <Button variant="ghost" size="sm" onClick={() => amenity("game")}>
            <DicesIcon />
            Game
          </Button>
          <Button variant="ghost" size="sm" aria-pressed={lamp} onClick={() => amenity("lamp")}>
            <LampDeskIcon />
            Lamp
          </Button>
        </div>
        <p className="absolute bottom-2 left-3 rounded-md bg-background px-2 py-1 text-3xs text-muted-foreground">
          {metrics} · rendering {prefs.quality === "low" ? "8" : "16"} meshes at most · pan / scroll
          to zoom
        </p>
        {!data.online ? (
          <div
            role="status"
            className="absolute inset-x-4 top-20 rounded-lg bg-background p-3 text-sm"
          >
            <WifiOffIcon className="mr-2 inline size-4" />
            State is {data.failed ? "unavailable" : "reconnecting"}. Last known occupants are
            retained; activity and actions are unverified.{" "}
            <Button size="sm" variant="outline" onClick={data.refresh}>
              Retry inventory
            </Button>
          </div>
        ) : null}
        {data.online && !data.ready ? (
          <div
            role="status"
            className="absolute inset-x-4 top-20 rounded-lg bg-background p-3 text-sm"
          >
            {data.failed
              ? "Inventory could not be refreshed. Last known occupants are retained; thread actions are paused."
              : data.actors.length === 0
                ? "Loading retained agents from this environment…"
                : "Synchronizing retained inventory. Last known occupants stay visible until the current inventory is ready."}{" "}
            <Button size="sm" variant="outline" onClick={data.refresh}>
              Retry inventory
            </Button>
          </div>
        ) : null}
        {data.online && data.ready && data.actors.length === 0 ? (
          <div className="absolute inset-x-4 top-1/3 mx-auto max-w-sm rounded-xl bg-background p-5 text-center">
            <p className="font-medium">The office is ready</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Start a thread in T3 to open its project room. Settled work stays available in the
              normal thread list.
            </p>
          </div>
        ) : null}
        {notice ? (
          <div
            role="status"
            className="absolute inset-x-3 bottom-24 mx-auto flex max-w-lg items-start gap-2 rounded-xl bg-background p-3 text-sm shadow-md"
          >
            <p className="flex-1">{notice}</p>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss notice"
              onClick={() => setNotice(null)}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
      </div>
      {directory ? (
        <aside
          className="absolute inset-y-0 right-0 z-10 flex w-72 max-w-[80vw] flex-col border-l bg-background md:relative md:shrink-0"
          aria-label="Office directory"
        >
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <h2 className="text-sm font-medium">Agents · {data.actors.length}</h2>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Close directory"
              onClick={() => setDirectory(false)}
            >
              <XIcon />
            </Button>
          </div>
          <div className="flex flex-col gap-2 px-3 pb-3">
            <Input
              ref={directoryRef}
              aria-label="Find project or agent"
              placeholder="Find a project or agent"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setDirectoryPage(0);
              }}
            />
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={attentionOnly}
                onCheckedChange={(checked) => {
                  setAttentionOnly(checked === true);
                  setDirectoryPage(0);
                }}
              />
              Needs attention
            </label>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 px-2 pb-4">
              {directoryRows.map((entry) => (
                <div
                  key={entry.key}
                  className={cn(
                    "rounded-lg p-2",
                    entry.key === selected ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-start whitespace-normal text-left"
                    onClick={() => select(entry.key)}
                  >
                    <Status status={entry.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{entry.title}</span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {titles.get(entry.projectId) ?? "Project"} ·{" "}
                        {OFFICE_STATUS_LABELS[entry.status]}
                      </span>
                    </span>
                  </Button>
                  {entry.key === selected ? (
                    <div className="mt-1 flex flex-col gap-2">
                      <p className="text-xs text-muted-foreground">
                        {officeExcerpt(entry.bubble, OFFICE_STATUS_LABELS[entry.status])}
                      </p>
                      <ActorActions
                        actor={entry}
                        online={data.online && data.ready}
                        onDismiss={() => setSelected(null)}
                      />
                    </div>
                  ) : null}
                </div>
              ))}

              {remoteChildren.slice(page * 200, (page + 1) * 200).map((child) => (
                <Button
                  key={child.id}
                  variant="ghost"
                  size="sm-multiline"
                  className="h-auto justify-start whitespace-normal text-left"
                  onClick={() => {
                    if (child.remoteChild)
                      onRemote({
                        environmentId: child.remoteChild.environmentId,
                        threadId: child.remoteChild.threadId,
                      });
                  }}
                >
                  <MessageCircleIcon />
                  Remote child · {child.remoteChild?.label}
                  <span className="sr-only">Opens the owning environment chat</span>
                </Button>
              ))}
            </div>
          </ScrollArea>
          {totalPages > 1 ? (
            <div className="flex items-center justify-between border-t px-3 py-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setDirectoryPage(page - 1)}
              >
                Previous
              </Button>
              <span className="text-2xs">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={page + 1 >= totalPages}
                onClick={() => setDirectoryPage(page + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
          <p className="border-t p-3 text-2xs text-muted-foreground">
            Rooms keep their sites as the office grows. Crowded projects extend into rooms on the
            same floor. Lobby rest terraces share the central amenities. Showing up to{" "}
            {prefs.quality === "low" ? 8 : 16} agents and 24 rooms or terraces at a time; the
            directory lists all {data.actors.length} occupants. Select anyone to focus their
            location. Completed children remain on their project floor; closure history can be
            unavailable on some providers.
          </p>
        </aside>
      ) : null}
    </div>
  );
}
export function OfficePage() {
  const { environments } = useEnvironments(),
    primary = usePrimaryEnvironmentId(),
    close = useCloseAppModal(),
    chat = use(OfficeChatContext);
  const shells = useQuietThreadShells();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null),
    [prefs, setPrefs] = useState(readOfficePreferences),
    [audio] = useState(() => new OfficeAudio());
  const selected =
    environments.find((environment) => environment.environmentId === (chosen ?? primary)) ??
    environments[0];
  const backControl = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves keyboard focus into the full-content office and restores its entry control on exit
  useEffect(() => {
    const previous = document.activeElement;
    backControl.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const titlebarHeight = useNativeTitlebarHeight();
  const visible = useSyncExternalStore(subscribeVisibility, visibilitySnapshot, () => false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists reversible client-only preferences and synchronizes the foreground audio graph
  useEffect(() => {
    try {
      localStorage.setItem("t3:signal-office:preferences:v1", JSON.stringify(prefs));
    } catch {
      /* Preferences remain usable when storage is unavailable. */
    }
    if (visible) audio.apply(prefs, chat.isOpen);
    else audio.suspend();
  }, [audio, prefs, chat.isOpen, visible]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes this office's audio context on exit
  useEffect(() => () => audio.dispose(), [audio]);
  return (
    <section
      className="fixed inset-0 z-30 flex min-h-0 flex-col bg-background"
      style={{ paddingTop: titlebarHeight }}
      inert={chat.isOpen}
      aria-label="Signal Crew agent office"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !chat.isOpen) {
          event.preventDefault();
          void close();
        }
        if (event.key !== "Tab") return;
        const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]),input,[tabindex="0"]',
            ),
          ].filter((element) => element.getClientRects().length > 0),
          first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b px-3 py-2",
          isElectron && "drag-region",
        )}
      >
        <Button ref={backControl} size="sm" variant="ghost" onClick={() => void close()}>
          <ArrowLeftIcon />
          Back to T3
        </Button>
        <span className="hidden text-sm font-medium sm:inline">Signal Crew</span>
        <div className="ml-auto max-w-80 min-w-0">
          <Select
            value={selected?.environmentId ?? null}
            onValueChange={(value) => {
              if (value) {
                chat.close();
                setChosen(value as EnvironmentId);
              }
            }}
          >
            <SelectTrigger aria-label="Office environment">
              <SelectValue placeholder="Choose environment">{selected?.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {environments.map((environment) => {
                const attention = shells.filter(
                  (shell) =>
                    shell.environmentId === environment.environmentId &&
                    (shell.hasPendingApprovals || shell.hasPendingUserInput),
                ).length;
                return (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                    {attention > 0 ? ` · ${attention} need input` : ""}
                    {environment.connection.phase !== "connected" ? " · offline / unknown" : ""}
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        </div>
        <Preferences prefs={prefs} onChange={setPrefs} audio={audio} />
      </header>
      {selected?.serverConfig?.officeInventory === true ? (
        <OfficeFloor
          key={selected.environmentId}
          environmentId={selected.environmentId}
          prefs={prefs}
          audio={audio}
          visible={visible}
          onRemote={(ref) => {
            setChosen(ref.environmentId);
            chat.open(ref);
          }}
        />
      ) : (
        <div className="m-auto flex max-w-md flex-col gap-3 p-8 text-center">
          <Building2Icon className="mx-auto size-8" />
          <h1 className="text-lg font-medium">Office inventory is unavailable</h1>
          <p className="text-sm text-muted-foreground">
            {selected?.connection.phase === "connected"
              ? "This environment needs a server with retained office inventory support. Existing chats remain available in T3."
              : "Connect an environment to restore its rooms and retained children. Disconnected data is unknown."}
          </p>
          <Button variant="outline" onClick={() => void close()}>
            Return to T3
          </Button>
        </div>
      )}
    </section>
  );
}
