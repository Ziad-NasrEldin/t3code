import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";

export interface CrewTheme {
  readonly name: "cyan" | "amber" | "sage";
  readonly jacket: number;
  readonly crest: number;
  readonly piping: number;
  readonly glow: number;
  readonly brow: number;
  readonly silhouette: "fins" | "crest" | "halo";
}

const CREW_THEMES: ReadonlyArray<CrewTheme> = [
  {
    name: "cyan",
    jacket: 0x0a6694,
    crest: 0x0c92c7,
    piping: 0x062b3a,
    glow: 0x0ec7ff,
    brow: 0x2994b8,
    silhouette: "fins",
  },
  {
    name: "amber",
    jacket: 0x0a6694,
    crest: 0x0c92c7,
    piping: 0x062b3a,
    glow: 0x0ec7ff,
    brow: 0x2994b8,
    silhouette: "crest",
  },
  {
    name: "sage",
    jacket: 0x0a6694,
    crest: 0x0c92c7,
    piping: 0x062b3a,
    glow: 0x0ec7ff,
    brow: 0x2994b8,
    silhouette: "halo",
  },
];

export function pickCrewTheme(key: string): CrewTheme {
  const trailing = key.match(/(\d+)[^\d]*$/)?.[1];
  if (trailing !== undefined) {
    let sum = Number(trailing);
    for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
    return CREW_THEMES[Math.abs(sum) % CREW_THEMES.length]!;
  }
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return CREW_THEMES[Math.abs(hash) % CREW_THEMES.length]!;
}

export function applyActorThemeAndSilhouette(
  root: Object3D,
  _theme: CrewTheme,
  _child: boolean,
): () => void {
  void root;
  return () => {};
}

