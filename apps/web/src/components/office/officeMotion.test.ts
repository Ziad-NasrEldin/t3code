import { expect, it } from "vite-plus/test";
import { EnvironmentId, RunId, ProjectId } from "@t3tools/contracts";
import { deriveOfficeActors } from "@t3tools/client-runtime/state/office";
import { makeThreadFixture } from "../../test-fixtures";
const v2ThreadShell = makeThreadFixture().source;
import { OfficeMotion, lifeBodyBox, boxesOverlap } from "./officeMotion";
import { siteAt, projectRoomKey, restAreaKey, roomLocal } from "./officeLayout";
import { reconcileWorld, type World } from "./officeWorld";
import rawObstacles from "./obstacles.json";
const actor = deriveOfficeActors(
  EnvironmentId.make("motion-env"),
  [{ ...v2ThreadShell, latestRunId: RunId.make("done"), status: "completed" }],
  [],
  true,
)[0]!;
it("finds usable exits and automatic lobby routes for every approved interior", () => {
  for (const variant of ["atlas", "grove", "prism"] as const) {
    for (const slot of [0, 2]) {
      const motion = new OfficeMotion(),
        life = motion.add(actor, siteAt(0), variant, slot, { site: null, slot: 0 });
      expect(life.routeBlocked, variant).toBe(false);
      expect(life.route.length, variant).toBeGreaterThan(0);
      for (let step = 0; step < 10000; step++) motion.tick(0.1, true);
      expect(life.position.distanceTo(life.rest), variant).toBeLessThan(0.05);
      motion.update({ ...actor, status: "working" });
      for (let step = 0; step < 10000; step++) motion.tick(0.1, true);
      expect(life.position.distanceTo(life.home), variant).toBeLessThan(0.05);
    }
  }
});
it("keeps item reservations exclusive and stops decorative use without changing thread state", () => {
  const motion = new OfficeMotion(),
    life = motion.add(actor, siteAt(0), "atlas", 0, { site: null, slot: 0 });
  for (let step = 0; step < 10000; step++) motion.tick(0.1, true);
  expect(motion.request(actor.key, "coffee")).toBeNull();
  expect(motion.request(actor.key, "coffee")).not.toBeNull();
  for (let step = 0; step < 10000 && life.performance === null; step++) motion.tick(0.1, false);
  expect(life.performance).toBe("coffee");
  life.performanceReady = true;
  motion.update({ ...actor, status: "waiting" });
  expect(life.actor.status).toBe("waiting");
  expect(life.phase).toBe("recover");
  for (let step = 0; step < 10000; step++) motion.tick(0.1, false);
  expect(motion.reservations.size).toBe(0);
  expect(life.actor.status).toBe("waiting");
  expect(life.position.distanceTo(life.home)).toBeLessThan(0.05);
  motion.clear();
  expect(motion.lives.size).toBe(0);
});

it("keeps crowded occupants on a single horizontal floor", () => {
  const motion = new OfficeMotion();
  const lives = Array.from({ length: 6 }, (_, i) =>
    motion.add({ ...actor, key: `crowded-${i}`, status: "working" }, siteAt(i), "atlas", i, {
      site: siteAt(20 + i),
      slot: i,
    }),
  );
  expect(lives.map((life) => life.home.y)).toEqual(lives.map(() => 0.07));
  expect(lives.map((life) => life.rest.y)).toEqual(lives.map(() => 0.07));
});

