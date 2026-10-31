export type Point = readonly [number, number];
export type RoomVariant = "atlas" | "grove" | "prism";
export interface RoomSite {
  readonly index: number;
  readonly ring: number;
  readonly x: number;
  readonly z: number;
  readonly side: "north" | "east" | "south" | "west";
}
// Each module has two clear berths. More occupants get another site on this same floor.
const MODULE_BERTHS = 2;
export function projectRoomKey(projectId: string, slot: number): string {
  const module = Math.floor(slot / MODULE_BERTHS);
  return module === 0 ? projectId : `extension:${projectId}:${module}`;
}
export function restAreaKey(slot: number): string | null {
  return !Number.isSafeInteger(slot) || slot < 1
    ? null
    : `common:${Math.floor((slot - 1) / MODULE_BERTHS)}`;
}
export function ringSize(ring: number): Point {
  // The fixed lobby rooms need the same 7.5-unit door setback as the outer modules.
  return [9.5 + ring * 18, ring === 0 ? 8.08 : 8.5 + ring * 18];
}
export function ringSites(ring: number): ReadonlyArray<Omit<RoomSite, "index">> {
  if (ring === 0)
    return [
      { ring, x: 0, z: -15.5, side: "north" },
      { ring, x: -17, z: 0, side: "west" },
      { ring, x: 17, z: 0, side: "east" },
      { ring, x: 0, z: 15.5, side: "south" },
    ];
  const [x, z] = ringSize(ring);
  const horizontal = Math.floor((x - 9) / 14),
    vertical = Math.floor((z - 9) / 14);
  const sites: Omit<RoomSite, "index">[] = [];
  for (let i = -horizontal; i <= horizontal; i++)
    sites.push(
      { ring, x: i * 14, z: -z - 7.5, side: "north" },
      { ring, x: i * 14, z: z + 7.5, side: "south" },
    );
  for (let i = -vertical; i <= vertical; i++)
    sites.push(
      { ring, x: -x - 7.5, z: i * 14, side: "west" },
      { ring, x: x + 7.5, z: i * 14, side: "east" },
    );
  return sites;
}
export function siteAt(index: number): RoomSite {
  let remaining = index;
  for (let ring = 0; ; ring++) {
    const sites = ringSites(ring);
    if (remaining < sites.length) return { ...sites[remaining]!, index };
    remaining -= sites.length;
  }
}
export function allocateStable(
  previous: Readonly<Record<string, number>>,
  keys: ReadonlyArray<string>,
): Record<string, number> {
  const next: Record<string, number> = {};
  const used = new Set<number>();
  for (const key of keys) {
    const slot = previous[key];
    if (Number.isSafeInteger(slot) && slot! >= 0 && !used.has(slot!)) {
      next[key] = slot!;
      used.add(slot!);
    }
  }
  for (const key of keys) {
    if (next[key] !== undefined) continue;
    let slot = 0;
    while (used.has(slot)) slot++;
    next[key] = slot;
    used.add(slot);
  }
  return next;
}
export function projectVariant(key: string): RoomVariant {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return (["atlas", "grove", "prism"] as const)[Math.abs(hash) % 3]!;
}
export function roomRotation(site: RoomSite, variant: RoomVariant): number {
  const desired = { north: 0, east: -Math.PI / 2, south: Math.PI, west: Math.PI / 2 }[site.side];
  return desired - { atlas: 0, grove: Math.PI / 2, prism: -Math.PI / 2 }[variant];
}
export function roomPoint(site: RoomSite, variant: RoomVariant, point: Point): Point {
  const a = roomRotation(site, variant),
    c = Math.cos(a),
    s = Math.sin(a);
  return [site.x + point[0] * c + point[1] * s, site.z - point[0] * s + point[1] * c];
}
export function roomLocal(site: RoomSite, variant: RoomVariant, point: Point): Point {
  const a = roomRotation(site, variant),
    x = point[0] - site.x,
    z = point[1] - site.z;
  return [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];
}
export function homePoint(site: RoomSite, variant: RoomVariant, slot: number): Point {
  return roomPoint(site, variant, homeLocal(variant, slot));
}
export function homeLocal(variant: RoomVariant, slot: number): Point {
  // Reserved resting envelopes must leave an exit aisle for the other berth.
  return slot % 2 === 0
    ? [-2.5, variant === "prism" ? 4.3125 : 3.75]
    : [3, variant === "grove" ? 4.125 : 3.5];
}
function roomDoor(site: RoomSite): Point {
  const [x, z] = ringSize(site.ring);
  if (site.side === "north") return [site.x, -z];
  if (site.side === "south") return [site.x, z];
  if (site.side === "east") return [x, site.z];
  return [-x, site.z];
}
// The four corner gaps are reserved independently of room occupancy. Each link
// crosses outside the complete inner room footprint, never through a project.
export function ringLinks(ring: number): ReadonlyArray<readonly [Point, Point]> {
  const inner = ringSize(ring - 1),
    outer = ringSize(ring);
  return [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((z) => [
      [
        [x * inner[0], z * inner[1]],
        [x * outer[0], z * inner[1]],
      ] as const,
      [
        [x * inner[0], z * inner[1]],
        [x * inner[0], z * outer[1]],
      ] as const,
    ]),
  );
}
export function routeBetweenSites(
  from: RoomSite | null,
  to: RoomSite | null,
  origin?: Point,
): ReadonlyArray<Point> {
  if (!from && !to && !origin) return [[7, 0]];
  const points: Point[] = [],
    rings: number[][] = [],
    edges = new Map<number, number[]>();
  const add = (ring: number, p: Point) => {
    const id = points.length;
    points.push(p);
    (rings[ring] ??= []).push(id);
    edges.set(id, []);
    return id;
  };
  const connect = (a: number, b: number) => {
    edges.get(a)!.push(b);
    edges.get(b)!.push(a);
  };
  const first = add(from?.ring ?? 0, origin ?? (from ? roomDoor(from) : [9.5, 0]));
  const last = add(to?.ring ?? 0, to ? roomDoor(to) : [9.5, 0]);
  for (let ring = 0; ring <= Math.max(from?.ring ?? 0, to?.ring ?? 0); ring++) {
    const [x, z] = ringSize(ring);
    for (const p of [
      [-x, -z],
      [x, -z],
      [x, z],
      [-x, z],
    ] as Point[])
      add(ring, p);
    if (ring) for (const [a, b] of ringLinks(ring)) connect(add(ring - 1, a), add(ring, b));
  }
  for (let ring = 0; ring < rings.length; ring++) {
    const [x, z] = ringSize(ring);
    const along = ([px, pz]: Point) =>
      Math.abs(pz + z) < 0.001
        ? px + x
        : Math.abs(px - x) < 0.001
          ? 2 * x + pz + z
          : Math.abs(pz - z) < 0.001
            ? 3 * x + 2 * z - px
            : 4 * x + 3 * z - pz;
    const ids = rings[ring]!.sort((a, b) => along(points[a]!) - along(points[b]!));
    for (let i = 0; i < ids.length; i++) connect(ids[i]!, ids[(i + 1) % ids.length]!);
  }
  const distances = points.map(() => Infinity),
    previous = new Map<number, number>(),
    pending = new Set(points.map((_, i) => i));
  distances[first] = 0;
  while (pending.size) {
    let at = -1;
    for (const id of pending) if (at < 0 || distances[id]! < distances[at]!) at = id;
    pending.delete(at);
    if (at === last) break;
    for (const next of edges.get(at)!) {
      const a = points[at]!,
        b = points[next]!;
      const distance = distances[at]! + Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      if (distance < distances[next]!) {
        distances[next] = distance;
        previous.set(next, at);
      }
    }
  }
  const path: Point[] = [];
  for (let at: number | undefined = last; at !== undefined; at = previous.get(at))
    path.unshift(points[at]!);
  if (!from && !origin) path.unshift([7, 0]);
  if (!to) path.push([7, 0]);
  return path.filter((p, i) => i === 0 || p[0] !== path[i - 1]![0] || p[1] !== path[i - 1]![1]);
}
export function routeToLobby(site: RoomSite): ReadonlyArray<Point> {
  return routeBetweenSites(site, null);
}

