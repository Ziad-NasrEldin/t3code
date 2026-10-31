import type { OfficeActor, OfficeStatus } from "@t3tools/client-runtime/state/office";
import { Vector3 } from "three";
import bodyBounds from "./bodyBounds.json";
import performanceBounds from "./performanceBounds.json";
import rawObstacles from "./obstacles.json";
import { CorridorTraffic, SpatialIndex, compactRoute, overlaps } from "./officeTraffic";
import {
  roomRotation,
  findPath,
  homePoint,
  homeLocal,
  roomPoint,
  roomLocal,
  routeBetweenSites,
  routeOptionsBetweenSites,
  ringSize,
  type Point,
  type RoomSite,
  type RoomVariant,
  type Obstacle,
} from "./officeLayout";

const boxes = (items: ReadonlyArray<{ min: ReadonlyArray<number>; max: ReadonlyArray<number> }>) =>
  items.map((box) => ({
    min: [box.min[0]!, box.min[1]!] as Point,
    max: [box.max[0]!, box.max[1]!] as Point,
  }));
const obstacles = {
  atlas: boxes(rawObstacles.atlas),
  grove: boxes(rawObstacles.grove),
  prism: boxes(rawObstacles.prism),
  lobby: boxes(rawObstacles.lobby),
};

export type Amenity = "coffee" | "sofa" | "keyboard" | "game";
export const PERFORMANCES = {
  coffee: {
    child: false,
    start: [3.1, -1.3] as Point,
    seconds: 12,
    recovery: 9.7,
    offset: [0, 0] as Point,
  },
  sofa: {
    child: true,
    start: [-3.4, -1.2] as Point,
    seconds: 18,
    recovery: 11.5,
    offset: [0, 0] as Point,
  },
  keyboard: {
    child: false,
    start: [2, -0.5] as Point,
    seconds: 12,
    recovery: 9,
    offset: [-17, 0] as Point,
  },
  game: {
    child: true,
    start: [7.1, 2.45] as Point,
    seconds: 12,
    recovery: 8.3,
    offset: [0, 0] as Point,
  },
} as const;
const LOBBY_SPOTS: ReadonlyArray<Point> = [[0, 3.5]];
export interface Life {
  readonly key: string;
  actor: OfficeActor;
  readonly site: RoomSite;
  readonly variant: RoomVariant;
  readonly restSite: RoomSite | null;
  readonly restSlot: number;
  readonly home: Vector3;
  readonly rest: Vector3;
  readonly position: Vector3;
  readonly route: Vector3[];
  heading: number;
  destination: "home" | "lobby";
  phase: "rest" | "walking" | "approach" | "use" | "recover";
  performance: Amenity | null;
  performanceTime: number;
  performanceReady: boolean;
  activityStatus: OfficeStatus | null;
  requested: Amenity | null;
  pendingReturn: boolean;
  routeBlocked: boolean;
  walking: boolean;
  visit: boolean;
  pendingTravel: "home" | "lobby" | null;
  renderCell: string;
  departing: boolean;
  automaticVisitRunId: string | null;
}
function vector(p: Point) {
  return new Vector3(p[0], 0.07, p[1]);
}
function localDoor(variant: RoomVariant): Point {
  return variant === "grove" ? [5.5, 0] : variant === "prism" ? [-5.5, 0] : [0, 5.5];
}
function pathsToWorld(path: ReadonlyArray<Point>, site: RoomSite, variant: RoomVariant) {
  return path.map((p) => vector(roomPoint(site, variant, p)));
}
const exitPaths = new Map<string, ReadonlyArray<Point> | null>();
function roomExit(
  site: RoomSite,
  variant: RoomVariant,
  slot: number,
  start: Point = homeLocal(variant, slot),
  blocked: readonly Obstacle[] = obstacles[variant],
) {
  const key = `${variant}:${slot % 2}`;
  const home = homeLocal(variant, slot);
  const cacheable = start[0] === home[0] && start[1] === home[1];
  const path =
    cacheable && exitPaths.has(key)
      ? exitPaths.get(key)!
      : findPath(
          start,
          localDoor(variant),
          blocked,
          [-6, -5.5, 6, 5.5],
          slot % 2 === 0 ? bodyBounds.main.walk : bodyBounds.child.walk,
        );
  if (cacheable) exitPaths.set(key, path);
  return path === null ? null : pathsToWorld(path, site, variant);
}
function lobbyPath(
  start: Point,
  end: Point,
  child = false,
  restPoints: ReadonlyArray<Point> = LOBBY_SPOTS,
  clearUseSpaces = true,
) {
  const useSpaces = (clearUseSpaces ? (["coffee", "sofa", "game"] as const) : []).flatMap(
    (name): Obstacle[] => {
      const b = performanceBounds[name];
      const box: Obstacle = { min: [b[0]! - 0.1, b[1]! - 0.1], max: [b[2]! + 0.1, b[3]! + 0.1] };
      const contains = (p: Point) =>
        p[0] >= box.min[0] && p[0] <= box.max[0] && p[1] >= box.min[1] && p[1] <= box.max[1];
      return contains(start) || contains(end) ? [] : [box];
    },
  );
  const reserved = restPoints
    .filter(
      (p) =>
        Math.hypot(p[0] - start[0], p[1] - start[1]) > 2.1 &&
        Math.hypot(p[0] - end[0], p[1] - end[1]) > 2.1,
    )
    .map((p) => ({
      min: [p[0] + bodyBounds.main.min[0]!, p[1] + bodyBounds.main.min[1]!] as Point,
      max: [p[0] + bodyBounds.main.max[0]!, p[1] + bodyBounds.main.max[1]!] as Point,
    }));
  const path = findPath(
    start,
    end,
    [...obstacles.lobby, ...reserved, ...useSpaces],
    [-7.8, -6.8, 10, 8.5],
    child ? bodyBounds.child.walk : bodyBounds.main.walk,
  );
  if (!path && clearUseSpaces) return lobbyPath(start, end, child, restPoints, false);
  return path?.map((p) => vector(p)) ?? null;
}
export function lifeBodyBox(
  life: Life,
  position = life.position,
  heading = life.heading,
  walking = life.walking,
): Obstacle {
  const source = bodyBounds[life.actor.child ? "child" : "main"];
  const b = walking
    ? { min: [-source.walk.side, -source.walk.back], max: [source.walk.side, source.walk.front] }
    : source;
  const points = [b.min, [b.min[0]!, b.max[1]!], b.max, [b.max[0]!, b.min[1]!]];
  const c = Math.cos(heading),
    s = Math.sin(heading);
  const x = points.map((p) => position.x + p[0]! * c + p[1]! * s);
  const z = points.map((p) => position.z - p[0]! * s + p[1]! * c);
  return { min: [Math.min(...x), Math.min(...z)], max: [Math.max(...x), Math.max(...z)] };
}
export function boxesOverlap(a: Obstacle, b: Obstacle): boolean {
  return overlaps(a, b);
}
export class OfficeMotion {
  readonly lives = new Map<string, Life>();
  private readonly lifecycleListeners = new Set<
    (key: string, transition: "arriving" | "departing", generation: number) => void
  >();
  subscribeLifecycle(
    listener: (key: string, transition: "arriving" | "departing", generation: number) => void,
  ) {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }
  finishLifecycle(key: string, transition: "arriving" | "departing", generation: number) {
    for (const listener of this.lifecycleListeners) listener(key, transition, generation);
  }

