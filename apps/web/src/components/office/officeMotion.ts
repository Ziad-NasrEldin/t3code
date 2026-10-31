import type { OfficeActor, OfficeStatus } from "@t3tools/client-runtime/state/office";
import { Vector3 } from "three";
import performanceBounds from "./performanceBounds.json";
import rawObstacles from "./obstacles.json";
import {
  DECK_HEIGHT,
  ROOM_CAPACITY,
  LOBBY_CAPACITY,
  roomRotation,
  findPath,
  homePoint,
  roomPoint,
  roomLocal,
  routeToLobby,
  type Point,
  type RoomSite,
  type RoomVariant,
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
const LOBBY_SPOTS: ReadonlyArray<Point> = [
  [0, 3],
  [0.5, -2.5],
];
export interface Life {
  readonly key: string;
  actor: OfficeActor;
  readonly site: RoomSite;
  readonly variant: RoomVariant;
  readonly homeDeck: number;
  lobbyDeck: number;
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
  traffic: Set<string> | null;
  failedTrafficVersion: number;
  renderCell: string;
  departing: boolean;
  automaticVisitRunId: string | null;
}
function vector(p: Point, deck: number) {
  return new Vector3(p[0], deck * DECK_HEIGHT + 0.07, p[1]);
}
function localDoor(variant: RoomVariant): Point {
  return variant === "grove" ? [5.5, 0] : variant === "prism" ? [-5.5, 0] : [0, 5.5];
}
function localHome(slot: number): Point {
  return slot % 2 === 0 ? [-2.5, 4] : [3.5, 3.75];
}
function pathsToWorld(
  path: ReadonlyArray<Point>,
  site: RoomSite,
  variant: RoomVariant,
  deck: number,
) {
  return path.map((p) => vector(roomPoint(site, variant, p), deck));
}
function roomExit(
  site: RoomSite,
  variant: RoomVariant,
  slot: number,
  deck: number,
  start: Point = localHome(slot),
) {
  const path = findPath(
    start,
    localDoor(variant),
    obstacles[variant] as ReadonlyArray<{ min: Point; max: Point }>,
    [-6, -5.5, 6, 5.5],
    0.7,
  );
  return path === null ? null : pathsToWorld(path, site, variant, deck);
}
function lobbyPath(
  start: Point,
  end: Point,
  deck: number,
  child = false,
  restPoints: ReadonlyArray<Point> = LOBBY_SPOTS,
) {
  const reserved = restPoints
    .filter(
      (p) =>
        Math.hypot(p[0] - start[0], p[1] - start[1]) > 2.1 &&
        Math.hypot(p[0] - end[0], p[1] - end[1]) > 2.1,
    )
    .map((p) => ({
      min: [p[0] - 1.2, p[1] - 1.2] as Point,
      max: [p[0] + 1.2, p[1] + 1.2] as Point,
    }));
  const path = findPath(
    start,
    end,
    [...obstacles.lobby, ...reserved],
    [-7.8, -6.8, 10, 8.5],
    child ? 0.7 : 0.85,
  );
  return path?.map((p) => vector(p, deck)) ?? null;
}
export class OfficeMotion {
  readonly lives = new Map<string, Life>();
  private readonly lifecycleListeners = new Set<
    (key: string, transition: "arriving" | "departing") => void
  >();
  subscribeLifecycle(listener: (key: string, transition: "arriving" | "departing") => void) {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }
  finishLifecycle(key: string, transition: "arriving" | "departing") {
    for (const listener of this.lifecycleListeners) listener(key, transition);
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
  private readonly lobbySlots = new Map<string, number>();
  private readonly itemCells = new Map<string, { owner: string; cells: Set<string> }>();
  private trafficVersion = 0;
  setDeparture(key: string, departing: boolean) {
    const life = this.lives.get(key);
    if (!life || life.departing === departing) return;
    life.departing = departing;
    this.releaseTraffic(life);
    life.route.splice(0);
    if (departing) {
      if (life.requested) this.release(life);
      if (life.performance) life.phase = "recover";
    } else {
      life.pendingReturn = false;
      life.destination = life.destination === "home" ? "lobby" : "home";
      this.update(life.actor);
    }
  }
  private cellsForItem(life: Life, amenity: Amenity, deck: number) {
    const b = performanceBounds[amenity],
      localCorners = [
        [b[0]! - 1, b[1]! - 1],
        [b[2]! + 1, b[3]! + 1],
      ] as const;
    const corners =
      amenity === "keyboard"
        ? localCorners.map((point) => roomPoint(life.site, life.variant, point))
        : localCorners;
    const minX = Math.min(...corners.map((point) => point[0])),
      maxX = Math.max(...corners.map((point) => point[0])),
      minZ = Math.min(...corners.map((point) => point[1])),
      maxZ = Math.max(...corners.map((point) => point[1]));
    const cells = new Set<string>();
    for (let x = Math.floor(minX * 2); x <= Math.ceil(maxX * 2); x++)
      for (let z = Math.floor(minZ * 2); z <= Math.ceil(maxZ * 2); z++)
        for (let dy = 0; dy <= 1; dy++) cells.add(`${x}:${deck * 2 + dy}:${z}`);
    return cells;
  }

  private readonly trafficOwners = new Map<string, string>();
  private readonly pathBuilders = new Map<
    string,
    { cells: Set<string>; iterator: Generator<string>; version: number }
  >();
  private pathBuildBudget = 0;
  private allocateLobby(key: string) {
    const prior = this.lobbySlots.get(key);
    if (prior !== undefined) return prior;
    const used = new Set(this.lobbySlots.values());
    let slot = 0;
    while (used.has(slot)) slot++;
    this.lobbySlots.set(key, slot);
    return slot;
  }
  private releaseTraffic(life: Life) {
    for (const cell of life.traffic ?? [])
      if (this.trafficOwners.get(cell) === life.key) this.trafficOwners.delete(cell);
    life.traffic = null;
    this.pathBuilders.delete(life.key);
    life.failedTrafficVersion = -1;
    this.trafficVersion++;
  }
  private claimTraffic(life: Life) {
    if (life.traffic !== null) return true;
    if (life.failedTrafficVersion === this.trafficVersion) return false;
    if (this.pathBuildBudget <= 0) return false;
    let build = this.pathBuilders.get(life.key);
    if (!build) {
      build = { cells: new Set(), iterator: this.routeCells(life), version: this.trafficVersion };
      this.pathBuilders.set(life.key, build);
    }
    while (this.pathBuildBudget > 0) {
      this.pathBuildBudget--;
      const next = build.iterator.next();
      if (next.done) {
        this.pathBuilders.delete(life.key);
        if (
          build.version !== this.trafficVersion &&
          [...build.cells].some((cell) => this.cellBlocked(cell, life.key))
        ) {
          life.failedTrafficVersion = this.trafficVersion;
          return false;
        }
        for (const cell of build.cells) this.trafficOwners.set(cell, life.key);
        life.traffic = build.cells;
        this.trafficVersion++;
        return true;
      }
      if (this.cellBlocked(next.value, life.key)) {
        this.pathBuilders.delete(life.key);
        life.failedTrafficVersion = this.trafficVersion;
        return false;
      }
      build.cells.add(next.value);
    }
    return false;
  }
  private cellBlocked(cell: string, key: string) {
    return (
      (this.trafficOwners.has(cell) && this.trafficOwners.get(cell) !== key) ||
      [...this.itemCells.values()].some((item) => item.owner !== key && item.cells.has(cell))
    );
  }
  private *routeCells(life: Life): Generator<string> {
    const points = [life.position.clone(), ...life.route];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!,
        b = points[i]!,
        steps = Math.max(1, Math.ceil(a.distanceTo(b) / 0.5));
      for (let step = 0; step <= steps; step++) {
        const at = a.clone().lerp(b, step / steps),
          x = Math.round(at.x * 2),
          z = Math.round(at.z * 2),
          y = Math.floor(at.y / 3.5);
        for (let dx = -2; dx <= 2; dx++)
          for (let dz = -2; dz <= 2; dz++)
            for (let dy = 0; dy <= 1; dy++) yield `${x + dx}:${y + dy}:${z + dz}`;
      }
    }
  }
  add(actor: OfficeActor, site: RoomSite, variant: RoomVariant, slot: number): Life {
    const existing = this.lives.get(actor.key);
    if (existing && existing.actor.projectId !== actor.projectId) this.remove(actor.key);
    else if (existing) return existing;
    this.slots.set(actor.key, slot);
    const lobbySlot = actor.child ? 0 : this.allocateLobby(actor.key);
    const homeDeck = Math.floor(slot / ROOM_CAPACITY),
      lobbyDeck = Math.floor(lobbySlot / LOBBY_CAPACITY),
      home = vector(homePoint(site, variant, slot), homeDeck),
      rest = vector(LOBBY_SPOTS[lobbySlot % LOBBY_SPOTS.length]!, lobbyDeck);
    const life: Life = {
      key: actor.key,
      actor,
      site,
      variant,
      homeDeck,
      lobbyDeck,
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
      traffic: null,
      failedTrafficVersion: -1,
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
    if (life) this.releaseTraffic(life);
    this.lives.delete(key);
    this.slots.delete(key);
    this.lobbySlots.delete(key);
    for (const [item, entry] of this.itemCells)
      if (entry.owner === key) this.itemCells.delete(item);
    this.trafficVersion++;
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
    if (life.destination !== destination) this.travel(life, destination);
  }
  private occupiedLobbyPoints(life: Life): ReadonlyArray<Point> {
    return [...this.lives.values()]
      .filter(
        (other) =>
          other !== life &&
          other.lobbyDeck === life.lobbyDeck &&
          other.position.distanceTo(other.rest) < 0.2,
      )
      .map((other) => [other.rest.x, other.rest.z] as Point);
  }
  private travel(life: Life, destination: "home" | "lobby") {
    this.releaseTraffic(life);
    life.destination = destination;
    const slot = this.slots.get(life.key) ?? 0,
      local = roomLocal(life.site, life.variant, [life.position.x, life.position.z]),
      inRoom =
        Math.abs(local[0]) < 6 &&
        Math.abs(local[1]) < 5.5 &&
        Math.abs(life.position.y - life.home.y) < 0.1;
    if (destination === "home" && inRoom) {
      const path = findPath(
        local,
        localHome(slot),
        obstacles[life.variant],
        [-6, -5.5, 6, 5.5],
        0.7,
      );
      if (path) {
        life.route.splice(
          0,
          life.route.length,
          ...pathsToWorld(path, life.site, life.variant, life.homeDeck),
        );
        life.phase = "walking";
        life.routeBlocked = false;
      }
      return;
    }
    const exit = roomExit(
      life.site,
      life.variant,
      slot,
      life.homeDeck,
      inRoom ? local : localHome(slot),
    );
    const entry = lobbyPath(
      [7, 0],
      life.requested && life.requested !== "keyboard"
        ? PERFORMANCES[life.requested].start
        : LOBBY_SPOTS[(this.lobbySlots.get(life.key) ?? 0) % LOBBY_SPOTS.length]!,
      life.lobbyDeck,
      life.actor.child,
      life.requested ? this.occupiedLobbyPoints(life) : LOBBY_SPOTS,
    );
    if (!exit || !entry) {
      life.routeBlocked = true;
      return;
    }
    const shared = routeToLobby(life.site).map((p) => vector(p, life.homeDeck));
    const lift = vector([9.5, 8.5], life.lobbyDeck);
    const lobbyLink = [lift, vector([9.5, 0], life.lobbyDeck), vector([7, 0], life.lobbyDeck)];
    // The corner shaft keeps deck changes outside every removable room.
    const corner = shared.findIndex((p) => p.x === 9.5 && p.z === 8.5);
    const forward = [
      ...exit,
      ...(corner < 0 ? shared : shared.slice(0, corner + 1)),
      ...lobbyLink,
      ...entry,
      ...(life.requested && life.requested !== "keyboard" ? [] : [life.rest.clone()]),
    ];
    let path = destination === "lobby" ? forward : forward.toReversed();
    if (
      destination === "home" &&
      life.position.distanceTo(life.rest) < 10 &&
      Math.abs(life.position.y - life.rest.y) < 0.1
    ) {
      const fromLobby = lobbyPath([life.position.x, life.position.z], [7, 0], life.lobbyDeck);
      if (fromLobby)
        path = [
          ...fromLobby,
          ...lobbyLink.toReversed(),
          ...(corner < 0 ? shared : shared.slice(0, corner + 1)).toReversed(),
          ...exit.toReversed(),
          life.home.clone(),
        ];
    }
    let nearest = 0,
      best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < path.length; i++) {
      const d = path[i]!.distanceToSquared(life.position);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    life.route.splice(0, life.route.length, ...path.slice(nearest));
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
    if (life.actor.child && amenity !== "keyboard") {
      const slot = this.allocateLobby(key);
      life.lobbyDeck = Math.floor(slot / LOBBY_SPOTS.length);
      life.rest.copy(vector(LOBBY_SPOTS[slot % LOBBY_SPOTS.length]!, life.lobbyDeck));
    }
    const deck = amenity === "keyboard" ? life.homeDeck : life.lobbyDeck;
    const reservation = `${amenity}:${amenity === "keyboard" ? life.actor.projectId : "lobby"}:${deck}`;
    if (this.reservations.has(reservation))
      return "This item is reserved. Choose another agent or try when it is free.";
    const itemCells = this.cellsForItem(life, amenity, deck);
    if (
      [...itemCells].some(
        (cell) =>
          (this.trafficOwners.has(cell) && this.trafficOwners.get(cell) !== key) ||
          [...this.itemCells.values()].some((item) => item.owner !== key && item.cells.has(cell)),
      )
    )
      return "The approach or use space is busy. Try when that route is clear.";
    if (
      [...this.lives.values()].some(
        (other) =>
          other !== life &&
          Math.abs(other.position.y - deck * DECK_HEIGHT) < 1 &&
          itemCells.has(
            `${Math.round(other.position.x * 2)}:${deck * 2}:${Math.round(other.position.z * 2)}`,
          ),
      )
    )
      return "Another occupant is in this item's use space.";
    this.itemCells.set(reservation, { owner: key, cells: itemCells });
    this.trafficVersion++;
    this.releaseTraffic(life);
    this.reservations.set(reservation, key);
    life.requested = amenity;
    const target =
      amenity === "keyboard"
        ? vector(roomPoint(life.site, life.variant, p.start), deck)
        : vector(p.start, deck);
    const start: Point = [life.position.x, life.position.z];
    const local =
      amenity === "keyboard"
        ? null
        : lobbyPath(start, p.start, deck, life.actor.child, this.occupiedLobbyPoints(life));
    if (amenity === "keyboard") {
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
          obstacles[life.variant],
          [-6, -5.5, 6, 5.5],
          0.7,
        );
        if (!path) {
          this.release(life);
          return "No clear approach to this keyboard is available.";
        }
        life.route.splice(
          0,
          life.route.length,
          ...pathsToWorld(path, life.site, life.variant, life.homeDeck),
        );
        life.phase = "approach";
      }
    } else if (
      life.position.distanceTo(life.rest) > 1 ||
      Math.abs(life.position.y - target.y) > 1
    ) {
      this.travel(life, "lobby");
    } else if (local) {
      life.route.splice(0, life.route.length, ...local);
      life.phase = "approach";
    } else {
      life.route.splice(0, life.route.length, target);
      life.phase = "approach";
    }
    return null;
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
        this.itemCells.delete(item);
      }
    this.trafficVersion++;
    life.performance = null;
    life.requested = null;
    life.performanceTime = 0;
    this.publish();
  }
  tick(delta: number, reduced: boolean): boolean {
    // Cosmetic path preparation is incremental; large inventories never allocate every route in one frame.
    this.pathBuildBudget = 2000;
    let moving = false;
    let changedCell = false;
    for (const life of this.lives.values()) {
      const cell = `${Math.floor(life.position.x / 12)}:${Math.round(life.position.y / 7)}:${Math.floor(life.position.z / 12)}`;
      if (cell !== life.renderCell) {
        life.renderCell = cell;
        changedCell = true;
      }
      if (life.actor.status === "offline") continue;
      if (life.performance) {
        moving = true;
        if (!life.performanceReady) continue;
        const p = PERFORMANCES[life.performance];
        life.performanceTime = Math.min(
          p.seconds,
          life.performanceTime + delta * (life.phase === "recover" ? 2 : 1),
        );
        if (life.performanceTime >= p.seconds) {
          const ended = life.performance;
          this.release(life);
          life.phase = "rest";
          if (ended !== "keyboard")
            life.position.copy(vector(PERFORMANCES[ended].start, life.lobbyDeck));
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
            const path = lobbyPath(
              [life.position.x, life.position.z],
              [life.rest.x, life.rest.z],
              life.lobbyDeck,
            );
            if (path) {
              life.route.splice(0, life.route.length, ...path);
              life.phase = "walking";
            }
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
        if (reduced) {
          life.position.copy(life.route.at(-1)!);
          life.route.splice(0);
          this.releaseTraffic(life);
          if (life.destination === "home") life.heading = roomRotation(life.site, life.variant);
          this.visitOnArrival(life, reduced);
          continue;
        }
        const target = life.route[0]!,
          direction = target.clone().sub(life.position),
          distance = direction.length();
        if (distance < 0.03) {
          life.position.copy(target);
          life.route.shift();
          if (life.route.length === 0) {
            this.releaseTraffic(life);
            if (life.destination === "home") life.heading = roomRotation(life.site, life.variant);
            this.visitOnArrival(life, reduced);
          }
          continue;
        }
        const next = life.position
          .clone()
          .addScaledVector(direction, Math.min(distance, delta * (reduced ? 8 : 0.9)) / distance);
        const blocked = [...this.lives.values()].some(
          (other) =>
            other !== life &&
            Math.abs(other.position.y - next.y) < 1 &&
            Math.hypot(other.position.x - next.x, other.position.z - next.z) < 2.05,
        );
        life.routeBlocked = blocked;
        if (blocked) continue;
        life.position.copy(next);
        if (Math.hypot(direction.x, direction.z) > 0.01)
          life.heading = Math.atan2(direction.x, direction.z);
        continue;
      }
      if (life.requested) {
        const p = PERFORMANCES[life.requested],
          target =
            life.requested === "keyboard"
              ? vector(roomPoint(life.site, life.variant, p.start), life.homeDeck)
              : vector(p.start, life.lobbyDeck);
        if (life.position.distanceTo(target) > 0.1) {
          const path =
            life.requested === "keyboard"
              ? findPath(
                  localHome(this.slots.get(life.key) ?? 0),
                  p.start,
                  obstacles[life.variant] as ReadonlyArray<{ min: Point; max: Point }>,
                  [-6, -5.5, 6, 5.5],
                  0.7,
                )
              : null;
          const route = path
            ? pathsToWorld(path, life.site, life.variant, life.homeDeck)
            : lobbyPath(
                [life.position.x, life.position.z],
                p.start,
                life.lobbyDeck,
                life.actor.child,
                this.occupiedLobbyPoints(life),
              );
          if (route) {
            life.route.push(...route);
            life.phase = "approach";
          } else {
            this.release(life);
            life.routeBlocked = true;
          }
        } else {
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
    this.lobbySlots.clear();
    this.trafficOwners.clear();
    this.pathBuilders.clear();
    this.itemCells.clear();
    this.publish();
  }
}