export interface Obstacle {
  readonly min: Point;
  readonly max: Point;
}
function intersects(point: Point, box: Obstacle, radius = 0.95): boolean {
  return (
    point[0] > box.min[0] - radius &&
    point[0] < box.max[0] + radius &&
    point[1] > box.min[1] - radius &&
    point[1] < box.max[1] + radius
  );
}
export function findPath(
  start: Point,
  end: Point,
  obstacles: ReadonlyArray<Obstacle>,
  bounds: readonly [number, number, number, number],
  radius: number | { side: number; back: number; front: number } = 0.95,
): ReadonlyArray<Point> | null {
  const step = 0.25,
    key = (x: number, z: number) => `${x},${z}`,
    cell = (p: Point) => [Math.round(p[0] / step), Math.round(p[1] / step)] as const;
  const source = cell(start),
    target = cell(end),
    goal = key(...target),
    first = key(...source);
  const queue = [source],
    prior = new Map<string, string | null>([[first, null]]),
    cells = new Map<string, Point>([[first, start]]);
  for (let index = 0; index < queue.length; index++) {
    const at = queue[index]!,
      atKey = key(...at);
    if (atKey === goal) {
      const result: Point[] = [end];
      let k: string | null = atKey;
      while (k !== null) {
        result.push(cells.get(k)!);
        k = prior.get(k) ?? null;
      }
      return result.reverse();
    }
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]) {
      const next = [at[0] + dx!, at[1] + dz!] as const,
        k = key(...next),
        p = [next[0] * step, next[1] * step] as const;
      if (
        prior.has(k) ||
        p[0] < bounds[0] ||
        p[0] > bounds[2] ||
        p[1] < bounds[1] ||
        p[1] > bounds[3] ||
        obstacles.some((box) => {
          if (typeof radius === "number") return intersects(p, box, radius);
          const offset: Obstacle =
            dx === 1
              ? { min: [-radius.back, -radius.side], max: [radius.front, radius.side] }
              : dx === -1
                ? { min: [-radius.front, -radius.side], max: [radius.back, radius.side] }
                : dz === 1
                  ? { min: [-radius.side, -radius.back], max: [radius.side, radius.front] }
                  : { min: [-radius.side, -radius.front], max: [radius.side, radius.back] };
          const source = [at[0] * step, at[1] * step] as Point;
          return [source, p].some(
            (point) =>
              point[0] + offset.min[0] < box.max[0] &&
              point[0] + offset.max[0] > box.min[0] &&
              point[1] + offset.min[1] < box.max[1] &&
              point[1] + offset.max[1] > box.min[1],
          );
        })
      )
        continue;
      prior.set(k, atKey);
      cells.set(k, p);
      queue.push(next);
    }
  }
  return null;
}
