import {
  BufferAttribute,
  BufferGeometry,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Points,
  ShaderMaterial,
  Vector3,
} from "three";

export function makeLifecycleMaterials(root: Object3D) {
  const uniforms = {
    uOfficeReveal: { value: 1 },
    uOfficeDust: { value: 0 },
    uOfficeBase: { value: new Vector3() },
  };
  const materials: Material[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const clone = (original: Material) => {
      const material = original.clone();
      materials.push(material);
      if (!(material instanceof MeshStandardMaterial)) return material;
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
      material.customProgramCacheKey = () => "signal-crew-surface-v1";
      return material;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(clone)
      : clone(object.material);
  });
  return { uniforms, dispose: () => materials.forEach((material) => material.dispose()) };
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
