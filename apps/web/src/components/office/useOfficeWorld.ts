import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";
import type { OfficeActor } from "@t3tools/client-runtime/state/office";
import { allocateStable, projectVariant, siteAt } from "./officeLayout";
import type { SceneRoom, VisualActor } from "./OfficeScene";
import type { OfficeMotion } from "./officeMotion";

function readAssignments(key: string): {
  sites: Record<string, number>;
  actors: Record<string, number>;
} {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (typeof value !== "object" || value === null) return { sites: {}, actors: {} };
    const raw = value as { sites?: unknown; actors?: unknown };
    const numbers = (input: unknown) =>
      typeof input === "object" && input !== null
        ? Object.fromEntries(
            Object.entries(input).filter(
              ([, v]) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
            ),
          )
        : {};
    return { sites: numbers(raw.sites), actors: numbers(raw.actors) };
  } catch {
    return { sites: {}, actors: {} };
  }
}
interface World {
  readonly signature: string;
  readonly actors: ReadonlyArray<VisualActor>;
  readonly rooms: ReadonlyArray<SceneRoom>;
  readonly slots: Record<string, number>;
  readonly sites: Record<string, number>;
  readonly online: boolean;
  readonly restored: boolean;
  readonly visible: boolean;
}
export function useOfficeWorld(
  environmentId: string,
  actors: ReadonlyArray<OfficeActor>,
  titles: ReadonlyMap<string, string>,
  online: boolean,
  loaded: boolean,
  motion: OfficeMotion,
  visible: boolean,
) {
  const storageKey = `t3:signal-office:layout:v1:${environmentId}`;
  const [saved] = useState(() => readAssignments(storageKey));
  const [timers] = useState(() => new Map<string, ReturnType<typeof setTimeout>>());
  const signature =
    `${online}:${loaded}:${visible}:` +
    actors
      .map(
        (actor) =>
          `${actor.key}:${actor.status}:${actor.title}:${actor.bubble}:${DateTime.toEpochMillis(actor.shell.updatedAt)}:${actor.closureKnown}`,
      )
      .join("\u0000");
  const [world, setWorld] = useState<World>({
    signature: "",
    actors: [],
    rooms: [],
    slots: saved.actors,
    sites: saved.sites,
    online: false,
    restored: false,
    visible,
  });
  if (world.signature !== signature) {
    const current = new Map(actors.map((actor) => [actor.key, actor]));
    const entries: VisualActor[] = world.actors.flatMap<VisualActor>((visual) => {
      const next = current.get(visual.actor.key);
      if (next) {
        current.delete(next.key);
        return [
          {
            actor: next,
            transition: visual.transition === "departing" ? "none" : visual.transition,
          },
        ];
      }
      if (!online) return [{ ...visual, actor: { ...visual.actor, status: "offline" as const } }];
      return world.online && world.visible && visible
        ? [{ ...visual, transition: "departing" as const }]
        : [];
    });
    for (const actor of current.values())
      entries.push({
        actor,
        transition:
          world.restored && world.online && online && world.visible && visible
            ? "arriving"
            : "none",
      });
    const projectIds = [...new Set(entries.map((visual) => visual.actor.projectId))];
    const roomIds = [...new Set([...world.rooms.map((room) => room.id), ...projectIds])];
    const sites = allocateStable(world.sites, roomIds);
    const rooms = roomIds.map((id) => {
      const prior = world.rooms.find((room) => room.id === id);
      return {
        id,
        title: titles.get(id) ?? prior?.title ?? "Project",
        site: siteAt(sites[id]!),
        variant: projectVariant(id),
        deck: 0,
        attaching: prior?.attaching ?? (world.restored && world.online && online),
        removing: !projectIds.includes(id as OfficeActor["projectId"]),
      };
    });
    const slots: Record<string, number> = {};
    for (const id of projectIds) {
      const keys = entries
        .filter((visual) => visual.actor.projectId === id)
        .map((visual) => visual.actor.key);
      const occupied = new Set<number>();
      for (const key of keys) {
        const actor = entries.find((entry) => entry.actor.key === key)!.actor;
        const prior = world.slots[key];
        if (prior !== undefined && prior % 2 === (actor.child ? 1 : 0) && !occupied.has(prior)) {
          slots[key] = prior;
          occupied.add(prior);
        }
      }
      for (const key of keys) {
        if (slots[key] !== undefined) continue;
        const actor = entries.find((entry) => entry.actor.key === key)!.actor;
        let slot = actor.child ? 1 : 0;
        while (occupied.has(slot)) slot += 2;
        slots[key] = slot;
        occupied.add(slot);
      }
    }
    setWorld({
      signature,
      actors: entries,
      rooms,
      slots,
      sites,
      online,
      restored: world.restored || loaded,
      visible,
    });
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- consumes one completion boundary per rendered lifecycle effect, allowing slow asset loads and safe item recovery before removal
  useEffect(
    () =>
      motion.subscribeLifecycle((key, transition) =>
        setWorld((previous) => {
          const nextActors = previous.actors.flatMap((entry) =>
            entry.actor.key !== key || entry.transition !== transition
              ? [entry]
              : transition === "departing"
                ? []
                : [{ ...entry, transition: "none" as const }],
          );
          return {
            ...previous,
            actors: nextActors,
            rooms: previous.rooms.map((room) => ({
              ...room,
              removing: !nextActors.some((entry) => entry.actor.projectId === room.id),
            })),
          };
        }),
      ),
    [motion],
  );
  const transitions = [
    ...world.actors
      .filter((visual) => visual.transition !== "none")
      .map((visual) => `actor:${visual.actor.key}:${visual.transition}`),
    ...world.rooms
      .filter((room) => room.attaching || room.removing)
      .map((room) => `room:${room.id}:${room.removing ? "removing" : "attaching"}`),
  ];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- completes only retained cosmetic transitions; membership changes themselves come from the authoritative office inventory
  useEffect(() => {
    const active = new Set(transitions);
    for (const [key, timer] of timers)
      if (!active.has(key)) {
        clearTimeout(timer);
        timers.delete(key);
      }
    for (const visual of world.actors) {
      if (visual.transition === "none") continue;
      const id = `actor:${visual.actor.key}:${visual.transition}`;
      if (timers.has(id)) continue;
      const duration = 20_000;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setWorld((previous) => {
            const nextActors = previous.actors.flatMap((entry) =>
              entry.actor.key !== visual.actor.key || entry.transition !== visual.transition
                ? [entry]
                : entry.transition === "departing"
                  ? []
                  : [{ ...entry, transition: "none" as const }],
            );
            return {
              ...previous,
              actors: nextActors,
              rooms: previous.rooms.map((room) => ({
                ...room,
                removing: !nextActors.some((entry) => entry.actor.projectId === room.id),
              })),
            };
          });
        }, duration),
      );
    }
    for (const room of world.rooms) {
      if (!room.attaching && !room.removing) continue;
      const id = `room:${room.id}:${room.removing ? "removing" : "attaching"}`;
      if (timers.has(id)) continue;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setWorld((previous) => ({
            ...previous,
            rooms: previous.rooms.flatMap((entry) =>
              entry.id !== room.id
                ? [entry]
                : entry.removing
                  ? []
                  : [{ ...entry, attaching: false }],
            ),
          }));
        }, 800),
      );
    }
  }, [timers, transitions, world.actors, world.rooms]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists client-local placement identities without thread content or server execution state
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ sites: world.sites, actors: world.slots }));
    } catch {
      /* Storage exhaustion does not block chat. */
    }
  }, [storageKey, world.sites, world.slots]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears only this office's animation deadlines on teardown
  useEffect(
    () => () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    [timers],
  );
  return world;
}
