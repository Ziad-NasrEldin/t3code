import { expect, it } from "vite-plus/test";
import { EnvironmentId, RunId, ProjectId } from "@t3tools/contracts";
import { type OfficeActor, deriveOfficeActors } from "@t3tools/client-runtime/state/office";
import { makeThreadFixture } from "../../test-fixtures";
const v2ThreadShell = makeThreadFixture().source;
import { OfficeMotion, lifeBodyBox, boxesOverlap, PERFORMANCES, type Life } from "./officeMotion";
import { siteAt, projectRoomKey, restAreaKey, roomLocal, roomPoint } from "./officeLayout";
import { reconcileWorld, type World } from "./officeWorld";
import rawObstacles from "./obstacles.json";
import { CorridorTraffic } from "./officeTraffic";
import { Vector3 } from "three";
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
  // A real click arrives after the return walk has already advanced a few frames.
  for (let step = 0; step < 130 && life.performance; step++) motion.tick(0.1, false);
  expect(life.performance).toBeNull();
  for (let step = 0; step < 4; step++) motion.tick(0.1, false);
  expect(motion.request(actor.key, "coffee")).toBeNull();
  expect(
    life.route.reduce(
      (distance, point, i) => distance + point.distanceTo(i ? life.route[i - 1]! : life.position),
      0,
    ),
  ).toBeLessThan(1);
  for (let step = 0; step < 15 && !life.performance; step++) motion.tick(0.1, false);
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

function tickCrowd(
  motion: OfficeMotion,
  lives: Life[],
  seconds: number,
  onTick?: (step: number) => void,
) {
  const firstMoves = lives.map(() => Infinity);
  let peakMoving = 0;
  let overlap = "";
  let fastestStep = 0;
  let steps = 0;
  let stalled = 0,
    longestStall = 0;
  let furniture = "";
  const performed = new Set<string>();
  const rooms = [...new Map(lives.map((life) => [life.site.index, life])).values()];
  for (; steps < seconds * 10; steps++) {
    onTick?.(steps);
    const previous = lives.map((life) => life.position.clone());
    // This suite deliberately leaves graphics readiness false: culled actors have no mounted rig.
    motion.tick(0.1, false);
    const boxes = lives.map((life) => lifeBodyBox(life));
    let moving = 0;
    for (let i = 0; i < lives.length; i++) {
      const life = lives[i]!;
      if (life.performance) performed.add(`${life.key}:${life.performance}`);
      const distance = life.position.distanceTo(previous[i]!);
      const contact = life.requested ? PERFORMANCES[life.requested].start : null;
      const contactPoint =
        contact &&
        (life.requested === "keyboard" ? roomPoint(life.site, life.variant, contact) : contact);
      const atContact =
        contactPoint &&
        Math.hypot(life.position.x - contactPoint[0], life.position.z - contactPoint[1]) < 0.15;
      if (!life.performance && !atContact) {
        for (const room of rooms) {
          if (
            Math.abs(life.position.x - room.site.x) > 9 ||
            Math.abs(life.position.z - room.site.z) > 9
          )
            continue;
          const a = roomLocal(room.site, room.variant, boxes[i]!.min),
            b = roomLocal(room.site, room.variant, boxes[i]!.max);
          const box = {
            min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])] as const,
            max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])] as const,
          };
          if (
            rawObstacles[room.variant].some((other) =>
              boxesOverlap(box, other as { min: [number, number]; max: [number, number] }),
            )
          )
            furniture ||= `${life.key}:room-${room.site.index}`;
        }
        if (
          Math.abs(life.position.x) < 9 &&
          Math.abs(life.position.z) < 8 &&
          rawObstacles.lobby.some((other) =>
            boxesOverlap(boxes[i]!, other as { min: [number, number]; max: [number, number] }),
          )
        )
          furniture ||= `${life.key}:lobby`;
      }
      if (distance > 0.001) {
        moving++;
        firstMoves[i] = Math.min(firstMoves[i]!, steps / 10);
      }
      fastestStep = Math.max(fastestStep, distance);
      for (let j = i + 1; j < lives.length; j++)
        if (boxesOverlap(boxes[i]!, boxes[j]!)) overlap ||= `${lives[i]!.key}:${lives[j]!.key}`;
    }
    stalled = moving || lives.some((life) => life.performance) ? 0 : stalled + 1;
    longestStall = Math.max(longestStall, stalled);
    peakMoving = Math.max(peakMoving, moving);
    if (lives.every((life) => life.route.length === 0 && !life.requested && !life.performance))
      break;
  }
  return {
    peakMoving,
    latestFirstMove: Math.max(...firstMoves.filter(Number.isFinite)),
    overlap,
    furniture,
    fastestStep,
    longestStall: longestStall / 10,
    performed: [...performed],
    seconds: (steps + 1) / 10,
  };
}
function locations(lives: Life[]) {
  return JSON.stringify(
    lives.map((life) => ({
      key: life.key,
      at: life.position.toArray(),
      target: life.route.at(-1)?.toArray(),
      blocked: life.routeBlocked,
      destination: life.destination,
      performance: life.performance,
    })),
  );
}
it("brings 60 simultaneous normal-speed occupants out and home with fair concurrent collision-free progress", () => {
  const motion = new OfficeMotion();
  const lives = Array.from({ length: 60 }, (_, i) =>
    motion.add({ ...actor, key: `agent-${i}` }, siteAt(i), "atlas", 0, {
      site: siteAt(60 + Math.floor(i / 2)),
      slot: i,
    }),
  );
  const outward = tickCrowd(motion, lives, 2400);
  expect(outward.seconds).toBeLessThan(900);
  expect(outward.latestFirstMove).toBeLessThan(448.7);
  expect(outward.overlap).toBe("");
  expect(outward.furniture).toBe("");
  expect(outward.longestStall).toBeLessThan(20);
  expect(outward.fastestStep).toBeLessThanOrEqual(0.090001);
  expect(outward.peakMoving).toBeGreaterThanOrEqual(12);
  expect(
    lives.every((life) => life.position.distanceTo(life.rest) < 0.05),
    locations(lives),
  ).toBe(true);
  for (const life of lives) motion.update({ ...life.actor, status: "working" });
  const inward = tickCrowd(motion, lives, 2400);
  expect(inward.seconds).toBeLessThan(1000);
  expect(inward.latestFirstMove).toBeLessThan(1146.7);
  expect(inward.overlap).toBe("");
  expect(inward.furniture).toBe("");
  expect(inward.longestStall).toBeLessThan(20);
  expect(inward.fastestStep).toBeLessThanOrEqual(0.090001);
  expect(inward.peakMoving).toBeGreaterThanOrEqual(4);
  expect(
    lives.every((life) => life.position.distanceTo(life.home) < 0.05),
    locations(lives),
  ).toBe(true);
  expect(motion.reservations.size).toBe(0);
});

