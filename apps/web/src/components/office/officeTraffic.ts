import type { Vector3 } from "three";
import type { Obstacle } from "./officeLayout";

export class SpatialIndex<T> {
  private readonly cells = new Map<string, Set<T>>();
  private readonly entries = new Map<T, string[]>();
  private *keys(box: Obstacle) {
    for (let x = Math.floor(box.min[0] / 8); x <= Math.floor(box.max[0] / 8); x++)
      for (let z = Math.floor(box.min[1] / 8); z <= Math.floor(box.max[1] / 8); z++)
        yield `${x}:${z}`;
  }
  set(value: T, box: Obstacle) {
    this.delete(value);
    const keys = [...this.keys(box)];
    this.entries.set(value, keys);
    for (const key of keys) {
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, (cell = new Set()));
      cell.add(value);
    }
  }
  delete(value: T) {
    for (const key of this.entries.get(value) ?? []) {
      const cell = this.cells.get(key)!;
      cell.delete(value);
      if (cell.size === 0) this.cells.delete(key);
    }
    this.entries.delete(value);
  }
  query(box: Obstacle) {
    const result = new Set<T>();
    for (const key of this.keys(box))
      for (const value of this.cells.get(key) ?? []) result.add(value);
    return result;
  }
  clear() {
    this.cells.clear();
    this.entries.clear();
  }
}
export function overlaps(a: Obstacle, b: Obstacle) {
  return a.min[0] < b.max[0] && a.max[0] > b.min[0] && a.min[1] < b.max[1] && a.max[1] > b.min[1];
}
interface Segment {
  readonly owner: string;
  readonly order: number;
  readonly box: Obstacle;
  readonly start: Vector3;
  readonly end: Vector3;
  readonly direction: number;
  previous?: Segment | undefined;
  next?: Segment | undefined;
}
function compatible(a: Segment, b: Segment) {
  if (a.direction === 4 || b.direction === 4) return false;
  if (a.direction === b.direction) return true;
  if (Math.abs(a.direction - b.direction) === 2)
    return a.start.distanceToSquared(b.start) < 0.000001;
  // Convoys can merge and round a shared bend; crossing and opposing routes still drain first.
  return (
    [a.previous, a.next].some(
      (near) => near?.direction === b.direction && overlaps(near.box, b.box),
    ) ||
    [b.previous, b.next].some(
      (near) => near?.direction === a.direction && overlaps(near.box, a.box),
    )
  );
}
export function compactRoute(start: Vector3, points: readonly Vector3[]) {
  const result = [start, ...points].filter(
    (point, i, all) => i === 0 || point.distanceToSquared(all[i - 1]!) > 0.000001,
  );
  for (let i = result.length - 2; i > 0; i--) {
    const a = result[i - 1]!,
      b = result[i]!,
      c = result[i + 1]!;
    const ab = b.clone().sub(a),
      bc = c.clone().sub(b);
    if (ab.dot(bc) > 0 && ab.clone().cross(bc).lengthSq() < 0.000001) result.splice(i, 1);
  }
  return result.slice(1);
}
export class CorridorTraffic {
  private readonly index = new SpatialIndex<Segment>();
  private readonly windows = new SpatialIndex<{ key: string; box: Obstacle }>();
  private readonly windowByKey = new Map<string, { key: string; box: Obstacle }>();
  private readonly plans = new Map<
    string,
    { segments: Segment[]; active: boolean; zone: Segment | null }
  >();
  private readonly tickets = new Map<string, number>();
  private sequence = 0;
  private cursor = 0;
  private readonly attempts = new Set<string>();
  beginFrame() {
    const waiting = [...this.plans].filter(([, plan]) => !plan.active);
    this.attempts.clear();
    for (let i = 0; i < Math.min(8, waiting.length); i++)
      this.attempts.add(waiting[(this.cursor + i) % waiting.length]![0]);
    this.cursor = waiting.length ? (this.cursor + 8) % waiting.length : 0;
  }
  plan(
    key: string,
    start: Vector3,
    route: readonly Vector3[],
    interactive = false,
    useBox?: Obstacle,
  ) {
    const previous = this.tickets.get(key);
    let order = previous ?? ++this.sequence;
    // Visits follow the oldest waiter, so they respond promptly without starving existing traffic.
    if (interactive && previous === undefined) {
      let oldest = Infinity;
      for (const plan of this.plans.values())
        if (!plan.active) oldest = Math.min(oldest, plan.segments[0]?.order ?? Infinity);
      if (Number.isFinite(oldest)) order = oldest + 0.5;
    }
    this.remove(key, true);
    this.tickets.set(key, order);
    const segments = route.map((end, i): Segment => {
      const from = i === 0 ? start : route[i - 1]!;
      const dx = end.x - from.x,
        dz = end.z - from.z;
      const horizontal = Math.abs(dx) > Math.abs(dz);
      return {
        owner: key,
        order,
        start: from.clone(),
        end,
        direction: horizontal ? (dx > 0 ? 0 : 2) : dz > 0 ? 1 : 3,
        box: {
          min: [Math.min(from.x, end.x) - 1.55, Math.min(from.z, end.z) - 1.55],
          max: [Math.max(from.x, end.x) + 1.55, Math.max(from.z, end.z) + 1.55],
        },
      };
    });
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      segment.previous = segments[i - 1];
      segment.next = segments[i + 1];
      this.index.set(segment, segment.box);
    }
    const end = route.at(-1)!;
    const zone: Segment | null = useBox
      ? { owner: key, order, start: end, end, direction: 4, box: useBox }
      : null;
    if (zone) this.index.set(zone, zone.box);
    this.plans.set(key, { segments, active: false, zone });
  }
  active(key: string) {
    return this.plans.get(key)?.active ?? false;
  }
  canMove(key: string, position: Vector3, route: readonly Vector3[]) {
    let left = 4;
    let at = position;
    const min = [at.x, at.z],
      max = [at.x, at.z];
    for (const end of route) {
      const length = at.distanceTo(end);
      const next = length > left ? at.clone().lerp(end, left / length) : end;
      min[0] = Math.min(min[0]!, next.x);
      min[1] = Math.min(min[1]!, next.z);
      max[0] = Math.max(max[0]!, next.x);
      max[1] = Math.max(max[1]!, next.z);
      left -= length;
      at = next;
      if (left <= 0) break;
    }
    const box: Obstacle = {
      min: [min[0]! - 1.65, min[1]! - 1.65],
      max: [max[0]! + 1.65, max[1]! + 1.65],
    };
    const blocked = [...this.windows.query(box)].some(
      (other) => other.key !== key && overlaps(box, other.box),
    );
    this.setWindow(
      key,
      blocked
        ? {
            min: [position.x - 1.65, position.z - 1.65],
            max: [position.x + 1.65, position.z + 1.65],
          }
        : box,
    );
    return !blocked;
  }
  private setWindow(key: string, box: Obstacle) {
    const old = this.windowByKey.get(key);
    if (old) this.windows.delete(old);
    const window = { key, box };
    this.windowByKey.set(key, window);
    this.windows.set(window, box);
  }
  claim(key: string, occupied: (start: Vector3, end: Vector3) => boolean) {
    const plan = this.plans.get(key);
    if (!plan) return false;
    if (plan.active) return true;
    if (!this.attempts.delete(key)) return false;
    for (const segment of plan.zone ? [...plan.segments, plan.zone] : plan.segments) {
      for (const other of this.index.query(segment.box)) {
        if (other.owner === key || !overlaps(segment.box, other.box)) continue;
        if (
          (other.order < segment.order || this.active(other.owner)) &&
          !compatible(segment, other)
        )
          return false;
      }
      if (occupied(segment.start, segment.end)) return false;
    }
    plan.active = true;
    return true;
  }
  advance(key: string, position: Vector3, remaining: readonly Vector3[]) {
    const plan = this.plans.get(key);
    if (!plan?.active) return;
    if (!remaining.length) {
      this.remove(key);
      return;
    }
    while (
      plan.segments.length > remaining.length &&
      position.distanceTo(plan.segments[0]!.end) > 3.2
    ) {
      this.index.delete(plan.segments.shift()!);
    }
  }
  busy(box: Obstacle, key: string) {
    return [...this.index.query(box)].some(
      (segment) =>
        segment.owner !== key && this.active(segment.owner) && overlaps(segment.box, box),
    );
  }
  remove(key: string, keepTicket = false) {
    if (!keepTicket) this.tickets.delete(key);
    const window = this.windowByKey.get(key);
    if (window) this.windows.delete(window);
    this.windowByKey.delete(key);
    const plan = this.plans.get(key);
    if (!plan) return;
    for (const segment of plan.segments) this.index.delete(segment);
    if (plan.zone) this.index.delete(plan.zone);
    this.plans.delete(key);
  }
  clear() {
    this.index.clear();
    this.windows.clear();
    this.windowByKey.clear();
    this.plans.clear();
    this.tickets.clear();
    this.attempts.clear();
    this.cursor = 0;
    this.sequence = 0;
  }
}
