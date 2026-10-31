import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { OfficeScene } from "./OfficeScene";
import { OfficeMotion } from "./officeMotion";

it("releases document camera listeners when graphics recover and the office exits", async () => {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  using _add = vi
    .spyOn(document, "addEventListener")
    .mockImplementation((type, listener, options) => {
      if (
        type === "keydown" &&
        typeof listener === "function" &&
        listener.name === "bound interceptControlDown"
      )
        listeners.add(listener);
      add(type, listener, options);
    });
  using _remove = vi
    .spyOn(document, "removeEventListener")
    .mockImplementation((type, listener, options) => {
      if (type === "keydown") listeners.delete(listener);
      remove(type, listener, options);
    });
  const motion = new OfficeMotion();
  const scene = () => (
    <div style={{ width: 640, height: 480 }}>
      <OfficeScene
        actors={[]}
        rooms={[]}
        slots={{}}
        rests={{}}
        motion={motion}
        focus={{ x: 0, z: 0, span: 32, serial: 0 }}
        selected={null}
        onSelect={() => {}}
        labels={new Map()}
        visible
        reduced
        lowQuality
        lamp={false}
        onAmenity={() => {}}
        onMetrics={() => {}}
        onVisible={() => {}}
      />
    </div>
  );
  await using screen = await render(scene(), { router: false }); // The renderer has no navigation dependencies.
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  for (let cycle = 0; cycle < 3; cycle++) {
    const previous = [...listeners][0]!;
    const canvas = screen.container.querySelector("canvas")!;
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    await expect.element(screen.getByRole("button", { name: "Restore graphics" })).toBeVisible();
    await screen.getByRole("button", { name: "Restore graphics" }).click();
    await vi.waitFor(() => {
      expect(screen.container.querySelector("canvas")).not.toBe(canvas);
      expect(listeners.size).toBe(1);
      expect(listeners.has(previous)).toBe(false);
    });
  }
  await screen.unmount();
  expect(listeners.size).toBe(0);
});
