import { describe, expect, it } from "vite-plus/test";
import {
  allocateStable,
  ringSize,
  ringSites,
  siteAt,
  routeToLobby,
  routeBetweenSites,
  ringLinks,
} from "./officeLayout";
describe("stable concentric offices", () => {
  it("keeps occupied sites, reuses vacancies and extends through further rings", () => {
    const keys = Array.from({ length: 150 }, (_, i) => `project-${i}`),
      original = allocateStable({}, keys);
    const survivors = keys.filter((_, i) => i !== 1 && i !== 25),
      next = allocateStable(original, [...survivors, "replacement-a", "replacement-b"]);
    for (const key of survivors) expect(next[key]).toBe(original[key]);
    expect(next["replacement-a"]).toBe(1);
    expect(next["replacement-b"]).toBe(25);
    expect(siteAt(4).ring).toBe(1);
    expect(siteAt(149).ring).toBeGreaterThan(2);
  });
  it("reserves complete inner room footprints and corner links before growing", () => {
    expect(ringSize(0)[1] - 1.4056196632323068).toBeGreaterThan(6.650000095367432);
    for (let ring = 1; ring < 5; ring++) {
      expect(ringLinks(ring)).toHaveLength(8);
      const inner = ringSize(ring - 1),
        outer = ringSize(ring);
      expect(outer[0] - 1.5).toBeGreaterThan(inner[0] + 14);
      expect(outer[1] - 1.5).toBeGreaterThan(inner[1] + 14);
      for (const site of ringSites(ring - 1)) {
        const horizontalCrosses =
          Math.abs(site.z - inner[1]) < 7.5 && site.x + 6 > inner[0] && site.x - 6 < outer[0];
        expect(horizontalCrosses).toBe(false);
      }
    }
  });
  it("never routes through a project room, including when inner rooms are removed", () => {
    // The reverse local journey on a clear north side used to circle the ring.
    expect(routeBetweenSites(siteAt(6), siteAt(4))).toEqual([
      [0, -26.5],
      [-9.5, -26.5],
      [-14, -26.5],
    ]);
    for (const id of [0, 1, 2, 3, 4, 15, 80]) {
      const site = siteAt(id),
        route = routeToLobby(site);
      expect(route.at(-1)).toEqual([7, 0]);
      expect(route[0]).not.toEqual([site.x, site.z]);
      for (const p of route) expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
      for (let i = 1; i < route.length; i++)
        expect(route[i]![0] === route[i - 1]![0] || route[i]![1] === route[i - 1]![1]).toBe(true);
    }
  });
});