  private graphicsWake: () => void = () => {};
  wake() {
    this.graphicsWake();
  }
  connectGraphics(wake: () => void) {
    this.graphicsWake = wake;
    return () => {
      this.graphicsWake = () => {};
    };
  }
  private snapshot: ReadonlyMap<string, Life> = new Map();
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  performanceFor(key: string) {
    return this.lives.get(key)?.performance ?? null;
  }
  setActivity(key: string, status: OfficeStatus | null) {
    const life = this.lives.get(key);
    if (life) life.activityStatus = status;
  }
  private publish() {
    this.snapshot = new Map(this.lives);
    for (const listener of this.listeners) listener();
  }
  readonly reservations = new Map<string, string>();
  private readonly slots = new Map<string, number>();
  private readonly itemBoxes = new Map<string, { owner: string; box: Obstacle; active: boolean }>();
  private readonly traffic = new CorridorTraffic();
  private readonly bodies = new SpatialIndex<Life>();
  private readonly bodyBoxes = new Map<Life, Obstacle>();
  // The furnished lobby has one shared approach aisle; a visitor keeps it until safely back at a berth.
  private lobbyVisitor: string | null = null;
  setDeparture(key: string, departing: boolean) {
    const life = this.lives.get(key);
    if (!life || life.departing === departing) return;
    life.departing = departing;
    life.pendingTravel = null;
    if (!this.traffic.active(key)) {
      this.releaseTraffic(life);
      life.route.splice(0);
    }
    if (departing) {
      if (life.requested) this.release(life);
      if (life.performance) life.phase = "recover";
    } else {
      life.pendingReturn = false;
      life.destination = life.destination === "home" ? "lobby" : "home";
      this.update(life.actor);
    }
  }
  private boxForItem(life: Life, amenity: Amenity) {
    const b = performanceBounds[amenity],
      localCorners = [
        [b[0]! - 0.1, b[1]! - 0.1],
        [b[2]! + 0.1, b[3]! + 0.1],
      ] as const;
    const corners =
      amenity === "keyboard"
        ? localCorners.map((point) => roomPoint(life.site, life.variant, point))
        : localCorners;
    const minX = Math.min(...corners.map((point) => point[0])),
      maxX = Math.max(...corners.map((point) => point[0])),
      minZ = Math.min(...corners.map((point) => point[1])),
      maxZ = Math.max(...corners.map((point) => point[1]));
    return { min: [minX, minZ], max: [maxX, maxZ] } as Obstacle;
  }
  private releaseTraffic(life: Life) {
    this.traffic.remove(life.key, life.visit);
    life.walking = false;
  }
  private setRoute(
    life: Life,
    route: readonly Vector3[],
    reserved = false,
    alternatives: readonly (readonly Vector3[])[] = [],
  ) {
    life.route.splice(0, life.route.length, ...compactRoute(life.position, route));
    life.walking =
      life.route.length > 0 &&
      Math.min(life.position.distanceTo(life.home), life.position.distanceTo(life.rest)) > 0.1;
    if (life.route.length && !reserved)
      this.traffic.plan(
        life.key,
        life.position,
        life.route,
        life.requested !== null,
        life.requested
          ? [...this.itemBoxes.values()].find((item) => item.owner === life.key)?.box
          : undefined,
        this.travelShape(life, life.route.at(-1)!),
        alternatives.map((path) => compactRoute(life.position, path)),
      );
    else if (!life.route.length) this.releaseTraffic(life);
    life.routeBlocked = false;
  }
  private travelShape(life: Life, target: Vector3) {
    const walk = bodyBounds[life.actor.child ? "child" : "main"].walk;
    return {
      side: walk.side,
      front: walk.front,
      source: lifeBodyBox(life, life.position, life.heading, false),
      target: lifeBodyBox(life, target, this.arrivalHeading(life), false),
    };
  }
  private indexBody(life: Life) {
    const box = lifeBodyBox(life);
    this.bodyBoxes.set(life, box);
    this.bodies.set(life, box);
  }
  private bodyBlocked(life: Life, box: Obstacle, parkedOnly = false): boolean {
    for (const other of this.bodies.query(box))
      if (
        other !== life &&
        (!parkedOnly || !this.traffic.active(other.key)) &&
        boxesOverlap(box, this.bodyBoxes.get(other)!)
      )
        return true;
    return false;
  }
  private claimTraffic(life: Life) {
    if (life.requested && !this.itemAvailable(life)) return false;
    const claimed = this.traffic.claim(
      life.key,
      (start, end) => this.passageBlocked(life, start, end),
      (route) => life.route.splice(0, life.route.length, ...route),
    );
    if (this.traffic.reserved(life.key) && life.requested) this.activateItem(life);
    if (claimed) life.walking = true;
    return claimed;
  }
  private passageBlocked(life: Life, start: Vector3, end: Vector3) {
    const heading = Math.atan2(end.x - start.x, end.z - start.z);
    const from = lifeBodyBox(life, start, heading, true),
      to = lifeBodyBox(life, end, heading, true);
    const box: Obstacle = {
      min: [Math.min(from.min[0], to.min[0]), Math.min(from.min[1], to.min[1])],
      max: [Math.max(from.max[0], to.max[0]), Math.max(from.max[1], to.max[1])],
    };
    return (
      [...this.itemBoxes.values()].some(
        (item) => item.active && item.owner !== life.key && boxesOverlap(box, item.box),
      ) || this.bodyBlocked(life, box, true)
    );
  }
  private itemAvailable(life: Life) {
    if (
      life.requested !== "keyboard" &&
      this.lobbyVisitor !== null &&
      this.lobbyVisitor !== life.key
    )
      return false;
    const item = [...this.itemBoxes.values()].find((item) => item.owner === life.key);
    return (
      !item ||
      item.active ||
      (!this.traffic.busy(item.box, life.key) && !this.bodyBlocked(life, item.box))
    );
  }
  private activateItem(life: Life) {
    if (life.requested !== "keyboard") this.lobbyVisitor = life.key;
    for (const item of this.itemBoxes.values()) if (item.owner === life.key) item.active = true;
  }
  add(
    actor: OfficeActor,
    site: RoomSite,
    variant: RoomVariant,
    slot: number,
    restBerth: { site: RoomSite | null; slot: number },
  ): Life {
    const existing = this.lives.get(actor.key);
    if (existing) {
      if (
        existing.actor.projectId === actor.projectId &&
        existing.site.index === site.index &&
        existing.variant === variant &&
        this.slots.get(actor.key) === slot &&
        (actor.child ||
          (existing.restSite?.index === restBerth.site?.index &&
            existing.restSlot === restBerth.slot))
      )
        return existing;
      // Reconciliation can skip the absent snapshot of a completed departure. Its old
      // cosmetic life must not occupy a berth already reassigned to someone else.
      this.remove(actor.key);
    }
    this.slots.set(actor.key, slot);
    const home = vector(homePoint(site, variant, slot)),
      rest = vector(
        restBerth.site
          ? roomPoint(restBerth.site, "atlas", restBerth.slot % 2 === 0 ? [-3.75, 0] : [3.75, 0])
          : LOBBY_SPOTS[0]!,
      );
    const life: Life = {
      key: actor.key,
      actor,
      site,
      variant,
      restSite: restBerth.site,
      restSlot: restBerth.slot,
      home,
      rest,
      position: home.clone(),
      route: [],
      heading: roomRotation(site, variant),
      destination: "home",
      phase: "rest",
      performance: null,
      performanceTime: 0,
      performanceReady: false,
      activityStatus: null,
      requested: null,
      pendingReturn: false,
      routeBlocked: false,
      walking: false,
      visit: false,
      pendingTravel: null,
      renderCell: "",
      departing: false,
      automaticVisitRunId: null,
    };
    this.lives.set(actor.key, life);
    this.update(actor);
    this.publish();
    return life;
  }
  remove(key: string) {
    const life = this.lives.get(key);
    if (life) {
      life.visit = false;
      this.releaseTraffic(life);
      this.bodies.delete(life);
      this.bodyBoxes.delete(life);
    }
    this.lives.delete(key);
    if (this.lobbyVisitor === key) this.lobbyVisitor = null;
    this.slots.delete(key);
    for (const [item, entry] of this.itemBoxes)
      if (entry.owner === key) this.itemBoxes.delete(item);
    this.publish();
    for (const [item, owner] of this.reservations)
      if (owner === key) this.reservations.delete(item);
  }
  update(actor: OfficeActor) {
    const life = this.lives.get(actor.key);
    if (!life) return;
    life.actor = actor;
    const wantsLobby = !actor.child && actor.status === "idle" && actor.shell.latestRunId !== null;
    if (life.departing) return;
    if (life.requested) {
      const allowed = life.actor.child
        ? ["ready", "starting", "working", "thinking", "streaming"].includes(actor.status)
        : life.requested === "keyboard"
          ? ["ready", "working", "thinking", "streaming"].includes(actor.status)
          : ["idle", "ready"].includes(actor.status);
      if (allowed) return;
      this.release(life);
      life.destination = "lobby";
      this.travel(life, "home");
      return;
    }
    if (life.performance) {
      if (
        (!actor.child && !wantsLobby && life.performance !== "keyboard") ||
        ["waiting", "error", "offline", "sleeping", "interrupted"].includes(actor.status)
      ) {
        life.pendingReturn = true;
        if (life.phase === "use") life.phase = "recover";
      }
      return;
    }
    const destination = wantsLobby ? "lobby" : "home";
    if ((life.pendingTravel ?? life.destination) !== destination) this.travel(life, destination);
  }
  private occupiedLobbyPoints(life: Life): ReadonlyArray<Point> {
    return [...this.lives.values()]
      .filter((other) => other !== life && !other.actor.child && other.restSite === null)
      .map((other) => [other.rest.x, other.rest.z] as Point);
  }
  private homeRoute(life: Life) {
    const slot = this.slots.get(life.key) ?? 0;
    const exit = roomExit(
      life.site,
      life.variant,
      slot,
      homeLocal(life.variant, slot),
      this.roomObstacles(life),
    );
    return exit;
  }
  private restRoute(life: Life) {
    if (!life.restSite) return lobbyPath([life.rest.x, life.rest.z], [7, 0]);
    const local: Point = life.restSlot % 2 === 0 ? [-3.75, 0] : [3.75, 0];
    return [local, [0, 0], [0, 5.5]].map((p) =>
      vector(roomPoint(life.restSite!, "atlas", p as Point)),
    );
  }
  private roomObstacles(life: Life) {
    const other = homeLocal(life.variant, life.actor.child ? 0 : 1);
    const body = bodyBounds[life.actor.child ? "main" : "child"];
    const berth: Obstacle = {
      min: [other[0] + body.min[0]!, other[1] + body.min[1]!],
      max: [other[0] + body.max[0]!, other[1] + body.max[1]!],
    };
    const keyboard =
      life.actor.child && life.variant === "grove"
        ? [
            {
              min: [
                performanceBounds.keyboard[0]! - 0.1,
                performanceBounds.keyboard[1]! - 0.1,
              ] as Point,
              max: [
                performanceBounds.keyboard[2]! + 0.1,
                performanceBounds.keyboard[3]! + 0.1,
              ] as Point,
            },
          ]
        : [];
    return [...obstacles[life.variant], berth, ...keyboard];
  }
  private travel(life: Life, destination: "home" | "lobby", cleared = false) {
    if (!cleared && this.traffic.active(life.key)) {
      // Continue to a graph node where a replacement passage can be reserved safely.
      life.pendingTravel = destination;
      return;
    }
    if (!cleared) this.releaseTraffic(life);

    const homeRoute = this.homeRoute(life),
      restRoute = this.restRoute(life);
    if (!homeRoute || !restRoute) {
      life.routeBlocked = true;
      return;
    }
    const local = roomLocal(life.site, life.variant, [life.position.x, life.position.z]);
    const inRoom = Math.abs(local[0]) < 6 && Math.abs(local[1]) < 5.5;
    const visiting = life.requested !== null && life.requested !== "keyboard";
    const targetSite = destination === "home" ? life.site : visiting ? null : life.restSite;
    const entry =
      destination === "home"
        ? homeRoute.toReversed()
        : visiting
          ? lobbyPath(
              [7, 0],
              PERFORMANCES[life.requested!].start,
              life.actor.child,
              this.occupiedLobbyPoints(life),
            )
          : restRoute.toReversed();
    if (!entry) {
      life.routeBlocked = true;
      return;
    }
    let path: Vector3[];
    let alternatives: Vector3[][] = [];
    const through = (from: RoomSite | null, prefix: readonly Vector3[]) => {
      const paths = routeOptionsBetweenSites(from, targetSite).map((route) => [
        ...prefix,
        ...route.map(vector),
        ...entry,
      ]);
      alternatives = paths.slice(1);
      return paths[0]!;
    };
    const corridor = cleared
      ? Array.from(
          { length: Math.max(life.site.ring, life.restSite?.ring ?? 0) + 1 },
          (_, ring) => ring,
        ).find((ring) => {
          const [x, z] = ringSize(ring);
          return (
            (Math.abs(Math.abs(life.position.x) - x) < 0.001 && Math.abs(life.position.z) <= z) ||
            (Math.abs(Math.abs(life.position.z) - z) < 0.001 && Math.abs(life.position.x) <= x)
          );
        })
      : undefined;
    if (cleared && corridor !== undefined) {
      path = [
        ...routeBetweenSites({ ...life.site, ring: corridor }, targetSite, [
          life.position.x,
          life.position.z,
        ]).map(vector),
        ...entry,
      ];
    } else if (cleared) return;
    else if (inRoom) {
      const target =
        destination === "home"
          ? life.requested === "keyboard"
            ? PERFORMANCES.keyboard.start
            : homeLocal(life.variant, this.slots.get(life.key) ?? 0)
          : localDoor(life.variant);
      const inside =
        destination === "lobby" && life.position.distanceTo(life.home) < 0.001
          ? null
          : findPath(
              local,
              target,
              this.roomObstacles(life),
              [-6, -5.5, 6, 5.5],
              life.actor.child ? bodyBounds.child.walk : bodyBounds.main.walk,
            );
      if (!inside && (destination !== "lobby" || life.position.distanceTo(life.home) >= 0.001)) {
        life.routeBlocked = true;
        return;
      }
      const prefix = inside ? pathsToWorld(inside, life.site, life.variant) : homeRoute;
      path = destination === "home" ? [...prefix] : through(life.site, prefix);
    } else if (Math.abs(life.position.x) <= 7.8 && Math.abs(life.position.z) <= 6.8) {
      const direct = destination === "lobby" && (visiting || !life.restSite);
      const target: Point = direct
        ? visiting
          ? PERFORMANCES[life.requested!].start
          : [life.rest.x, life.rest.z]
        : [7, 0];
      const inside = lobbyPath(
        [life.position.x, life.position.z],
        target,
        life.actor.child,
        this.occupiedLobbyPoints(life),
      );
      if (!inside) {
        life.routeBlocked = true;
        return;
      }
      path = direct ? inside : through(null, inside);
    } else {
      path = through(life.restSite, restRoute);
    }
    const priorDestination = life.destination;
    life.destination = destination;
    if (
      cleared &&
      !this.traffic.redirect(
        life.key,
        life.position,
        compactRoute(life.position, path),
        (a, b) => this.passageBlocked(life, a, b),
        this.travelShape(life, path.at(-1)!),
      )
    ) {
      life.destination = priorDestination;
      return;
    }
    life.pendingTravel = null;
    life.destination = destination;
    this.setRoute(life, path, cleared, alternatives);
    life.phase = "walking";
    life.routeBlocked = false;
  }
  request(key: string, amenity: Amenity): string | null {
    const life = this.lives.get(key),
      p = PERFORMANCES[amenity];
    if (!life) return "Select an agent first.";
    if (life.actor.status === "offline")
      return "Reconnect this environment before starting a visit.";
    if (life.actor.child !== p.child)
      return p.child
        ? "This performance uses the approved child rig. Select a live child visitor."
        : "Select a main agent for this amenity.";
    if (
      life.actor.child &&
      (life.actor.status === "sleeping" ||
        life.actor.status === "interrupted" ||
        life.actor.status === "error")
    )
      return "Completed children stay on their project floor until explicitly closed by their parent.";
    if (!life.actor.child && amenity === "coffee" && !["idle", "ready"].includes(life.actor.status))
      return "Coffee visits are for idle main agents. New work returns them immediately.";
    if (life.actor.status === "waiting")
      return "Answer the pending request before starting a cosmetic visit.";
    if (amenity === "keyboard" && life.variant !== "grove")
      return "The contact keyboard is in a workshop room.";
    if (life.performance || life.requested) return "This agent already has a visit in progress.";
    const reservation = `${amenity}:${amenity === "keyboard" ? life.site.index : "lobby"}`;
    if (this.reservations.has(reservation))
      return "This item is reserved. Choose another agent or try when it is free.";
    const itemBox = this.boxForItem(life, amenity);
    if (
      this.traffic.busy(itemBox, key) ||
      [...this.itemBoxes.values()].some(
        (item) => item.owner !== key && boxesOverlap(itemBox, item.box),
      )
    )
      return "The approach or use space is busy. Try when that route is clear.";
    if (
      [...this.lives.values()].some(
        (other) => other !== life && boxesOverlap(itemBox, lifeBodyBox(other)),
      )
    )
      return "Another occupant is in this item's use space.";
    // A queued visit must not block the older traffic it is waiting for.
    this.itemBoxes.set(reservation, { owner: key, box: itemBox, active: false });
    this.reservations.set(reservation, key);
    life.visit = true;
    life.requested = amenity;
    const target =
      amenity === "keyboard"
        ? vector(roomPoint(life.site, life.variant, p.start))
        : vector(p.start);
    const start: Point = [life.position.x, life.position.z];
    const local =
      amenity === "keyboard"
        ? null
        : lobbyPath(start, p.start, life.actor.child, this.occupiedLobbyPoints(life));
    if (
      amenity !== "keyboard" &&
      this.lobbyVisitor === key &&
      Math.abs(life.position.x) <= 7.8 &&
      Math.abs(life.position.z) <= 6.8 &&
      local
    ) {
      life.pendingTravel = null;
      life.destination = "lobby";
      this.setRoute(life, local);
      life.phase = "approach";
    } else if (this.traffic.active(key)) {
      this.travel(life, amenity === "keyboard" ? "home" : "lobby");
    } else if (amenity === "keyboard") {
      const localPosition = roomLocal(life.site, life.variant, [life.position.x, life.position.z]);
      if (
        Math.abs(localPosition[0]) > 6 ||
        Math.abs(localPosition[1]) > 5.5 ||
        Math.abs(life.position.y - target.y) > 1
      )
        this.travel(life, "home");
      else {
        const path = findPath(
          localPosition,
          p.start,
          this.roomObstacles(life),
          [-6, -5.5, 6, 5.5],
          life.actor.child ? bodyBounds.child.walk : bodyBounds.main.walk,
        );
        if (!path) {
          this.release(life);
          return "No clear approach to this keyboard is available.";
        }
        this.setRoute(life, pathsToWorld(path, life.site, life.variant));
        life.phase = "approach";
      }
    } else if (
      Math.abs(life.position.x) > 7.8 ||
      Math.abs(life.position.z) > 6.8 ||
      Math.abs(life.position.y - target.y) > 1
    ) {
      this.travel(life, "lobby");
    } else if (local) {
      this.setRoute(life, local);
      life.phase = "approach";
    } else {
      this.release(life);
      return "No clear approach to this item is available.";
    }
    return null;
  }
  private arrive(life: Life, reduced: boolean) {
    if (
      life.visit &&
      !life.requested &&
      !life.performance &&
      Math.min(life.position.distanceTo(life.home), life.position.distanceTo(life.rest)) < 0.1
    ) {
      life.visit = false;
      if (this.lobbyVisitor === life.key) this.lobbyVisitor = null;
      this.traffic.remove(life.key);
    }
    const pending = life.pendingTravel;
    if (pending) {
      life.pendingTravel = null;
      if (!life.departing) this.travel(life, pending);
    } else this.visitOnArrival(life, reduced);
  }
  private arrivalHeading(life: Life) {
    if (life.requested)
      return life.requested === "keyboard" ? roomRotation(life.site, life.variant) : 0;
    return life.destination === "home"
      ? roomRotation(life.site, life.variant)
      : life.restSite
        ? roomRotation(life.restSite, "atlas")
        : 0;
  }
  private visitOnArrival(life: Life, reduced: boolean) {
    if (
      reduced ||
      life.departing ||
      life.actor.child ||
      life.actor.status !== "idle" ||
      life.destination !== "lobby" ||
      life.requested ||
      life.performance ||
      life.actor.shell.latestRunId === null ||
      life.restSite !== null ||
      life.automaticVisitRunId === life.actor.shell.latestRunId
    )
      return;
    if (this.request(life.key, "coffee") === null)
      life.automaticVisitRunId = life.actor.shell.latestRunId;
  }
  private release(life: Life) {
    for (const [item, owner] of this.reservations)
      if (owner === life.key) {
        this.reservations.delete(item);
        this.itemBoxes.delete(item);
      }
    life.performance = null;
    life.performanceReady = false;
    life.requested = null;
    life.performanceTime = 0;
    this.publish();
  }
  tick(delta: number, reduced: boolean): boolean {
    this.traffic.beginFrame(delta);
    this.bodies.clear();
    this.bodyBoxes.clear();
    for (const life of this.lives.values()) this.indexBody(life);
    let moving = false;
    let changedCell = false;
    for (const life of this.lives.values()) {
      const cell = `${Math.floor(life.position.x / 12)}:${0}:${Math.floor(life.position.z / 12)}`;
      if (cell !== life.renderCell) {
        life.renderCell = cell;
        changedCell = true;
      }
      if (life.actor.status === "offline" && !this.traffic.active(life.key)) continue;
      if (life.performance) {
        moving = true;
        // Logical visits advance even when the rig is culled or its asset is still loading.
        const p = PERFORMANCES[life.performance];
        life.performanceTime = Math.min(
          p.seconds,
          life.performanceTime + delta * (life.phase === "recover" ? 2 : 1),
        );
        if (life.performanceTime >= p.seconds) {
          const ended = life.performance;
          this.release(life);
          life.phase = "rest";
          if (ended !== "keyboard") life.position.copy(vector(PERFORMANCES[ended].start));
          if (life.departing) continue;
          if (ended === "keyboard") {
            life.destination = "lobby";
            this.travel(life, life.actor.status === "idle" ? "lobby" : "home");
            continue;
          }
          if (life.pendingReturn || life.actor.child || life.actor.status !== "idle") {
            life.pendingReturn = false;
            life.destination = "lobby";
            this.travel(life, "home");
          } else {
            this.travel(life, "lobby");
          }
        }
        continue;
      }
      if (life.route.length > 0) {
        moving = true;
        if (!this.claimTraffic(life)) {
          life.routeBlocked = true;
          continue;
        }
        let budget = delta * 0.9;
        while (life.route.length && budget > 0.000001) {
          const target = life.route[0]!,
            direction = target.clone().sub(life.position),
            distance = direction.length();
          const length = Math.min(distance, budget);
          const next = distance
            ? life.position.clone().addScaledVector(direction, length / distance)
            : target;
          const heading = distance > 0.000001 ? Math.atan2(direction.x, direction.z) : life.heading;
          const last = life.route.length === 1 && length === distance;
          const blocked = this.bodyBlocked(
            life,
            lifeBodyBox(life, next, last ? this.arrivalHeading(life) : heading, !last),
          );
          life.routeBlocked = blocked;
          if (blocked) break;
          life.position.copy(next);
          life.heading = heading;
          budget -= length;
          if (length === distance) {
            life.route.shift();
            if (life.route.length && life.pendingTravel) {
              this.travel(life, life.pendingTravel, true);
              if (!life.pendingTravel) budget = 0;
            }
          }
          if (!life.route.length) {
            this.traffic.arrive(life.key);
            life.walking = false;
            life.heading = this.arrivalHeading(life);
            this.arrive(life, reduced);
            budget = 0;
          }
          this.indexBody(life);
        }
        continue;
      }

      if (life.requested) {
        const p = PERFORMANCES[life.requested],
          target =
            life.requested === "keyboard"
              ? vector(roomPoint(life.site, life.variant, p.start))
              : vector(p.start);
        if (life.position.distanceTo(target) > 0.1) {
          const path =
            life.requested === "keyboard"
              ? findPath(
                  homeLocal(life.variant, this.slots.get(life.key) ?? 0),
                  p.start,
                  this.roomObstacles(life),
                  [-6, -5.5, 6, 5.5],
                  life.actor.child ? bodyBounds.child.walk : bodyBounds.main.walk,
                )
              : null;
          const route = path
            ? pathsToWorld(path, life.site, life.variant)
            : lobbyPath(
                [life.position.x, life.position.z],
                p.start,
                life.actor.child,
                this.occupiedLobbyPoints(life),
              );
          if (route) {
            this.setRoute(life, route);
            life.phase = "approach";
          } else {
            this.release(life);
            life.routeBlocked = true;
          }
        } else {
          if (!this.itemAvailable(life)) {
            life.routeBlocked = true;
            continue;
          }
          this.activateItem(life);
          life.performance = life.requested;
          life.requested = null;
          life.performanceTime = 0;
          life.performanceReady = false;
          life.phase = "use";
          this.publish();
        }
      } else life.phase = "rest";
    }
    if (changedCell) this.publish();
    return moving;
  }
  clear() {
    this.lives.clear();
    this.reservations.clear();
    this.slots.clear();
    this.traffic.clear();
    this.bodies.clear();
    this.bodyBoxes.clear();
    this.itemBoxes.clear();
    this.lobbyVisitor = null;
    this.publish();
  }
}
