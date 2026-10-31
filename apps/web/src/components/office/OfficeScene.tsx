import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Group, Mesh, Object3D, Vector3, ACESFilmicToneMapping, SRGBColorSpace } from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type OfficeActor } from "@t3tools/client-runtime/state/office";
import {
  DECK_HEIGHT,
  ringSize,
  roomRotation,
  type RoomSite,
  type RoomVariant,
} from "./officeLayout";
import { OfficeMotion, PERFORMANCES, type Amenity, type Life } from "./officeMotion";
import {
  OFFICE_COLORS,
  createActorInstance,
  resetActorLifecycle,
  advanceActorFrame,
  connectOfficeControls,
  focusOfficeCamera,
  markPerformanceReady,
  rememberOfficeAsset,
  disposeOfficeAssets,
  createFurnitureInstance,
  updateFurniture,
  updateCupHome,
  advancePerformance,
  createPerformanceInstance,
} from "./officeRenderer";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";

const BASE = `${import.meta.env.BASE_URL}office/`;
const ASSETS = [
  "main",
  "child",
  "atlas",
  "grove",
  "prism",
  "lobby",
  "props",
  "coffee",
  "sofa",
  "keyboard",
  "game",
  "cup",
];
export interface VisualActor {
  readonly actor: OfficeActor;
  readonly transition: "none" | "arriving" | "departing";
}
export interface SceneRoom {
  readonly id: string;
  readonly title: string;
  readonly site: RoomSite;
  readonly variant: RoomVariant;
  readonly deck: number;
  readonly attaching?: boolean;
  readonly removing?: boolean;
}
export interface OfficeFocus {
  readonly x: number;
  readonly z: number;
  readonly deck: number;
  readonly span: number;
  readonly serial: number;
}
interface SceneProps {
  readonly actors: ReadonlyArray<VisualActor>;
  readonly rooms: ReadonlyArray<SceneRoom>;
  readonly slots: Readonly<Record<string, number>>;
  readonly motion: OfficeMotion;
  readonly focus: OfficeFocus;
  readonly selected: string | null;
  readonly onSelect: (key: string) => void;
  readonly labels: Map<string, HTMLElement>;
  readonly visible: boolean;
  readonly reduced: boolean;
  readonly lowQuality: boolean;
  readonly lamp: boolean;
  readonly onAmenity: (key: Amenity | "lamp" | "directory", projectId?: string) => void;
  readonly onMetrics: (text: string) => void;
  readonly onVisible: (actorKeys: ReadonlyArray<string>, roomKeys: ReadonlyArray<string>) => void;
}
function useAsset(name: string): GLTF {
  const asset = useLoader(GLTFLoader, `${BASE}${name}.glb`);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers feature-owned immutable GLTF resources for disposal when the office exits
  useEffect(() => {
    rememberOfficeAsset(asset);
  }, [asset]);
  return asset;
}

function disposeSkeletons(root: Object3D) {
  root.traverse((object) => {
    if ("skeleton" in object && (object as Mesh & { skeleton?: { dispose: () => void } }).skeleton)
      (object as Mesh & { skeleton: { dispose: () => void } }).skeleton.dispose();
  });
}

