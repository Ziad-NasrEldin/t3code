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
interface Passage {
  owner: string;
  start: Vector3;
  end: Vector3;
  begin: number;
  finish: number;
  box: Obstacle;
  radius: readonly [number, number];
}
// Project the overlapping swept bodies onto departure time, rather than locking a whole journey.
function conflict(a: Passage, b: Passage): readonly [number, number] | null {
  if (b.start.equals(b.end)) {
    let enter = a.begin,
      leave = a.finish;
    for (const axis of ["x", "z"] as const) {
      const velocity = (a.end[axis] - a.start[axis]) / (a.finish - a.begin);
      const radius = a.radius[axis === "x" ? 0 : 1] + b.radius[axis === "x" ? 0 : 1];
      if (Math.abs(velocity) < 1e-9) {
        if (Math.abs(a.start[axis] - b.start[axis]) >= radius) return null;
      } else {
        const times = [
          (b.start[axis] - radius - a.start[axis]) / velocity + a.begin,
          (b.start[axis] + radius - a.start[axis]) / velocity + a.begin,
        ].sort((x, y) => x - y);
        enter = Math.max(enter, times[0]!);
        leave = Math.min(leave, times[1]!);
      }
    }
    return enter <= leave ? [b.begin - leave - 0.25, b.finish - enter + 0.25] : null;
  }
  if (a.start.equals(a.end)) {
    const reverse = conflict(b, a);
    return reverse ? [-reverse[1], -reverse[0]] : null;
  }
  const av = a.end
    .clone()
    .sub(a.start)
    .divideScalar(a.finish - a.begin);
  const bv = b.end
    .clone()
    .sub(b.start)
    .divideScalar(b.finish - b.begin);
  let polygon = [
    [b.begin, b.begin - a.finish],
    [b.finish, b.begin - a.finish],
    [b.finish, b.finish - a.begin],
    [b.begin, b.finish - a.begin],
  ];
  const clip = (x: number, y: number, limit: number) => {
    const result: number[][] = [];
    for (let i = 0; i < polygon.length; i++) {
      const first = polygon[i]!,
        last = polygon[(i + 1) % polygon.length]!;
      const f = first[0]! * x + first[1]! * y - limit;
      const l = last[0]! * x + last[1]! * y - limit;
      if (f <= 0) result.push(first);
      if ((f < 0 && l > 0) || (f > 0 && l < 0)) {
        const t = f / (f - l);
        result.push([
          first[0]! + t * (last[0]! - first[0]!),
          first[1]! + t * (last[1]! - first[1]!),
        ]);
      }
    }
    polygon = result;
  };
  clip(-1, 1, -a.begin);
  clip(1, -1, a.finish);
  for (const axis of ["x", "z"] as const) {
    const constant = a.start[axis] - av[axis] * a.begin - b.start[axis] + bv[axis] * b.begin;
    clip(
      av[axis] - bv[axis],
      -av[axis],
      a.radius[axis === "x" ? 0 : 1] + b.radius[axis === "x" ? 0 : 1] - constant,
    );
    clip(
      bv[axis] - av[axis],
      av[axis],
      a.radius[axis === "x" ? 0 : 1] + b.radius[axis === "x" ? 0 : 1] + constant,
    );
  }
  return polygon.length
    ? [Math.min(...polygon.map((p) => p[1]!)) - 0.25, Math.max(...polygon.map((p) => p[1]!)) + 0.25]
    : null;
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
interface Plan {
  segments: Passage[];
  departure: number | null;
  order: number;
  shape?: TravelShape | undefined;
  zone?: Obstacle | undefined;
  reservations: Passage[];
}
interface TravelShape {
  side: number;
  front: number;
  source: Obstacle;
  target: Obstacle;
}
function stationary(
  owner: string,
  at: Vector3,
  begin: number,
  finish: number,
  box?: Obstacle,
): Passage {
  const bounds = box ?? { min: [at.x - 1.5, at.z - 1.5], max: [at.x + 1.5, at.z + 1.5] };
  const center = at
    .clone()
    .set((bounds.min[0] + bounds.max[0]) / 2, 0.07, (bounds.min[1] + bounds.max[1]) / 2);
  return {
    owner,
    start: center,
    end: center,
    begin,
    finish,
    radius: [(bounds.max[0] - bounds.min[0]) / 2, (bounds.max[1] - bounds.min[1]) / 2],
    box: bounds,
  };
}
export class CorridorTraffic {
  private readonly index = new SpatialIndex<Passage>();
  private readonly plans = new Map<string, Plan>();
  private readonly parked = new Map<string, Passage>();
  private sequence = 0;
  private now = 0;
  private delta = 0.1;
  private cursor = 0;
  private budget = 2000;
  private preparing: {
    key: string;
    scan: Generator<void, (readonly [number, number])[] | null>;
  } | null = null;
  private readonly attempts = new Set<string>();
  beginFrame(delta = 0.1) {
    this.now += this.delta;
    this.delta = delta;
    this.budget = 2000;
    const waiting = [...this.plans]
      .filter(([, plan]) => plan.departure === null)
      .sort((a, b) => a[1].order - b[1].order);
    this.attempts.clear();
    for (let i = 0; i < Math.min(8, waiting.length); i++)
      this.attempts.add(waiting[(this.cursor + i) % waiting.length]![0]);
    this.cursor = waiting.length ? (this.cursor + 8) % waiting.length : 0;
  }
  plan(
    key: string,
    start: Vector3,
    route: readonly Vector3[],
    _interactive = false,
    useBox?: Obstacle,
    shape?: TravelShape,
  ) {
    const order = this.plans.get(key)?.order ?? ++this.sequence;
    this.remove(key);
    let begin = 0;
    const segments = route
      .map((end, i): Passage => {
        const from = i ? route[i - 1]! : start;
        const finish = begin + from.distanceTo(end) / 0.9;
        const horizontal = Math.abs(end.x - from.x) > Math.abs(end.z - from.z);
        const radius: readonly [number, number] = shape
          ? horizontal
            ? [shape.front, shape.side]
            : [shape.side, shape.front]
          : [1.5, 1.5];
        const passage = {
          owner: key,
          radius,
          start: from.clone(),
          end: end.clone(),
          begin,
          finish,
          box: {
            min: [
              Math.min(from.x, end.x) - radius[0],
              Math.min(from.z, end.z) - radius[1],
            ] as const,
            max: [
              Math.max(from.x, end.x) + radius[0],
              Math.max(from.z, end.z) + radius[1],
            ] as const,
          },
        };
        begin = finish;
        return passage;
      })
      .filter((s) => s.finish > s.begin);
    this.plans.set(key, {
      segments,
      departure: null,
      order,
      zone: useBox,
      shape,
      reservations: [],
    });
  }
  active(key: string) {
    const departure = this.plans.get(key)?.departure;
    return departure !== null && departure !== undefined && departure <= this.now;
  }
  reserved(key: string) {
    return this.plans.get(key)?.departure !== null && this.plans.has(key);
  }
  claim(key: string, occupied: (start: Vector3, end: Vector3) => boolean) {
    const plan = this.plans.get(key);
    if (!plan) return false;
    if (plan.departure !== null) return plan.departure <= this.now;
    if (!this.attempts.delete(key) && this.preparing?.key !== key) return false;
    if (this.preparing && this.preparing.key !== key) return false;
    this.preparing ??= { key, scan: this.scan(key, plan, occupied) };
    let result: IteratorResult<void, (readonly [number, number])[] | null> | undefined;
    while (this.budget-- > 0) {
      result = this.preparing.scan.next();
      if (result.done) break;
    }
    if (!result?.done) {
      this.attempts.add(key);
      return false;
    }
    this.preparing = null;
    const intervals = result.value;
    if (!intervals) return false;
    intervals.sort((a, b) => a[0] - b[0]);
    let departure = this.now;
    for (const [begin, finish] of intervals)
      if (departure >= begin && departure <= finish) departure = finish + 0.001;
    if (!Number.isFinite(departure)) return false;
    // Waiting has physical capacity only at the current berth; never reserve a later start in a through aisle.

    const source = plan.segments[0]?.start;
    if (source && departure > this.now) {
      const hold = stationary(key, source, this.now, departure, plan.shape?.source);
      for (const other of this.index.query(hold.box)) {
        const interval = conflict(hold, other);
        if (interval && interval[0] <= 0 && interval[1] >= 0) return false;
      }
    }
    const last = plan.segments.at(-1);
    if (last) {
      const end = stationary(key, last.end, departure + last.finish, Infinity, plan.shape?.target);
      for (const other of this.index.query(end.box)) {
        if (other.owner === key) continue;
        const interval = conflict(end, other);
        if (interval && interval[0] <= 0 && interval[1] >= 0) return false;
      }
    }
    plan.departure = departure;
    for (const segment of plan.segments) {
      segment.begin += departure;
      segment.finish += departure;
      this.index.set(segment, segment.box);
      plan.reservations.push(segment);
    }
    if (source && departure > this.now)
      plan.reservations.push(stationary(key, source, this.now, departure, plan.shape?.source));
    if (last)
      plan.reservations.push(stationary(key, last.end, last.finish, Infinity, plan.shape?.target));
    if (plan.zone) {
      const box = plan.zone;
      const center = plan.segments
        .at(-1)!
        .end.clone()
        .set((box.min[0] + box.max[0]) / 2, 0.07, (box.min[1] + box.max[1]) / 2);
      plan.reservations.push(stationary(key, center, this.now, Infinity, box));
    }
    for (const reservation of plan.reservations) this.index.set(reservation, reservation.box);
    return departure <= this.now;
  }
  private *scan(
    key: string,
    plan: Plan,
    occupied: (start: Vector3, end: Vector3) => boolean,
  ): Generator<void, (readonly [number, number])[] | null> {
    const intervals: (readonly [number, number])[] = [];
    for (const segment of plan.segments) {
      if (occupied(segment.start, segment.end)) return null;
      yield;
      for (const other of this.index.query(segment.box)) {
        yield;
        if (
          other.owner === key ||
          other.finish < this.now - 0.25 ||
          !overlaps(segment.box, other.box)
        )
          continue;
        const interval = conflict(segment, other);
        if (interval) intervals.push(interval);
      }
    }
    return intervals;
  }
  redirect(
    key: string,
    start: Vector3,
    route: readonly Vector3[],
    occupied: (start: Vector3, end: Vector3) => boolean,
    shape?: TravelShape,
  ) {
    const previous = this.plans.get(key);
    if (!previous) return false;
    if (this.preparing) return false;
    this.plan(key, start, route, false, previous.zone, shape ?? previous.shape);
    this.attempts.add(key);
    const claimed = this.claim(key, occupied);
    if (claimed) return true;
    this.remove(key);
    this.plans.set(key, previous);
    for (const reservation of previous.reservations) this.index.set(reservation, reservation.box);
    return false;
  }
  arrive(key: string) {
    const plan = this.plans.get(key);
    const last = plan?.segments.at(-1);
    const end = last ? stationary(key, last.end, this.now, Infinity, plan!.shape?.target) : null;
    this.remove(key);
    if (end) {
      this.parked.set(key, end);
      this.index.set(end, end.box);
    }
  }
  busy(box: Obstacle, key: string) {
    return [...this.index.query(box)].some(
      (segment) =>
        segment.owner !== key && segment.finish >= this.now && overlaps(segment.box, box),
    );
  }
  remove(key: string, _keepTicket = false) {
    if (this.preparing?.key === key) this.preparing = null;
    const plan = this.plans.get(key);
    if (plan) for (const segment of plan.reservations) this.index.delete(segment);
    const parked = this.parked.get(key);
    if (parked) this.index.delete(parked);
    this.parked.delete(key);
    this.plans.delete(key);
  }
  clear() {
    this.index.clear();
    this.plans.clear();
    this.parked.clear();
    this.attempts.clear();
    this.cursor = 0;
    this.sequence = 0;
    this.now = 0;
    this.preparing = null;
  }
}
