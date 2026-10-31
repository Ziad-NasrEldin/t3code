import type { OfficeActor } from "@t3tools/client-runtime/state/office";
import {
  allocateStable,
  projectRoomKey,
  projectVariant,
  restAreaKey,
  siteAt,
} from "./officeLayout";
import type { SceneRoom, VisualActor } from "./OfficeScene";

export interface World {
  readonly signature: string;
  readonly actors: ReadonlyArray<VisualActor>;
  readonly rooms: ReadonlyArray<SceneRoom>;
  readonly slots: Record<string, number>;
  readonly rests: Record<string, number>;
  readonly sites: Record<string, number>;
  readonly online: boolean;
  readonly restored: boolean;
  readonly visible: boolean;
  readonly generation: number;
}
export function reconcileWorld(
  world: World,
  actors: ReadonlyArray<OfficeActor>,
  titles: ReadonlyMap<string, string>,
  online: boolean,
  loaded: boolean,
  visible: boolean,
  signature: string,
): World {
  let generation = world.generation;
  const current = new Map(actors.map((actor) => [actor.key, actor]));
  const entries = world.actors.flatMap<VisualActor>((visual) => {
    const next = current.get(visual.actor.key);
    if (next) {
      current.delete(next.key);
      return [
        {
          actor: next,
          transition: visual.transition === "departing" ? "none" : visual.transition,
          generation: visual.transition === "departing" ? ++generation : visual.generation,
        },
      ];
    }
    if (!online) return [{ ...visual, actor: { ...visual.actor, status: "offline" } }];
    return world.online && world.visible && visible
      ? [
          {
            ...visual,
            transition: "departing",
            generation: visual.transition === "departing" ? visual.generation : ++generation,
          },
        ]
      : [];
  });
  for (const actor of current.values())
    entries.push({
      actor,
      generation: ++generation,
      transition:
        world.restored && world.online && online && world.visible && visible ? "arriving" : "none",
    });
  const projectIds = [...new Set(entries.map((visual) => visual.actor.projectId))];
  const slots: Record<string, number> = {};
  for (const id of projectIds) {
    const members = entries.filter((visual) => visual.actor.projectId === id);
    const used = new Set<number>();
    for (const { actor } of members) {
      const prior = world.slots[actor.key];
      if (prior !== undefined && prior % 2 === (actor.child ? 1 : 0) && !used.has(prior)) {
        slots[actor.key] = prior;
        used.add(prior);
      }
    }
    for (const { actor } of members) {
      if (slots[actor.key] !== undefined) continue;
      let slot = actor.child ? 1 : 0;
      while (used.has(slot)) slot += 2;
      slots[actor.key] = slot;
      used.add(slot);
    }
  }
  const rests = allocateStable(
    world.rests,
    entries.filter(({ actor }) => !actor.child).map(({ actor }) => actor.key),
  );
  const wanted = new Map<string, { projectId: string | null; title: string }>();
  // Allocate all primary anchors first; previously occupied module sites always take precedence.
  for (const id of projectIds)
    wanted.set(id, { projectId: id, title: titles.get(id) ?? "Project" });
  for (const { actor } of entries) {
    const id = projectRoomKey(actor.projectId, slots[actor.key]!);
    if (!wanted.has(id))
      wanted.set(id, {
        projectId: actor.projectId,
        title: `${titles.get(actor.projectId) ?? "Project"} · extension ${Math.floor(slots[actor.key]! / 2)}`,
      });
    const rest = actor.child ? null : restAreaKey(rests[actor.key]!);
    if (rest)
      wanted.set(rest, {
        projectId: null,
        title: `Lobby rest terrace ${Math.floor((rests[actor.key]! - 1) / 2) + 1}`,
      });
  }
  const ids = [...new Set([...world.rooms.map((room) => room.id), ...wanted.keys()])];
  const sites = allocateStable(world.sites, ids);
  const rooms = ids.map((id): SceneRoom => {
    const prior = world.rooms.find((room) => room.id === id);
    const target = wanted.get(id);
    const removing = target === undefined;
    const attaching = removing
      ? false
      : prior?.removing
        ? true
        : (prior?.attaching ?? (world.restored && world.online && online));
    return {
      id,
      projectId: target?.projectId ?? prior?.projectId ?? null,
      title: target?.title ?? prior?.title ?? "Project",
      site: siteAt(sites[id]!),
      variant:
        (target?.projectId ?? prior?.projectId)
          ? projectVariant(target?.projectId ?? prior!.projectId!)
          : "atlas",
      attaching,
      removing,
      generation:
        !prior || prior.removing !== removing || prior.attaching !== attaching
          ? ++generation
          : prior.generation,
    };
  });
  return {
    signature,
    actors: entries,
    rooms,
    slots,
    rests,
    sites,
    online,
    restored: world.restored || loaded,
    visible,
    generation,
  };
}
export function completeActor(
  world: World,
  key: string,
  transition: VisualActor["transition"],
  generation: number,
): World {
  const found = world.actors.find(
    (entry) =>
      entry.actor.key === key && entry.transition === transition && entry.generation === generation,
  );
  if (!found || transition === "none") return world;
  return {
    ...world,
    signature: "",
    actors: world.actors.flatMap((entry) =>
      entry !== found
        ? [entry]
        : transition === "departing"
          ? []
          : [{ ...entry, transition: "none" as const }],
    ),
  };
}
export function completeRoom(
  world: World,
  id: string,
  removing: boolean,
  generation: number,
): World {
  const found = world.rooms.find(
    (room) => room.id === id && room.generation === generation && room.removing === removing,
  );
  if (!found) return world;
  return {
    ...world,
    rooms: world.rooms.flatMap((room) =>
      room !== found ? [room] : removing ? [] : [{ ...room, attaching: false }],
    ),
  };
}