it("brings concurrent completed mains to distinct shared-lobby spots without crossing reservations", () => {
  const motion = new OfficeMotion();
  const lives = Array.from({ length: 8 }, (_, i) =>
    motion.add({ ...actor, key: `agent-${i}` }, siteAt(i), "atlas", 0, {
      site: i < 1 ? null : siteAt(20 + Math.floor((i - 1) / 2)),
      slot: i,
    }),
  );
  let overlap = false;
  for (let step = 0; step < 30000; step++) {
    for (const life of lives) if (life.performance) life.performanceReady = true;
    motion.tick(0.1, false);
    for (let i = 0; i < lives.length; i++)
      for (let j = i + 1; j < lives.length; j++)
        if (boxesOverlap(lifeBodyBox(lives[i]!), lifeBodyBox(lives[j]!))) overlap = true;
  }
  expect(overlap).toBe(false);
  expect(
    lives.map((life) => life.position.distanceTo(life.rest)),
    JSON.stringify(
      lives.map((life) => ({
        key: life.key,
        pos: life.position.toArray(),
        rest: life.rest.toArray(),
        next: life.route[0]?.toArray(),
        blocked: life.routeBlocked,
        traffic: life.traffic?.size,
      })),
    ),
  ).toEqual(lives.map(() => expect.closeTo(0, 1)));
  for (const life of lives) motion.update({ ...life.actor, status: "working" });
  for (let step = 0; step < 30000; step++) motion.tick(0.1, false);
  for (const life of lives)
    expect(life.position.distanceTo(life.home), life.key).toBeLessThan(0.05);
});

it("completes the approved child sofa and game performances, retaining later completed children at home", () => {
  for (const amenity of ["sofa", "game"] as const) {
    const motion = new OfficeMotion(),
      child = { ...actor, key: `child-${amenity}`, child: true, status: "ready" as const },
      life = motion.add(child, siteAt(0), "atlas", 1, { site: null, slot: 0 });
    expect(motion.request(child.key, amenity)).toBeNull();
    const trace: unknown[] = [];
    let previous = "";
    for (let step = 0; step < 20000 && life.performance === null; step++) {
      motion.tick(0.1, false);
      motion.update(child);
      const signature = `${life.phase}:${life.requested}:${life.destination}:${life.routeBlocked}`;
      if (signature !== previous) {
        trace.push({
          step,
          signature,
          pos: life.position.toArray(),
          target: life.route.at(-1)?.toArray(),
        });
        previous = signature;
      }
    }
    expect(
      life.performance,
      JSON.stringify({
        trace,
        amenity,
        pos: life.position.toArray(),
        rest: life.rest.toArray(),
        phase: life.phase,
        destination: life.destination,
        requested: life.requested,
        blocked: life.routeBlocked,
      }),
    ).toBe(amenity);
    life.performanceReady = true;
    motion.update(child);
    expect(life.phase).toBe("use");
    for (let step = 0; step < 30000; step++) motion.tick(0.1, false);
    expect(life.position.distanceTo(life.home)).toBeLessThan(0.05);
    expect(motion.reservations.size).toBe(0);
    motion.update({ ...child, status: "sleeping" });
    expect(life.destination).toBe("home");
    expect(motion.request(child.key, amenity)).not.toBeNull();
  }
});
it("walks to a workshop keyboard and releases it after interruption", () => {
  const motion = new OfficeMotion(),
    worker = { ...actor, status: "working" as const },
    life = motion.add(worker, siteAt(1), "grove", 0, { site: null, slot: 0 });
  expect(motion.request(worker.key, "keyboard")).toBeNull();
  for (let step = 0; step < 10000 && life.performance === null; step++) motion.tick(0.1, false);
  expect(life.performance).toBe("keyboard");
  life.performanceReady = true;
  motion.update({ ...worker, status: "waiting" });
  for (let step = 0; step < 10000; step++) motion.tick(0.1, false);
  expect(life.position.distanceTo(life.home)).toBeLessThan(0.05);
  expect(motion.reservations.size).toBe(0);
  expect(life.actor.status).toBe("waiting");
});