function StaticAsset({ name, onPick }: { name: string; onPick?: (object: Object3D) => void }) {
  const asset = useAsset(name);
  const [root] = useState(() => clone(asset.scene));
  return (
    <primitive
      object={root}
      dispose={null}
      onClick={
        onPick
          ? (event: { stopPropagation: () => void; object: Object3D }) => {
              event.stopPropagation();
              onPick(event.object);
            }
          : undefined
      }
    />
  );
}
function ProjectRoom({
  room,
  reduced,
  labels,
  onAmenity,
}: {
  room: SceneRoom;
  reduced: boolean;
  labels: Map<string, HTMLElement>;
  onAmenity: SceneProps["onAmenity"];
}) {
  const group = useRef<Group>(null);
  const elapsed = useRef(room.attaching ? 0 : 1);
  useFrame((state, dt) => {
    const label = labels.get(`room:${room.id}`);
    if (label) {
      const point = new Vector3(
        room.site.x,
        room.deck * DECK_HEIGHT + 0.5,
        room.site.z + 4,
      ).project(state.camera);
      label.hidden = Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
      label.style.transform = `translate(${((point.x + 1) * state.size.width) / 2}px,${((1 - point.y) * state.size.height) / 2}px) translate(-50%,-50%)`;
    }
    elapsed.current = room.removing
      ? Math.max(0, elapsed.current - Math.min(dt, 0.05) * 1.5)
      : Math.min(1, elapsed.current + Math.min(dt, 0.05) * 1.5);
    if (group.current) {
      const t = reduced ? (room.removing ? 0 : 1) : elapsed.current;
      group.current.position.y = room.deck * DECK_HEIGHT - (1 - t) * (1 - t) * 3;
      group.current.scale.y = 0.85 + 0.15 * t;
    }
  });
  return (
    <group
      ref={group}
      position={[room.site.x, room.deck * DECK_HEIGHT, room.site.z]}
      rotation={[0, roomRotation(room.site, room.variant), 0]}
    >
      <StaticAsset
        name={room.variant}
        onPick={(object) => {
          if (
            object.name.toLowerCase().includes("keyboard") ||
            object.name.toLowerCase().includes("desk_b")
          )
            onAmenity("keyboard", room.id);
        }}
      />
    </group>
  );
}
function LoopFloor({ rings, deck }: { rings: number; deck: number }) {
  return (
    <group position={[0, deck * DECK_HEIGHT, 0]}>
      {Array.from({ length: rings }, (_, i) =>
        i === 0 ? null : (
          <group key={i}>
            {([-1, 1] as const).map((sign) => (
              <group key={sign}>
                <mesh position={[0, -0.18, sign * ringSize(i)[1]]}>
                  <boxGeometry args={[ringSize(i)[0] * 2 + 3, 0.35, 3]} />
                  <meshStandardMaterial color={OFFICE_COLORS.floor} roughness={0.9} />
                </mesh>
                <mesh position={[sign * ringSize(i)[0], -0.18, 0]}>
                  <boxGeometry args={[3, 0.35, ringSize(i)[1] * 2 + 3]} />
                  <meshStandardMaterial color={OFFICE_COLORS.floor} roughness={0.9} />
                </mesh>
              </group>
            ))}
            <mesh position={[(ringSize(i)[0] + ringSize(i - 1)[0]) / 2, -0.18, ringSize(i - 1)[1]]}>
              <boxGeometry args={[18, 0.35, 3]} />
              <meshStandardMaterial color={OFFICE_COLORS.floor} roughness={0.9} />
            </mesh>
          </group>
        ),
      )}
      <mesh position={[9.5, -0.1, 8.5]}>
        <boxGeometry args={[2.8, 0.18, 2.8]} />
        <meshStandardMaterial color={OFFICE_COLORS.lift} roughness={0.6} />
      </mesh>
    </group>
  );
}
function Furniture({
  deck,
  motion,
  onAmenity,
  lamp,
}: {
  deck: number;
  motion: OfficeMotion;
  onAmenity: SceneProps["onAmenity"];
  lamp: boolean;
}) {
  const asset = useAsset("props"),
    [instance] = useState(() => createFurnitureInstance(asset));
  const root = instance.root;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes only furniture materials cloned for responsive light and board effects
  useEffect(() => () => instance.dispose(), [instance]);
  useFrame(() => {
    const performers = [...motion.lives.values()].filter(
      (life) => life.lobbyDeck === deck && life.performanceReady,
    );
    updateFurniture(
      root,
      lamp,
      performers.find((life) => life.performance === "coffee")?.performanceTime ?? null,
      performers.find((life) => life.performance === "game")?.performanceTime ?? null,
    );
  });
  const pick = (object: Object3D) => {
    const n = object.name.toLowerCase();
    if (n.includes("coffee")) onAmenity("coffee");
    else if (n.includes("sofa")) onAmenity("sofa");
    else if (n.includes("game")) onAmenity("game");
    else if (n.includes("reading_lamp")) onAmenity("lamp");
    else if (n.includes("directory")) onAmenity("directory");
  };
  return (
    <group position={[0, deck * DECK_HEIGHT, 0]}>
      <primitive
        object={root}
        dispose={null}
        onClick={(event: { stopPropagation: () => void; object: Object3D }) => {
          event.stopPropagation();
          pick(event.object);
        }}
      />
      {lamp ? (
        <>
          <pointLight
            position={[-6.55, 2.38, -4.9]}
            intensity={25}
            color={OFFICE_COLORS.lamp}
            distance={8}
          />
          <mesh position={[-6.55, 0.081, -4.9]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[1.2, 32]} />
            <meshBasicMaterial
              color={OFFICE_COLORS.lamp}
              transparent
              opacity={0.18}
              depthWrite={false}
            />
          </mesh>
        </>
      ) : null}
    </group>
  );
}
function CupHome({ deck, motion }: { deck: number; motion: OfficeMotion }) {
  const asset = useAsset("cup"),
    [root] = useState(() => clone(asset.scene));
  useFrame(() =>
    updateCupHome(
      root,
      [...motion.lives.values()].some(
        (life) => life.lobbyDeck === deck && life.performance === "coffee" && life.performanceReady,
      ),
    ),
  );
  return (
    <group position={[0, deck * DECK_HEIGHT, 0]}>
      <primitive object={root} dispose={null} />
    </group>
  );
}
function Performance({ life, onReady }: { life: Life; onReady: () => void }) {
  const name = life.performance ?? "coffee",
    asset = useAsset(name),
    character = useAsset(PERFORMANCES[name].child ? "child" : "main");
  const [instance] = useState(() => createPerformanceInstance(asset, character, name));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers loaded animation readiness and disposes this independent animation mixer and skeleton on release
  useEffect(() => {
    onReady();
    return () => {
      instance.mixer.stopAllAction();
      instance.mixer.uncacheRoot(instance.root);
      disposeSkeletons(instance.root);
    };
  }, [instance, onReady]);
  const wrapper = useRef<Group>(null);
  useFrame(() =>
    advancePerformance(instance.root, instance.mixer, instance.performer, wrapper.current, life),
  );
  const keyboard = name === "keyboard",
    angle = keyboard ? roomRotation(life.site, life.variant) : 0,
    offset = PERFORMANCES[name].offset;
  const origin = keyboard
    ? new Vector3(life.site.x, life.homeDeck * DECK_HEIGHT, life.site.z).sub(
        new Vector3(offset[0], 0, offset[1]).applyAxisAngle(new Vector3(0, 1, 0), angle),
      )
    : new Vector3(0, life.lobbyDeck * DECK_HEIGHT, 0);
  return (
    <group ref={wrapper} position={origin} rotation={[0, angle, 0]}>
      <primitive object={instance.root} dispose={null} />
    </group>
  );
}
function ActorModel({
  visual,
  life,
  motion,
  selected,
  onSelect,
  labels,
  reduced,
}: {
  visual: VisualActor;
  life: Life;
  motion: OfficeMotion;
  selected: boolean;
  onSelect: () => void;
  labels: Map<string, HTMLElement>;
  reduced: boolean;
}) {
  const asset = useAsset(visual.actor.child ? "child" : "main"),
    group = useRef<Group>(null),
    ring = useRef<Mesh>(null);
  const [instance] = useState(() => createActorInstance(asset));
  const performance = useSyncExternalStore(
    motion.subscribe,
    () => motion.performanceFor(life.key),
    () => null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets lifecycle uniforms when an authoritative arrival, settlement or undo changes this retained scene actor
  useEffect(() => {
    resetActorLifecycle(instance, visual.transition);
  }, [instance, visual.transition]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns cloned skeletons, per-actor materials and lifecycle particle buffers while immutable source geometry stays shared
  useEffect(
    () => () => {
      const label = labels.get(life.key);
      if (label) label.hidden = true;
      instance.mixer.stopAllAction();
      instance.mixer.uncacheRoot(instance.root);
      instance.materials.dispose();
      instance.dust?.dispose();
      disposeSkeletons(instance.root);
    },
    [instance, labels, life.key],
  );
  useFrame((state, dt) =>
    advanceActorFrame(
      instance,
      asset,
      state,
      dt,
      group.current,
      ring.current,
      visual,
      life,
      selected,
      labels,
      reduced,
      motion,
    ),
  );
  return (
    <>
      <group
        ref={group}
        onClick={(event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <primitive object={instance.root} dispose={null} />
        <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
          <ringGeometry args={[1.2, 1.3, 40]} />
          <meshBasicMaterial
            color={OFFICE_COLORS.selection}
            transparent
            opacity={0.8}
            depthWrite={false}
          />
        </mesh>
      </group>
      {performance ? (
        <Suspense fallback={null}>
          <Performance key={performance} life={life} onReady={() => markPerformanceReady(life)} />
        </Suspense>
      ) : null}
    </>
  );
}
function CameraController({ focus }: { focus: OfficeFocus }) {
  const { camera, gl, invalidate, size } = useThree();
  const [controls] = useState(() => new OrbitControls(camera, gl.domElement));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects orbit controls to the canvas and invalidates demand frames only for actual camera input
  useEffect(() => connectOfficeControls(controls, () => invalidate()), [controls, invalidate]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies explicit directory and toolbar camera focus to Three's imperative camera
  useEffect(
    () => focusOfficeCamera(camera, controls, focus, size, () => invalidate()),
    [camera, controls, focus, invalidate, size],
  );
  return null;
}
function Scene({
  actors,
  rooms,
  slots,
  motion,
  focus,
  selected,
  onSelect,
  labels,
  visible,
  reduced,
  lowQuality,
  lamp,
  onAmenity,
  onMetrics,
  onVisible,
}: SceneProps) {
  const { invalidate, gl } = useThree();
  const lives = useSyncExternalStore(motion.subscribe, motion.getSnapshot, motion.getSnapshot);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lets newly mounted DOM anchors request one projection frame from the demand renderer
  useEffect(() => motion.connectGraphics(() => invalidate()), [motion, invalidate]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers canonical actor changes with the independent cosmetic movement controller
  useEffect(() => {
    const present = new Set<string>();
    for (const { actor, transition } of actors) {
      const room = rooms.find((room) => room.id === actor.projectId);
      if (!room) continue;
      present.add(actor.key);
      motion.add(actor, room.site, room.variant, slots[actor.key] ?? 0);
      motion.setDeparture(actor.key, transition === "departing");
      motion.update(actor);
    }
    for (const key of motion.lives.keys()) if (!present.has(key)) motion.remove(key);
    invalidate();
  }, [actors, rooms, slots, motion, invalidate]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- caps visible motion at 30 demand frames per second and suspends all decorative rendering when hidden
  useEffect(() => {
    if (!visible) return;
    const warmFrames = { remaining: 30 };
    const timer = setInterval(() => {
      const animating =
        warmFrames.remaining > 0 ||
        actors.some((v) => v.transition !== "none") ||
        rooms.some((room) => room.attaching || room.removing) ||
        [...motion.lives.values()].some(
          (life) =>
            life.actor.status !== "offline" &&
            (life.route.length > 0 ||
              life.performance !== null ||
              life.requested !== null ||
              (!reduced &&
                ["working", "thinking", "waiting", "starting"].includes(life.actor.status))),
        );
      warmFrames.remaining = Math.max(0, warmFrames.remaining - 1);
      if (animating) invalidate();
    }, 1000 / 30);
    return () => clearInterval(timer);
  }, [actors, rooms, motion, reduced, visible, invalidate]);
  useFrame((_state, delta) => {
    if (visible) motion.tick(Math.min(delta, 0.1), reduced);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports real renderer counters for the primary's runtime budget measurements
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(
      () =>
        onMetrics(
          `${gl.info.render.calls} draw calls · ${Math.round(gl.info.render.triangles / 1000)}k triangles · ${gl.info.memory.geometries} geometries · ${gl.info.memory.textures} textures`,
        ),
      2000,
    );
    return () => clearInterval(timer);
  }, [gl, onMetrics, visible]);
  const visibleActors = actors
    .filter(({ actor }) => {
      const life = lives.get(actor.key);
      return life
        ? Math.abs(life.position.y - focus.deck * DECK_HEIGHT) < 3
        : Math.floor((slots[actor.key] ?? 0) / 2) === focus.deck;
    })
    .sort(
      (a, b) =>
        Number(b.actor.key === selected) - Number(a.actor.key === selected) ||
        Number(b.actor.status === "waiting") - Number(a.actor.status === "waiting") ||
        Math.hypot(
          (lives.get(a.actor.key)?.position.x ?? 0) - focus.x,
          (lives.get(a.actor.key)?.position.z ?? 0) - focus.z,
        ) -
          Math.hypot(
            (lives.get(b.actor.key)?.position.x ?? 0) - focus.x,
            (lives.get(b.actor.key)?.position.z ?? 0) - focus.z,
          ),
    )
    .slice(0, lowQuality ? 8 : 16);
  const visibleRooms = rooms
    .filter((room) => Math.abs(room.site.x - focus.x) < 90 && Math.abs(room.site.z - focus.z) < 90)
    .sort(
      (a, b) =>
        Math.hypot(a.site.x - focus.x, a.site.z - focus.z) -
        Math.hypot(b.site.x - focus.x, b.site.z - focus.z),
    )
    .slice(0, 24);
  const actorKeys = visibleActors
      .filter((visual) => visual.transition !== "departing")
      .map((visual) => visual.actor.key),
    roomKeys = visibleRooms.map((room) => room.id);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- limits DOM anchors to the actual culled graphics while the accessible directory retains every logical occupant
  useEffect(() => {
    onVisible(actorKeys, roomKeys);
  }, [actorKeys, roomKeys, onVisible]);
  const maxRing = Math.max(0, ...rooms.map((room) => room.site.ring));
  return (
    <>
      <color attach="background" args={["#526b70"]} />
      <hemisphereLight args={["#e5f5ff", "#8c765d", 2.3]} />
      <directionalLight position={[-15, 35, 18]} color={OFFICE_COLORS.key} intensity={3} />
      <directionalLight position={[22, 24, 3]} color={OFFICE_COLORS.fill} intensity={2} />
      <CameraController focus={focus} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.68, 0]}>
        <planeGeometry args={[400 + maxRing * 40, 400 + maxRing * 40]} />
        <meshStandardMaterial color={OFFICE_COLORS.ground} roughness={1} />
      </mesh>
      <group position={[0, focus.deck * DECK_HEIGHT, 0]}>
        <StaticAsset name="lobby" />
      </group>
      <CupHome deck={focus.deck} motion={motion} />
      <Furniture deck={focus.deck} motion={motion} lamp={lamp} onAmenity={onAmenity} />
      <LoopFloor rings={maxRing + 1} deck={focus.deck} />
      {visibleRooms.map((room) => (
        <ProjectRoom
          key={`${room.id}:${focus.deck}`}
          room={{ ...room, deck: focus.deck }}
          reduced={reduced}
          labels={labels}
          onAmenity={onAmenity}
        />
      ))}
      {visibleActors.map((visual) => {
        const life = lives.get(visual.actor.key);
        return life ? (
          <ActorModel
            key={visual.actor.key}
            visual={visual}
            life={life}
            motion={motion}
            selected={selected === visual.actor.key}
            onSelect={() => onSelect(visual.actor.key)}
            labels={labels}
            reduced={reduced}
          />
        ) : null;
      })}
    </>
  );
}
function AssetLifetime() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the office-only GLTF loader cache when this lazy feature unmounts
  useEffect(
    () => () => {
      for (const name of ASSETS) {
        const url = `${BASE}${name}.glb`;
        useLoader.clear(GLTFLoader, url);
      }
      disposeOfficeAssets();
    },
    [],
  );
  return null;
}
export function OfficeScene(props: SceneProps) {
  const [retry, setRetry] = useState(0),
    [lost, setLost] = useState(false);
  return (
    <RenderErrorBoundary
      resetKeys={[retry]}
      fallback={
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <p>3D graphics could not load. Your agents and chat remain available in the directory.</p>
          <Button
            onClick={() => {
              setLost(false);
              setRetry(retry + 1);
            }}
          >
            Retry graphics
          </Button>
        </div>
      }
    >
      {lost ? (
        <div
          role="alert"
          className="absolute inset-x-3 bottom-4 z-10 rounded-lg bg-background p-3 text-sm"
        >
          Graphics were interrupted. The directory and chat still work.{" "}
          <Button
            size="sm"
            onClick={() => {
              setLost(false);
              setRetry(retry + 1);
            }}
          >
            Restore graphics
          </Button>
        </div>
      ) : null}
      <Canvas
        key={retry}
        orthographic
        frameloop={props.visible && !lost ? "demand" : "never"}
        dpr={props.lowQuality ? 1 : [1, 1.25]}
        camera={{ position: [25, 49, 40], near: 0.1, far: 2500 }}
        gl={{ antialias: !props.lowQuality, powerPreference: "low-power", alpha: false }}
        fallback={<p>Use the directory to open and control agents. WebGL is unavailable.</p>}
        onCreated={({ gl }) => {
          gl.toneMapping = ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.25;
          gl.outputColorSpace = SRGBColorSpace;
          gl.domElement.addEventListener(
            "webglcontextlost",
            (event) => {
              event.preventDefault();
              setLost(true);
            },
            { once: true },
          );
        }}
      >
        <AssetLifetime />
        <Suspense fallback={null}>
          <Scene {...props} />
        </Suspense>
      </Canvas>
    </RenderErrorBoundary>
  );
}
