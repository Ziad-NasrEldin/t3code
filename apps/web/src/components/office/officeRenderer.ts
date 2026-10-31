import {
  AnimationClip,
  AnimationMixer,
  Group,
  Mesh,
  Object3D,
  OrthographicCamera,
  Vector3,
  LoopRepeat,
  type Camera,
} from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { RootState } from "@react-three/fiber";
import { createSurfaceDust, makeLifecycleMaterials } from "./officeEffects";
import { DECK_HEIGHT } from "./officeLayout";
import type { VisualActor, OfficeFocus } from "./OfficeScene";
import type { OfficeStatus } from "@t3tools/client-runtime/state/office";
import type { Life } from "./officeMotion";
export const OFFICE_COLORS = {
  floor: 0xbbc6bb,
  lift: 0x66b8be,
  lamp: 0xffcf82,
  selection: 0x79e0e5,
  key: 0xffe1ba,
  fill: 0xc4eaff,
  ground: 0x455c61,
};
export function createActorInstance(asset: GLTF) {
  const root = clone(asset.scene);
  return {
    root,
    mixer: new AnimationMixer(root),
    materials: makeLifecycleMaterials(root),
    elapsed: 0,
    lifecycleNotified: false,
    lastClip: "",
    lastStatus: null as OfficeStatus | null,
    sleepTransition: 0,
    wakeTransition: 0,
    dust: null as ReturnType<typeof createSurfaceDust> | null,
  };
}
export function resetActorLifecycle(
  instance: ReturnType<typeof createActorInstance>,
  transition: VisualActor["transition"],
) {
  instance.elapsed = 0;
  instance.lifecycleNotified = false;
  if (transition !== "departing") {
    instance.dust?.points.removeFromParent();
    instance.dust?.dispose();
    instance.dust = null;
  }
}
export function advanceActorFrame(
  instance: ReturnType<typeof createActorInstance>,
  asset: GLTF,
  state: RootState,
  dt: number,
  group: Group | null,
  ring: Mesh | null,
  visual: VisualActor,
  life: Life,
  selected: boolean,
  labels: Map<string, HTMLElement>,
  reduced: boolean,
  motion: import("./officeMotion").OfficeMotion,
) {
  dt = Math.min(dt, 0.05);
  const active = life.activityStatus ?? visual.actor.status;
  if (instance.lastStatus !== active) {
    if (instance.lastStatus !== null && active === "sleeping" && !reduced)
      instance.sleepTransition = 3;
    if (instance.lastStatus === "sleeping" && active !== "sleeping" && !reduced)
      instance.wakeTransition = 2.5;
    instance.lastStatus = active;
  }
  instance.sleepTransition = Math.max(0, instance.sleepTransition - dt);
  instance.wakeTransition = Math.max(0, instance.wakeTransition - dt);

  const root = group;
  if (!root) return;
  const using = life.performance !== null && life.performanceReady;
  instance.root.visible = !using;
  if (using) {
    instance.elapsed = 0;
  } else instance.elapsed += dt;
  root.position.copy(life.position);
  root.rotation.y = life.heading;
  const clipName =
    life.route.length > 0
      ? "Walk"
      : instance.wakeTransition > 0
        ? "Wake"
        : instance.sleepTransition > 0
          ? "LieDown"
          : active === "sleeping"
            ? "Sleep"
            : active === "waiting"
              ? "Attention"
              : active === "thinking"
                ? "Thinking"
                : active === "working" || active === "streaming" || active === "starting"
                  ? "Working"
                  : "Idle";
  if (clipName !== instance.lastClip) {
    const clip =
      asset.animations.find((clip) => clip.name === clipName) ??
      asset.animations.find((clip) => clip.name === "Idle");
    if (clip) {
      instance.mixer.stopAllAction();
      const action = instance.mixer.clipAction(clip);
      action.reset().setLoop(LoopRepeat, Infinity).play();
    }
    instance.lastClip = clipName;
  }
  if (
    !using &&
    !reduced &&
    (life.route.length > 0 ||
      active === "working" ||
      active === "streaming" ||
      active === "thinking" ||
      active === "waiting" ||
      instance.sleepTransition > 0 ||
      instance.wakeTransition > 0 ||
      instance.elapsed < 2)
  )
    instance.mixer.update(dt);
  else if (reduced) instance.mixer.setTime(active === "sleeping" ? 0.2 : 0);
  instance.materials.uniforms.uOfficeBase.value.copy(life.position);
  instance.materials.uniforms.uOfficeReveal.value =
    visual.transition === "arriving" && !reduced ? Math.min(1, instance.elapsed / 0.85) : 1;
  instance.materials.uniforms.uOfficeDust.value =
    visual.transition === "departing" && !using
      ? reduced
        ? 1
        : Math.min(1, instance.elapsed / 1.2)
      : 0;
  if (visual.transition === "departing" && !using && !reduced) {
    if (!instance.dust) {
      instance.dust = createSurfaceDust(instance.root);
      root.add(instance.dust.points);
    }
    instance.dust.update(instance.elapsed);
  }
  if (ring) {
    ring.visible = selected || visual.transition === "arriving";
    ring.scale.setScalar(1 + Math.sin(instance.elapsed * 8) * 0.04);
  }
  if (
    visual.transition !== "none" &&
    !using &&
    !instance.lifecycleNotified &&
    (reduced || instance.elapsed >= (visual.transition === "arriving" ? 0.85 : 1.3))
  ) {
    instance.lifecycleNotified = true;
    motion.finishLifecycle(life.key, visual.transition);
  }
  const label = labels.get(life.key);
  if (label) {
    const p = life.position
      .clone()
      .add(new Vector3(0, visual.actor.child ? 3.5 : 4.3, 0))
      .project(state.camera);
    const shown = Math.abs(p.x) < 1.15 && Math.abs(p.y) < 1.15 && Math.abs(p.z) < 1;
    label.hidden = !shown;
    label.style.transform = `translate(${((p.x + 1) * state.size.width) / 2}px,${((1 - p.y) * state.size.height) / 2}px) translate(-50%,-100%)`;
  }
}
export function connectOfficeControls(controls: OrbitControls, invalidate: () => void) {
  controls.enableRotate = false;
  controls.enableDamping = false;
  controls.minZoom = 0.35;
  controls.maxZoom = 5;
  controls.addEventListener("change", invalidate);
  return () => {
    controls.removeEventListener("change", invalidate);
    controls.dispose();
  };
}
export function focusOfficeCamera(
  camera: Camera,
  controls: OrbitControls,
  focus: OfficeFocus,
  size: { width: number; height: number },
  invalidate: () => void,
) {
  const y = focus.deck * DECK_HEIGHT;
  controls.target.set(focus.x, y + 1, focus.z);
  camera.position.set(focus.x + 25, y + 49, focus.z + 40);
  camera.lookAt(controls.target);
  if (camera instanceof OrthographicCamera) {
    const span = Math.max(focus.span, (focus.span * 0.75 * size.width) / size.height);
    camera.left = -span / 2;
    camera.right = span / 2;
    camera.top = (span * size.height) / size.width / 2;
    camera.bottom = -camera.top;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
  }
  controls.update();
  invalidate();
}
export function markPerformanceReady(life: Life) {
  life.performanceReady = true;
}
const loadedAssets = new Set<GLTF>();
export function rememberOfficeAsset(asset: GLTF) {
  loadedAssets.add(asset);
}
export function disposeOfficeAssets() {
  const geometries = new Set<import("three").BufferGeometry>(),
    materials = new Set<import("three").Material>();
  for (const asset of loadedAssets)
    asset.scene.traverse((object) => {
      if (object instanceof Mesh) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          materials.add(material);
      }
    });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  loadedAssets.clear();
}
export function createFurnitureInstance(asset: GLTF) {
  const root = clone(asset.scene),
    materials: import("three").Material[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh && /bulb|brew_button|inset_board/.test(object.name)) {
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => material.clone())
        : object.material.clone();
      materials.push(...(Array.isArray(object.material) ? object.material : [object.material]));
    }
  });
  return { root, dispose: () => materials.forEach((material) => material.dispose()) };
}
export function updateFurniture(
  root: Object3D,
  lamp: boolean,
  coffeeTime: number | null,
  gameTime: number | null,
) {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    if (object.name.includes("bulb") && object.name.includes("reading_lamp")) {
      const material = object.material;
      if (!Array.isArray(material) && "emissive" in material)
        (material as import("three").MeshStandardMaterial).emissive.set(lamp ? 0xffc270 : 0);
    }
    if (object.name.includes("brew_button")) {
      const material = object.material;
      if (!Array.isArray(material) && "emissive" in material)
        (material as import("three").MeshStandardMaterial).emissive.set(
          coffeeTime !== null && coffeeTime > 2.5 && coffeeTime < 4.2 ? 0xffb84a : 0x377e78,
        );
    }
    if (object.name.includes("inset_board")) {
      const material = object.material;
      if (!Array.isArray(material) && "emissive" in material)
        (material as import("three").MeshStandardMaterial).emissive.set(
          gameTime !== null && gameTime > 6.3 && gameTime < 8.3 ? 0x469e89 : 0,
        );
    }
  });
}
export function updateCupHome(root: Object3D, using: boolean) {
  root.visible = !using;
}
export function advancePerformance(
  root: Object3D,
  mixer: AnimationMixer,
  performer: Object3D | undefined,
  wrapper: Group | null,
  life: Life,
) {
  root.visible = life.performance !== null;
  if (!root.visible) return;
  mixer.setTime(life.performanceTime);
  if (wrapper && performer) {
    wrapper.updateWorldMatrix(true, true);
    performer.getWorldPosition(life.position);
  }
}
export function createPerformanceInstance(
  asset: GLTF,
  character: GLTF,
  name: import("./officeMotion").Amenity,
) {
  const root = clone(character.scene),
    motion = clone(asset.scene),
    source = motion.children.find((object) => object.name.toLowerCase().includes("performer")),
    performer = root.children[0];
  if (performer && source) {
    performer.name = source.name;
    performer.position.copy(source.position);
    performer.quaternion.copy(source.quaternion);
    performer.scale.copy(source.scale);
  }
  root.traverse((object) => {
    if (object instanceof Mesh && object.name.toLowerCase().includes("tablet"))
      object.visible = false;
  });
  const props = motion.children.slice();
  for (const child of props) if (child !== source) root.add(child);
  const mixer = new AnimationMixer(root),
    clip = new AnimationClip(
      name,
      name === "sofa" ? 18 : 12,
      asset.animations.flatMap((animation) => animation.tracks),
    );
  mixer.clipAction(clip).play();
  mixer.setTime(0);
  return { root, mixer, performer };
}
