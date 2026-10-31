import { expect, it } from "vite-plus/test";
import { EnvironmentId, RunId } from "@t3tools/contracts";
import { deriveOfficeActors } from "@t3tools/client-runtime/state/office";
import { makeThreadFixture } from "../../test-fixtures";
const v2ThreadShell = makeThreadFixture().source;
import { OfficeMotion } from "./officeMotion";
import { siteAt } from "./officeLayout";
const actor = deriveOfficeActors(
  EnvironmentId.make("motion-env"),
  [{ ...v2ThreadShell, latestRunId: RunId.make("done"), status: "completed" }],
  [],
  true,
)[0]!;
it("finds usable exits and automatic lobby routes for every approved interior", () => {
  for (const variant of ["atlas", "grove", "prism"] as const) {
    for (const slot of [0, 1]) {
      const motion = new OfficeMotion(),
        life = motion.add(actor, siteAt(0), variant, slot);
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
    life = motion.add(actor, siteAt(0), "atlas", 0);
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

it("brings concurrent completed mains to distinct shared-lobby spots without crossing reservations", () => {
  const motion = new OfficeMotion();
  const lives = Array.from({ length: 8 }, (_, i) =>
    motion.add({ ...actor, key: `agent-${i}` }, siteAt(i % 4), "atlas", Math.floor(i / 4)),
  );
  let overlap = false;
  for (let step = 0; step < 30000; step++) {
    for (const life of lives) if (life.performance) life.performanceReady = true;
    motion.tick(0.1, false);
    for (let i = 0; i < lives.length; i++)
      for (let j = i + 1; j < lives.length; j++)
        if (lives[i]!.position.distanceTo(lives[j]!.position) < 1.95) overlap = true;
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
});

it("completes the approved child sofa and game performances, retaining later completed children at home", () => {
  for (const amenity of ["sofa", "game"] as const) {
    const motion = new OfficeMotion(),
      child = { ...actor, key: `child-${amenity}`, child: true, status: "ready" as const },
      life = motion.add(child, siteAt(0), "atlas", 1);
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
    life = motion.add(worker, siteAt(1), "grove", 0);
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
    life = motion.add(actor, siteAt(0), "atlas", 0);
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