it("completes the approved child sofa and game performances, retaining later completed children at home", () => {
  for (const amenity of ["sofa", "game"] as const) {
    const motion = new OfficeMotion(),
      child = { ...actor, key: `child-${amenity}`, child: true, status: "ready" as const },
      life = motion.add(child, siteAt(0), "atlas", 1, { site: null, slot: 0 });
    expect(motion.request(child.key, amenity)).toBeNull();
    for (let step = 0; step < 10; step++) motion.tick(0.1, false);
    motion.update({ ...child, status: "waiting" });
    expect(life.actor.status).toBe("waiting");
    const cancelled = tickCrowd(motion, [life], 300);
    expect(cancelled.performed).toEqual([]);
    expect(cancelled.furniture).toBe("");
    expect(cancelled.fastestStep).toBeLessThanOrEqual(0.090001);
    expect(life.position.distanceTo(life.home)).toBeLessThan(0.05);
    expect(motion.reservations.size).toBe(0);
    motion.update(child);
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
    life = motion.add(worker, siteAt(0), "grove", 0, { site: null, slot: 0 });
  const child = motion.add(
    { ...actor, key: "keyboard-child", child: true, status: "ready" },
    siteAt(0),
    "grove",
    1,
    { site: null, slot: 0 },
  );
  const childHome = child.position.clone();
  expect(motion.request(worker.key, "keyboard")).toBeNull();
  for (let step = 0; step < 10000 && life.performance === null; step++) motion.tick(0.1, false);
  expect(life.performance).toBe("keyboard");
  life.performanceReady = true;
  motion.update({ ...worker, status: "waiting" });
  for (let step = 0; step < 10000; step++) motion.tick(0.1, false);
  expect(life.position.distanceTo(life.home)).toBeLessThan(0.05);
  expect(motion.reservations.size).toBe(0);
  expect(life.actor.status).toBe("waiting");
  motion.update(worker);
  expect(motion.request(worker.key, "keyboard")).toBeNull();
  for (let step = 0; step < 10000 && life.performance === null; step++) {
    motion.tick(0.1, false);
    expect(boxesOverlap(lifeBodyBox(life), lifeBodyBox(child))).toBe(false);
  }
  expect(life.performance).toBe("keyboard");
  expect(child.position.equals(childHome)).toBe(true);
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
  const lives = [...motion.lives.values()];
  const child = lives.find((life) => life.key === "fixture-7")!;
  motion.update({ ...child.actor, status: "ready" });
  expect(motion.request(child.key, "sofa")).toBeNull();
  let sofaAt = Infinity;
  const result = tickCrowd(motion, lives, 1800, (step) => {
    if (child.performance === "sofa") sofaAt = Math.min(sofaAt, step / 10);
  });
  expect(result.seconds).toBeLessThan(260);
  expect(result.performed).toContain(`${child.key}:sofa`);
  expect(sofaAt).toBeLessThan(180);
  expect(result.overlap).toBe("");
  expect(result.furniture).toBe("");
  expect(result.longestStall).toBeLessThan(20);
  expect(result.peakMoving).toBeGreaterThanOrEqual(8);
  expect(result.fastestStep).toBeLessThanOrEqual(0.090001);
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
  motion.update({ ...child.actor, status: "ready" });
  expect(motion.request(child.key, "game")).toBeNull();
  for (const life of lives.filter((life) => !life.actor.child))
    motion.update({ ...life.actor, status: "working" });
  let recovery = false;
  const returning = tickCrowd(motion, lives, 1800, (step) => {
    const main = lives[5]!;
    if (step === 100) motion.update({ ...main.actor, status: "idle" });
    if (step === 110) motion.update({ ...main.actor, status: "thinking" });
    if (child.performance === "game" && child.performanceTime >= 2 && !recovery) {
      motion.update({ ...child.actor, status: "waiting" });
      expect(child.phase).toBe("recover");
      expect(motion.reservations.get("game:lobby")).toBe(child.key);
      const contender = lives[2]!;
      motion.update({ ...contender.actor, status: "ready" });
      expect(motion.request(contender.key, "game")).toContain("reserved");
      recovery = true;
    }
  });
  expect(returning.seconds).toBeLessThan(260);
  expect(recovery).toBe(true);
  expect(returning.performed).toContain(`${child.key}:game`);
  expect(returning.overlap).toBe("");
  expect(returning.furniture).toBe("");
  expect(returning.longestStall).toBeLessThan(20);
  expect(
    lives.every((life) => life.position.distanceTo(life.home) < 0.05),
    locations(lives),
  ).toBe(true);
  expect(lives[5]!.actor.status).toBe("thinking");
  expect(motion.reservations.size).toBe(0);
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

it("drains conflicting traffic in ticket order without letting a new convoy starve a waiting reversal", () => {
  const traffic = new CorridorTraffic();
  const a = new Vector3(0, 0.07, 0),
    b = new Vector3(30, 0.07, 0);
  traffic.plan("outbound", a, [b]);
  traffic.beginFrame();
  expect(traffic.claim("outbound", () => false)).toBe(true);
  traffic.plan("return", b, [a]);
  traffic.plan("late-outbound", a, [b], true);
  traffic.beginFrame();
  expect(traffic.claim("return", () => false)).toBe(false);
  expect(traffic.claim("late-outbound", () => false)).toBe(false);
  traffic.remove("outbound");
  traffic.beginFrame();
  expect(traffic.claim("return", () => false)).toBe(true);
  expect(traffic.claim("late-outbound", () => false)).toBe(false);
  traffic.remove("return");
  traffic.beginFrame();
  expect(traffic.claim("late-outbound", () => false)).toBe(true);
  traffic.clear();
  expect(traffic.active("late-outbound")).toBe(false);
  const crossing = new CorridorTraffic();
  crossing.plan("long", new Vector3(-20, 0.07, 0), [new Vector3(200, 0.07, 0)]);
  crossing.beginFrame();
  expect(crossing.claim("long", () => false)).toBe(true);
  crossing.plan("cross", new Vector3(0, 0.07, -20), [new Vector3(0, 0.07, 20)]);
  let crossed = false;
  for (let frame = 0; frame < 400; frame++) {
    crossing.beginFrame(0.1);
    crossed ||= crossing.claim("cross", () => false);
  }
  expect(crossed).toBe(true);
  expect(crossing.active("long")).toBe(true);
  // A stopped holder prevents admission until it physically releases its occupied space.
  crossing.plan("held", new Vector3(50, 0.07, -20), [new Vector3(50, 0.07, 20)]);
  crossing.beginFrame();
  expect(crossing.claim("held", () => true)).toBe(false);
  crossing.beginFrame();
  expect(crossing.claim("held", () => false)).toBe(true);

  // A new stationary occupant can arrive while a long scan is suspended.
  const arrivals = new CorridorTraffic();
  const route = Array.from({ length: 2100 }, (_, i) => new Vector3(i + 1, 0.07, 0));
  arrivals.plan("long-scan", new Vector3(0, 0.07, 0), route);
  arrivals.beginFrame();
  expect(arrivals.claim("long-scan", () => false)).toBe(false);
  arrivals.beginFrame();
  expect(arrivals.claim("long-scan", (start) => start.x === 0)).toBe(false);
  expect(arrivals.reserved("long-scan")).toBe(false);
});
it("replaces a remote rest journey at a cleared node when new work arrives", () => {
  const motion = new OfficeMotion();
  const life = motion.add(actor, siteAt(0), "atlas", 0, { site: siteAt(80), slot: 0 });
  let advanced = 0;
  while (life.position.distanceTo(life.home) < 12 && advanced++ < 2000) motion.tick(0.1, false);
  const before = life.position.clone();
  motion.update({ ...life.actor, status: "thinking" });
  expect(life.actor.status).toBe("thinking");
  let nearestRest = Infinity;
  const result = tickCrowd(motion, [life], 120, () => {
    nearestRest = Math.min(nearestRest, life.position.distanceTo(life.rest));
  });
  expect(result.seconds).toBeLessThan(120);
  expect(life.position.distanceTo(life.home)).toBeLessThan(0.05);
  expect(nearestRest).toBeGreaterThan(40);
  expect(before.distanceTo(life.home)).toBeGreaterThan(10);
});

it("retains and advances all 750 logical occupants with compact routes, then clears every reservation", () => {
  const actors: OfficeActor[] = Array.from({ length: 750 }, (_, i) => ({
    ...actor,
    key: `large-${i}`,
    projectId: ProjectId.make(`large-p${Math.floor(i / 5)}`),
    child: i % 5 > 1,
    status: i % 5 > 1 ? "sleeping" : "idle",
  }));
  const world = reconcileWorld(
    {
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
    },
    actors,
    new Map(),
    true,
    true,
    true,
    "large",
  );
  const motion = new OfficeMotion();
  for (const actor of actors) {
    const slot = world.slots[actor.key]!,
      restSlot = world.rests[actor.key]!;
    const room = world.rooms.find((room) => room.id === projectRoomKey(actor.projectId, slot))!;
    const rest = world.rooms.find((room) => room.id === restAreaKey(restSlot));
    motion.add(actor, room.site, room.variant, slot, { site: rest?.site ?? null, slot: restSlot });
  }
  expect(motion.lives.size).toBe(750);
  expect(world.rooms.length).toBeLessThanOrEqual(825);
  expect(Math.max(...[...motion.lives.values()].map((life) => life.route.length))).toBeLessThan(80);
  for (let step = 0; step < 300; step++) motion.tick(0.1, false);
  expect(
    [...motion.lives.values()].filter((life) => life.position.distanceTo(life.home) > 0.1).length,
  ).toBeGreaterThan(32);
  for (const life of motion.lives.values()) {
    expect(life.position.y).toBe(0.07);
    expect(Number.isFinite(life.position.x + life.position.z)).toBe(true);
  }
  motion.clear();
  expect(motion.lives.size).toBe(0);
  expect(motion.reservations.size).toBe(0);
  const restored = motion.add({ ...actor, status: "idle" }, siteAt(0), "atlas", 0, {
    site: null,
    slot: 0,
  });
  expect(motion.request(restored.key, "coffee")).toBeNull();
  const reused = tickCrowd(motion, [restored], 200);
  expect(reused.performed).toContain(`${restored.key}:coffee`);
  expect(motion.reservations.size).toBe(0);
  expect(restored.position.distanceTo(restored.rest)).toBeLessThan(0.05);
});
