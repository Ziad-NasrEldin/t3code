import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";
import type { OfficeActor } from "@t3tools/client-runtime/state/office";
import { completeActor, completeRoom, reconcileWorld, type World } from "./officeWorld";
import type { OfficeMotion } from "./officeMotion";

function readAssignments(key: string): {
  sites: Record<string, number>;
  actors: Record<string, number>;
  rests: Record<string, number>;
} {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (typeof value !== "object" || value === null) return { sites: {}, actors: {}, rests: {} };
    const raw = value as { sites?: unknown; actors?: unknown; rests?: unknown };
    const numbers = (input: unknown) =>
      typeof input === "object" && input !== null
        ? Object.fromEntries(
            Object.entries(input).filter(
              ([, v]) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
            ),
          )
        : {};
    return { sites: numbers(raw.sites), actors: numbers(raw.actors), rests: numbers(raw.rests) };
  } catch {
    return { sites: {}, actors: {}, rests: {} };
  }
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
    rests: saved.rests,
    generation: 0,
    online: false,
    restored: false,
    visible,
  });
  if (world.signature !== signature) {
    setWorld(reconcileWorld(world, actors, titles, online, loaded, visible, signature));
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- consumes one completion boundary per rendered lifecycle effect, allowing slow asset loads and safe item recovery before removal
  useEffect(
    () =>
      motion.subscribeLifecycle((key, transition, generation) =>
        setWorld((previous) => completeActor(previous, key, transition, generation)),
      ),
    [motion],
  );
  const transitions = [
    ...world.actors
      .filter((visual) => visual.transition !== "none")
      .map((visual) => `actor:${visual.actor.key}:${visual.transition}:${visual.generation}`),
    ...world.rooms
      .filter((room) => room.attaching || room.removing)
      .map(
        (room) => `room:${room.id}:${room.removing ? "removing" : "attaching"}:${room.generation}`,
      ),
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
      const id = `actor:${visual.actor.key}:${visual.transition}:${visual.generation}`;
      if (timers.has(id)) continue;
      const duration = 20_000;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setWorld((previous) =>
            completeActor(previous, visual.actor.key, visual.transition, visual.generation),
          );
        }, duration),
      );
    }
    for (const room of world.rooms) {
      if (!room.attaching && !room.removing) continue;
      const id = `room:${room.id}:${room.removing ? "removing" : "attaching"}:${room.generation}`;
      if (timers.has(id)) continue;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setWorld((previous) =>
            completeRoom(previous, room.id, room.removing === true, room.generation),
          );
        }, 800),
      );
    }
  }, [timers, transitions, world.actors, world.rooms]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists client-local placement identities without thread content or server execution state
  useEffect(() => {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ sites: world.sites, actors: world.slots, rests: world.rests }),
      );
    } catch {
      /* Storage exhaustion does not block chat. */
    }
  }, [storageKey, world.sites, world.slots, world.rests]);
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