it("reconciles settlement and undo during a reserved performance without retaining a cup or deleting new work", () => {
  const motion = new OfficeMotion(),
    life = motion.add(actor, siteAt(0), "atlas", 0, { site: null, slot: 0 });
  for (let i = 0; i < 1000; i++) motion.tick(0.1, true);
  expect(motion.request(actor.key, "coffee")).toBeNull();
  for (let i = 0; i < 10000 && life.performance === null; i++) motion.tick(0.1, false);
  life.performanceReady = true;
  motion.tick(4, false);
  motion.setDeparture(actor.key, true);
  expect(life.phase).toBe("recover");
  motion.setDeparture(actor.key, false);
  motion.update({ ...actor, status: "working" });
  for (let i = 0; i < 10000; i++) motion.tick(0.1, false);
  expect(life.actor.status).toBe("working");
  expect(life.departing).toBe(false);
  expect(life.position.distanceTo(life.home)).toBeLessThan(0.05);
  expect(motion.reservations.size).toBe(0);
});

it("reserves actual rig bounds for the 12-project 60-occupant single-floor fixture", () => {
  const initial: World = {
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
  const actors = Array.from({ length: 60 }, (_, i) => ({
    ...actor,
    key: `fixture-${i}`,
    projectId: ProjectId.make(`p${Math.floor(i / 5)}`),
    child: i % 5 > 1,
    status: i % 5 > 1 ? ("sleeping" as const) : ("idle" as const),
  }));
  const world = reconcileWorld(initial, actors, new Map(), true, true, true, "fixture");
  const motion = new OfficeMotion();
  for (const actor of actors) {
    const room = world.rooms.find(
      (room) => room.id === projectRoomKey(actor.projectId, world.slots[actor.key]!),
    )!;
    const rest = world.rooms.find((room) => room.id === restAreaKey(world.rests[actor.key]!));
    const life = motion.add(actor, room.site, room.variant, world.slots[actor.key]!, {
      site: rest?.site ?? null,
      slot: world.rests[actor.key]!,
    });
    const body = lifeBodyBox(life);
    const localMin = roomLocal(room.site, room.variant, body.min),
      localMax = roomLocal(room.site, room.variant, body.max);
    const localBox = {
      min: [Math.min(localMin[0], localMax[0]), Math.min(localMin[1], localMax[1])] as const,
      max: [Math.max(localMin[0], localMax[0]), Math.max(localMin[1], localMax[1])] as const,
    };
    for (const box of rawObstacles[room.variant])
      expect(
        boxesOverlap(localBox, box as { min: [number, number]; max: [number, number] }),
        `${room.variant}:${actor.key}`,
      ).toBe(false);
  }
  for (let step = 0; step < 6000; step++) motion.tick(0.1, true);
  const lives = [...motion.lives.values()];
  expect(lives).toHaveLength(60);
  for (let i = 0; i < lives.length; i++) {
    const life = lives[i]!;
    expect(life.position.y).toBe(0.07);
    expect(
      life.position.distanceTo(life.actor.child ? life.home : life.rest),
      life.key,
    ).toBeLessThan(0.05);
    for (let j = i + 1; j < lives.length; j++)
      expect(
        boxesOverlap(lifeBodyBox(life), lifeBodyBox(lives[j]!)),
        `${life.key}:${lives[j]!.key}`,
      ).toBe(false);
  }
});

it("reconciles a reused berth when React skips an intermediate removal before the same actor returns", () => {
  const motion = new OfficeMotion();
  const working = { ...actor, status: "working" as const };
  motion.add(working, siteAt(0), "atlas", 0, { site: null, slot: 0 });
  // Departure completed in the world, another occupant reused its old slot, then
  // this key returned before the scene observed the absent intermediate snapshot.
  const replacement = motion.add({ ...working, key: "replacement" }, siteAt(0), "atlas", 0, {
    site: siteAt(20),
    slot: 1,
  });
  const returned = motion.add(working, siteAt(1), "atlas", 2, { site: siteAt(21), slot: 2 });
  expect(returned.site.index).toBe(1);
  expect(returned.restSite?.index).toBe(21);
  expect(boxesOverlap(lifeBodyBox(returned), lifeBodyBox(replacement))).toBe(false);
});