export function makeLifecycleMaterials(root: Object3D, _theme: CrewTheme = CREW_THEMES[0]!) {
  void _theme;
  const uniforms = {
    uOfficeReveal: { value: 1 },
    uOfficeDust: { value: 0 },
    uOfficeBase: { value: new Vector3() },
  };
  const materials: Material[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const clone = (original: Material) => {
      const material = original.clone();
      materials.push(material);
      if (!(material instanceof MeshStandardMaterial)) return material;
      const matName = material.name.toLowerCase();
      if (matName.includes("ceramic")) {
        material.color.setRGB(0.83, 0.78, 0.67);
        material.roughness = 0.36;
        material.metalness = 0;
      } else if (matName.includes("jacket")) {
        material.color.setRGB(0.015, 0.4, 0.58);
        material.roughness = 0.48;
        material.metalness = 0;
      } else if (matName.includes("crest")) {
        material.color.setRGB(0.015, 0.57, 0.78);
        material.roughness = 0.34;
        material.metalness = 0;
      } else if (matName.includes("piping")) {
        material.color.setRGB(0.012, 0.17, 0.23);
        material.roughness = 0.48;
      } else if (matName.includes("face glass")) {
        material.color.setRGB(0.007, 0.018, 0.037);
        material.roughness = 0.26;
        material.metalness = 0.08;
      } else if (matName.includes("gasket")) {
        material.color.setRGB(0.06, 0.075, 0.08);
        material.roughness = 0.48;
      } else if (matName.includes("boots")) {
        material.color.setRGB(0.026, 0.042, 0.063);
        material.roughness = 0.44;
        material.metalness = 0;
      } else if (matName.includes("sole")) {
        material.color.setRGB(0.64, 0.64, 0.59);
        material.roughness = 0.6;
      } else if (matName.includes("joints")) {
        material.color.setRGB(0.018, 0.028, 0.043);
        material.roughness = 0.64;
      } else if (matName.includes("luminous cyan")) {
        material.color.setRGB(0.055, 0.78, 1.0);
        material.emissive.setRGB(0.055, 0.78, 1.0);
        material.emissiveIntensity = 1.6;
        material.roughness = 0.24;
      } else if (matName.includes("expression")) {
        material.color.setRGB(0.16, 0.58, 0.72);
        material.emissive.setRGB(0.16, 0.58, 0.72);
        material.emissiveIntensity = 0.55;
      }
      if (object.name.includes("tablet_glass") || object.name.includes("tablet glass")) {
        material.color.setRGB(0.08, 0.44, 0.48);
        material.emissive.setRGB(0.12, 0.62, 0.78);
        material.emissiveIntensity = 0.85;
        material.roughness = 0.24;
      }
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vOfficeSurface;")
          .replace(
            "#include <project_vertex>",
            "#include <project_vertex>\nvOfficeSurface=(modelMatrix*vec4(transformed,1.0)).xyz;",
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
          varying vec3 vOfficeSurface; uniform float uOfficeReveal; uniform float uOfficeDust; uniform vec3 uOfficeBase;
          float officeNoise(vec3 p){return fract(sin(dot(floor(p*36.0),vec3(12.9898,78.233,37.719)))*43758.5453);}
        `,
          )
          .replace(
            "#include <clipping_planes_fragment>",
            `#include <clipping_planes_fragment>
          vec3 officeP=vOfficeSurface-uOfficeBase; float grain=officeNoise(officeP);
          if(uOfficeReveal<1.0 && officeP.y>uOfficeReveal*4.4+grain*.12)discard;
          float officeEdge=(officeP.x+2.0)/4.0+grain*.13;
          if(uOfficeDust>0.0 && officeEdge<uOfficeDust*1.25)discard;
        `,
          )
          .replace(
            "#include <emissivemap_fragment>",
            `#include <emissivemap_fragment>
          if(uOfficeDust>0.0 && abs(officeEdge-uOfficeDust*1.25)<.05)totalEmissiveRadiance+=vec3(.25,.65,.65);
          if(uOfficeReveal<1.0 && abs(officeP.y-uOfficeReveal*4.4)<.12)totalEmissiveRadiance+=vec3(.25,.8,.9);
        `,
          );
      };
      material.customProgramCacheKey = () => "signal-crew-surface-v3";
      return material;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(clone)
      : clone(object.material);
  });
  return { uniforms, dispose: () => materials.forEach((material) => material.dispose()) };
}

export function enhanceRoomScene(root: Object3D, variant?: string): () => void {
  const disposables: { dispose: () => void }[] = [];
  const aoTargets: { x: number; z: number; y: number; w: number; d: number; strength: number }[] =
    [];
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (
      variant === "lobby" &&
      (object.name.startsWith("Vacant") || object.name.includes("Vacant"))
    ) {
      object.visible = false;
      return;
    }
    if (!(object instanceof Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    if (
      /sofa__base|loveseat__base|banquette__base|low_table0|cabinet0|library__back|planning_island|long_workbench|review_pedestal|desk_B__top|clay_pot|Game__table/i.test(
        object.name,
      ) &&
      !object.name.includes("library__fern")
    ) {
      const box = new Box3().setFromObject(object);
      const cx = (box.min.x + box.max.x) * 0.5;
      const cz = (box.min.z + box.max.z) * 0.5;
      const w = Math.max(1.05, (box.max.x - box.min.x) * 1.36);
      const d = Math.max(1.05, (box.max.z - box.min.z) * 1.36);
      const onLobbyRug =
        variant === "props" && /sofa__base|loveseat__base|low_table0/i.test(object.name);
      aoTargets.push({
        x: cx,
        z: cz,
        y: onLobbyRug ? 0.172 : 0.105,
        w,
        d,
        strength: /clay_pot/i.test(object.name) ? 0.32 : 0.28,
      });
    }
    const upgrade = (original: Material) => {
      if (!(original instanceof MeshStandardMaterial)) return original;
      const mat = original.clone();
      disposables.push(mat);
      const n = mat.name.toLowerCase();
      let mode = 0;
      if (n.includes("honey ash")) {
        mat.color.setRGB(0.45, 0.27, 0.14);
        mat.roughness = 0.52;
        mode = 1;
      } else if (n.includes("ash end grain")) {
        mat.color.setRGB(0.67, 0.48, 0.3);
        mat.roughness = 0.55;
        mode = 1;
      } else if (n.includes("warm chalk")) {
        mat.color.setRGB(0.79, 0.75, 0.64);
        mat.roughness = 0.56;
      } else if (n.includes("pale terrazzo")) {
        mat.color.setRGB(0.59, 0.64, 0.58);
        mat.roughness = 0.8;
        mode = 3;
      } else if (n.includes("moss upholstery")) {
        mat.color.setRGB(0.28, 0.45, 0.35);
        mat.roughness = 0.86;
        mode = 2;
      } else if (n.includes("oat boucle")) {
        mat.color.setRGB(0.58, 0.51, 0.37);
        mat.roughness = 0.92;
        mode = 2;
      } else if (n.includes("woven sand")) {
        mat.color.setRGB(0.46, 0.37, 0.25);
        mat.roughness = 0.94;
        mode = 2;
      } else if (n.includes("apricot ceramic")) {
        mat.color.setRGB(0.62, 0.27, 0.15);
        mat.roughness = 0.54;
      } else if (n.includes("lagoon")) {
        mat.color.setRGB(0.08, 0.44, 0.48);
        mat.roughness = 0.52;
      } else if (n.includes("foliage")) {
        mat.color.setRGB(0.14, 0.36, 0.2);
        mat.roughness = 0.55;
      } else if (n.includes("new leaves")) {
        mat.color.setRGB(0.31, 0.5, 0.24);
        mat.roughness = 0.52;
      } else if (n.includes("brushed brass")) {
        mat.color.setRGB(0.47, 0.32, 0.12);
        mat.roughness = 0.34;
        mat.metalness = 0.62;
      } else if (n.includes("screen midnight")) {
        mat.color.setRGB(0.025, 0.09, 0.11);
        mat.roughness = 0.28;
      } else if (n.includes("display cyan")) {
        mat.color.setRGB(0.24, 0.8, 0.79);
        mat.emissive.setRGB(0.24, 0.8, 0.79);
        mat.emissiveIntensity = 0.7;
      } else if (n.includes("porcelain")) {
        mat.color.setRGB(0.88, 0.87, 0.78);
        mat.roughness = 0.32;
      } else if (n.includes("paper")) {
        mat.color.setRGB(0.82, 0.78, 0.65);
        mat.roughness = 0.55;
      } else if (n.includes("ink")) {
        mat.color.setRGB(0.035, 0.075, 0.087);
        mat.roughness = 0.5;
      }
      if (mode >= 0) {
        mat.onBeforeCompile = (shader) => {
          shader.vertexShader = shader.vertexShader
            .replace(
              "#include <common>",
              "#include <common>\nvarying vec3 vOfficeWorldPos;\nvarying vec3 vOfficeWorldNormal;",
            )
            .replace(
              "#include <project_vertex>",
              "#include <project_vertex>\nvOfficeWorldPos=(modelMatrix*vec4(transformed,1.0)).xyz;\nvOfficeWorldNormal=normalize(mat3(modelMatrix)*objectNormal);",
            );
          shader.fragmentShader = shader.fragmentShader
            .replace(
              "#include <common>",
              `#include <common>
              varying vec3 vOfficeWorldPos;
              varying vec3 vOfficeWorldNormal;
              float officeHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
              float officeValNoise(vec2 p){
                vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                return mix(mix(officeHash(i),officeHash(i+vec2(1.0,0.0)),f.x),mix(officeHash(i+vec2(0.0,1.0)),officeHash(i+vec2(1.0,1.0)),f.x),f.y);
              }`,
            )
            .replace(
              "#include <color_fragment>",
              `#include <color_fragment>
              #if ${mode} == 1
                float grain = (officeValNoise(vec2(vOfficeWorldPos.x*3.0, vOfficeWorldPos.z*10.0)) - 0.5) * 0.035;
                diffuseColor.rgb *= (1.0 + grain);
              #elif ${mode} == 2
                float weave = (officeValNoise(vOfficeWorldPos.xz*24.0) - 0.5) * 0.03;
                diffuseColor.rgb *= (1.0 + weave);
              #elif ${mode} == 3
                float speck = (officeValNoise(vOfficeWorldPos.xz*12.0) - 0.5) * 0.02;
                diffuseColor.rgb *= (1.0 + speck);
              #endif
              float sideMask = 1.0 - abs(vOfficeWorldNormal.y);
              float groundCrevice = smoothstep(0.04, 0.52, vOfficeWorldPos.y);
              diffuseColor.rgb *= mix(1.0, mix(0.84, 1.0, groundCrevice), sideMask);
              if (vOfficeWorldNormal.y < -0.15) diffuseColor.rgb *= 0.82;`,
            );
        };
        mat.customProgramCacheKey = () => `office-surface-agx-v2-${mode}`;
      }
      return mat;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(upgrade)
      : upgrade(object.material);
  });
  if (aoTargets.length > 0) {
    const aoGeo = new PlaneGeometry(1, 1);
    const aoMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `varying vec2 vUv;void main(){vec2 p=(vUv-0.5)*2.0;float d=length(p);float a=pow(smoothstep(1.0,0.1,d),1.4)*0.24;if(a<0.005)discard;gl_FragColor=vec4(0.14,0.11,0.08,a);}`,
    });
    disposables.push(aoGeo, aoMat);
    for (const item of aoTargets) {
      const pad = new Mesh(aoGeo, aoMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(item.x, item.y, item.z);
      pad.scale.set(item.w, item.d, 1);
      root.add(pad);
    }
  }
  return () => disposables.forEach((item) => item.dispose());
}

export function createStatusIndicator() {
  const group = new Group();
  group.name = "actor_status_indicator";
  group.position.set(0, 3.85, 0);
  group.visible = false;
  const disposables: { dispose: () => void }[] = [];

  const waitGroup = new Group();
  const stemGeo = new CylinderGeometry(0.065, 0.05, 0.34, 14);
  const dotGeo = new SphereGeometry(0.075, 14, 12);
  const waitMat = new MeshStandardMaterial({
    color: 0xffb830,
    emissive: new Color(0xff9c1a),
    emissiveIntensity: 2.2,
    roughness: 0.2,
  });
  const stem = new Mesh(stemGeo, waitMat);
  stem.position.y = 0.22;
  const dot = new Mesh(dotGeo, waitMat);
  dot.position.y = -0.05;
  waitGroup.add(stem, dot);
  disposables.push(stemGeo, dotGeo, waitMat);

  const thinkGroup = new Group();
  const orbGeo = new SphereGeometry(0.075, 14, 12);
  const thinkMat = new MeshStandardMaterial({
    color: 0x3ce8ff,
    emissive: new Color(0x22c8ff),
    emissiveIntensity: 2.0,
    roughness: 0.18,
  });
  for (let i = 0; i < 3; i++) {
    const orb = new Mesh(orbGeo, thinkMat);
    const a = (i * Math.PI * 2) / 3;
    orb.position.set(Math.cos(a) * 0.28, 0.08 * (i - 1), Math.sin(a) * 0.28);
    orb.scale.setScalar(0.8 + i * 0.15);
    thinkGroup.add(orb);
  }
  disposables.push(orbGeo, thinkMat);

  const sleepGroup = new Group();
  const ringGeo = new TorusGeometry(0.11, 0.024, 10, 24);
  const sleepMat = new MeshBasicMaterial({
    color: 0x8be8ff,
    transparent: true,
    opacity: 0.75,
    side: DoubleSide,
  });
  for (let i = 0; i < 2; i++) {
    const bubble = new Mesh(ringGeo, sleepMat);
    bubble.position.set(0.18 * (i + 1), 0.22 * i, 0);
    bubble.scale.setScalar(0.75 + i * 0.35);
    sleepGroup.add(bubble);
  }
  disposables.push(ringGeo, sleepMat);

  group.add(waitGroup, thinkGroup, sleepGroup);
  return {
    group,
    update(status: string, elapsed: number, child: boolean) {
      const showWait = status === "waiting" || status === "error";
      const showThink = status === "thinking" || status === "starting";
      const showSleep = status === "sleeping";
      group.visible = showWait || showThink || showSleep;
      if (!group.visible) return;
      const baseHeight = showSleep ? 1.55 : child ? 3.25 : 4.05;
      group.position.y = baseHeight + Math.sin(elapsed * 3.6) * 0.08;
      group.rotation.y = elapsed * 1.4;
      waitGroup.visible = showWait;
      thinkGroup.visible = showThink;
      sleepGroup.visible = showSleep;
    },
    dispose: () => disposables.forEach((item) => item.dispose()),
  };
}

export function createActorContactShadow(child: boolean) {
  const radius = child ? 0.95 : 1.18;
  const geometry = new PlaneGeometry(radius * 2, radius * 2);
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `varying vec2 vUv;void main(){vec2 p=(vUv-0.5)*2.0;float d=length(p);float a=pow(smoothstep(1.0,0.12,d),1.5)*0.28;if(a<0.005)discard;gl_FragColor=vec4(0.12,0.11,0.09,a);}`,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "actor_contact_shadow";
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, 0.022, 0);
  return {
    mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
export function createSurfaceDust(root: Object3D, count = 480) {
  const positions = new Float32Array(count * 3),
    delays = new Float32Array(count),
    drift = new Float32Array(count * 3),
    meshes: Mesh[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    if (object instanceof Mesh && object.geometry.attributes.position) meshes.push(object);
  });
  const point = new Vector3(),
    a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  const inverse = root.matrixWorld.clone().invert();
  let seed = 19437;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const mesh = meshes[Math.floor(random() * meshes.length)];
    if (!mesh) continue;
    const geometry = mesh.geometry,
      index = geometry.index,
      n = index?.count ?? geometry.attributes.position!.count,
      face = Math.floor(random() * Math.floor(n / 3)) * 3;
    mesh.getVertexPosition(index ? index.getX(face) : face, a);
    mesh.getVertexPosition(index ? index.getX(face + 1) : face + 1, b);
    mesh.getVertexPosition(index ? index.getX(face + 2) : face + 2, c);
    const u = Math.sqrt(random()),
      v = random();
    point
      .copy(a)
      .multiplyScalar(1 - u)
      .addScaledVector(b, u * (1 - v))
      .addScaledVector(c, u * v)
      .applyMatrix4(mesh.matrixWorld)
      .applyMatrix4(inverse);
    point.toArray(positions, i * 3);
    delays[i] = (point.x + 2) / 5;
    drift.set([0.6 + random() * 1.5, 0.3 + random() * 1.4, (random() - 0.5) * 1.5], i * 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("aDelay", new BufferAttribute(delays, 1));
  geometry.setAttribute("aDrift", new BufferAttribute(drift, 3));
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `attribute float aDelay;attribute vec3 aDrift;uniform float uTime;varying float vAlpha;void main(){float t=max(0.0,uTime-aDelay);vAlpha=step(aDelay,uTime)*(1.0-smoothstep(.1,.9,t));vec3 p=position+aDrift*t;vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(65.0/-mv.z,1.5,5.0);}`,
    fragmentShader: `varying float vAlpha;void main(){if(length(gl_PointCoord-.5)>.5)discard;gl_FragColor=vec4(.68,.84,.80,vAlpha);}`,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  return {
    points,
    update: (time: number) => {
      material.uniforms.uTime!.value = time;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
