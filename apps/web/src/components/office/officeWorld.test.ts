import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { deriveOfficeActors } from "@t3tools/client-runtime/state/office";
import { makeThreadFixture } from "../../test-fixtures";
import { completeActor, completeRoom, reconcileWorld, type World } from "./officeWorld";
import { projectRoomKey, restAreaKey } from "./officeLayout";
const actor = deriveOfficeActors(
  EnvironmentId.make("world"),
  [makeThreadFixture().source],
  [],
  true,
)[0]!;
const empty: World = {
  signature: "",
  actors: [],
  rooms: [],
  slots: {},
  rests: {},
  sites: {},
  online: true,
  visible: true,
  restored: true,
  generation: 0,
};
const reconcile = (world: World, actors = [actor]) =>
  reconcileWorld(world, actors, new Map(), true, true, true, "next");
it("keeps every crowded occupant in horizontal project modules and connected rest areas without relocating occupied anchors", () => {
  const actors = Array.from({ length: 60 }, (_, i) => ({
    ...actor,
    key: `actor-${i}`,
    projectId: ProjectId.make(`project-${Math.floor(i / 5)}`),
    child: i % 5 > 1,
  }));
  const world = reconcile(empty, actors);
  expect(world.actors).toHaveLength(60);
  const used = new Set(world.rooms.map((room) => room.site.index));
  expect(used.size).toBe(world.rooms.length);
  const berths = new Set(
    actors.map(
      (actor) =>
        `${projectRoomKey(actor.projectId, world.slots[actor.key]!)}:${world.slots[actor.key]! % 2}`,
    ),
  );
  expect(berths.size).toBe(actors.length);
  for (const actor of actors) {
    expect(
      world.rooms.some(
        (room) => room.id === projectRoomKey(actor.projectId, world.slots[actor.key]!),
      ),
    ).toBe(true);
    const rest = restAreaKey(world.rests[actor.key]!);
    if (rest)
      expect(world.rooms.some((room) => room.id === rest && room.projectId === null)).toBe(true);
  }
  const next = reconcile(world, [
    ...actors,
    { ...actor, key: "new", projectId: ProjectId.make("new-project") },
  ]);
  for (const room of world.rooms) expect(next.sites[room.id]).toBe(room.site.index);
  expect(next.rooms.at(-1)!.site.ring).toBeGreaterThan(0);
});
it("ignores a superseded attach timer during removal and removal callbacks after reopen or recreation", () => {
  const attached = reconcile(empty);
  const attaching = attached.rooms[0]!;
  let removed = reconcile(attached, []);
  const departure = removed.actors[0]!;
  removed = reconcile(completeActor(removed, actor.key, "departing", departure.generation), []);
  const removing = removed.rooms[0]!;
  expect(removing.removing).toBe(true);
  expect(completeRoom(removed, removing.id, false, attaching.generation)).toBe(removed);
  const reopened = reconcile(removed);
  expect(completeRoom(reopened, removing.id, true, removing.generation)).toBe(reopened);
  const finished = completeRoom(removed, removing.id, true, removing.generation);
  const recreated = reconcile(finished);
  expect(completeRoom(recreated, removing.id, true, removing.generation)).toBe(recreated);
  expect(recreated.rooms[0]!.generation).toBeGreaterThan(removing.generation);
});
it("keeps a second departure alive when an old renderer completion or fallback fires after Undo", () => {
  const initial = reconcile(empty);
  const departureA = reconcile(initial, []);
  const reopened = reconcile(departureA);
  const departureB = reconcile(reopened, []);
  expect(completeActor(departureB, actor.key, "departing", departureA.actors[0]!.generation)).toBe(
    departureB,
  );
  expect(completeActor(reopened, actor.key, "departing", departureA.actors[0]!.generation)).toBe(
    reopened,
  );
  expect(
    completeActor(departureB, actor.key, "departing", departureB.actors[0]!.generation).actors,
  ).toHaveLength(0);
});
