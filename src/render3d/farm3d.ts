import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { hash2 } from '../game/math';
import {
  DogRig,
  NECK,
  PAL,
  SHEEP_HIP,
  TILT_SHIFT,
  blob,
  bush,
  colored,
  dogModel,
  puffyTree,
  shaded,
  sheepGeometry,
  stoneBlob,
  toyMaterial,
} from './meadow3d';

/**
 * The home farm as a little floating-island diorama, in the same toy style as
 * the meadows. Pieces pop in on a timeline (`BUILD`), as if bought with wool:
 * this is the look of the farm-building meta game, and the scene for the
 * "cozy farm" ad. Driven by `render(t)` with t in seconds from the start.
 */
export const BUILD = { barn: 3.2, cottage: 7.2, garden: 11.0, pond: 13.6, cap: 16.4 };

interface Piece {
  group: THREE.Group;
  at: number;
}

export class Farm3D {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private blurX: ShaderPass;
  private blurY: ShaderPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 0.5, 1, 300);
  private uTime = { value: 0 };
  private pieces: Piece[] = [];
  private sheep: { x: number; z: number; a: number; phase: number; hop: number }[] = [];
  private wool!: THREE.InstancedMesh;
  private faces!: THREE.InstancedMesh;
  private legsA!: THREE.InstancedMesh;
  private legsB!: THREE.InstancedMesh;
  private dog!: DogRig;
  private cap!: THREE.Group;
  private smoke!: THREE.InstancedMesh;
  private sparkles!: THREE.InstancedMesh;
  private tmp = new THREE.Object3D();
  private local = new THREE.Matrix4();
  private world4 = new THREE.Matrix4();
  private lastT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const sun = new THREE.DirectionalLight(0xfff0d0, 2.4);
    sun.position.set(-18, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 90 });
    sun.shadow.radius = 5;
    sun.shadow.blurSamples = 10;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun, new THREE.HemisphereLight(0xcfeaff, 0x7a9a4a, 1.3));
    this.scene.background = new THREE.Color(0xa8dcff);
    this.scene.fog = new THREE.Fog(0xa8dcff, 70, 140);

    const samples = Number(new URLSearchParams(location.search).get('msaa') ?? 4);
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.blurX = new ShaderPass(TILT_SHIFT);
    this.blurY = new ShaderPass(TILT_SHIFT);
    this.blurY.uniforms.dir.value.set(0, 1);
    this.composer.addPass(this.blurX);
    this.composer.addPass(this.blurY);
    this.composer.addPass(new OutputPass());

    this.build();
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(cssW, cssH);
    for (const p of [this.blurX, this.blurY]) p.uniforms.texel.value.set(1 / (cssW * dpr), 1 / (cssH * dpr));
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
  }

  render(t: number): void {
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.uTime.value = t;
    for (const p of this.pieces) {
      const k = popScale(t - p.at);
      p.group.visible = k > 0.001;
      p.group.scale.setScalar(Math.max(0.001, k));
    }
    this.cap.visible = t > BUILD.cap;
    this.cap.scale.setScalar(Math.max(0.001, popScale(t - BUILD.cap)));
    this.updateSheep(t, dt);
    this.updateDog(t);
    this.updateSmoke(t);
    this.updateSparkles(t);
    // Slow drift round the island, far enough back that it fits a portrait screen.
    const a = -0.35 + t * 0.04;
    const fit = ISLAND / Math.tan(Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect));
    let dist = fit * (1.12 - Math.min(t, 16) * 0.006);
    // Finale: swoop in on the collie showing off his new cap.
    const close = smoothstep(BUILD.cap - 0.8, BUILD.cap + 1.2, t);
    dist *= 1 - close * 0.72;
    const look = this.dog.root.position;
    const lx = look.x * close;
    const ly = -1.5 + close * 2.2;
    const lz = look.z * close;
    this.camera.position.set(lx + Math.sin(a) * dist * 0.62, ly + dist * (0.78 - close * 0.3), lz + Math.cos(a) * dist * 0.62);
    this.camera.lookAt(lx, ly, lz);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = Math.max(dist * 1.3, 70);
    fog.far = Math.max(dist * 2.6, 140);

    this.composer.render();
  }

  // ------------------------------------------------------------- animals

  private updateSheep(t: number, dt: number): void {
    const o = this.tmp;
    this.sheep.forEach((s, i) => {
      // Amble about the paddock, turning gently, with the odd hop when something new appears.
      s.a += Math.sin(t * 0.4 + i * 2.1) * dt * 0.6;
      const walk = 0.5 + 0.5 * Math.sin(t * 0.7 + i);
      const sp = walk > 0.6 ? 0.9 : 0;
      s.x += Math.cos(s.a) * sp * dt;
      s.z -= Math.sin(s.a) * sp * dt;
      const r = Math.hypot(s.x - PADDOCK.x, s.z - PADDOCK.z);
      if (r > PADDOCK.r - 1.2) s.a = Math.atan2(-(PADDOCK.z - s.z), PADDOCK.x - s.x) + (hash2(i, Math.floor(t), 4) - 0.5);
      s.phase += dt * (2 + sp * 3);
      let hop = 0;
      for (const at of Object.values(BUILD)) {
        const since = t - at - 0.2 - (i % 4) * 0.08;
        if (since > 0 && since < 0.45) hop = Math.sin((since / 0.45) * Math.PI) * 0.7;
      }
      const trot = sp > 0 ? 0.4 : 0;
      o.position.set(s.x, Math.abs(Math.sin(s.phase * 3)) * 0.08 * trot + hop, s.z);
      o.rotation.set(0, s.a, hop * 0.3);
      o.scale.setScalar(i % 5 === 4 ? 0.7 : 1);
      o.updateMatrix();
      this.wool.setMatrixAt(i, o.matrix);
      const graze = sp === 0 ? Math.max(0, Math.sin(t * 0.5 + i * 1.3)) : 0;
      const ga = -graze * 0.75;
      const gc = Math.cos(ga);
      const gs = Math.sin(ga);
      this.local.makeRotationZ(ga).setPosition(NECK.x - (gc * NECK.x - gs * NECK.y), NECK.y - (gs * NECK.x + gc * NECK.y), 0);
      this.faces.setMatrixAt(i, this.world4.multiplyMatrices(o.matrix, this.local));
      const swing = Math.sin(s.phase * 3) * (0.08 + 0.5 * trot);
      this.local.makeRotationZ(swing).setPosition(0, SHEEP_HIP, 0);
      this.legsA.setMatrixAt(i, this.world4.multiplyMatrices(o.matrix, this.local));
      this.local.makeRotationZ(-swing).setPosition(0, SHEEP_HIP, 0);
      this.legsB.setMatrixAt(i, this.world4.multiplyMatrices(o.matrix, this.local));
    });
    for (const im of [this.wool, this.faces, this.legsA, this.legsB]) im.instanceMatrix.needsUpdate = true;
  }

  private updateDog(t: number): void {
    const rig = this.dog;
    // Trots a lazy loop round the front of the yard, sits up proudly for the cap.
    const showOff = t > BUILD.cap - 0.6;
    const a = Math.min(t, BUILD.cap - 0.6) * 0.35 + 1.2;
    const r = 6.5;
    const x = 3 + Math.cos(a) * r;
    const z = 4 + Math.sin(a) * r * 0.6;
    rig.root.position.set(x, 0, z);
    // Showing off: turn to face the camera.
    const ca = -0.35 + t * 0.04;
    rig.root.rotation.y = showOff ? Math.atan2(-Math.cos(ca), Math.sin(ca)) : Math.atan2(-Math.cos(a) * 0.6, -Math.sin(a));
    const run = showOff ? 0 : 0.6;
    const st = t * 8;
    rig.torso.position.y = 0.6 + Math.abs(Math.sin(st)) * 0.04 * run;
    rig.head.rotation.z = showOff ? 0.25 : Math.sin(st + 0.6) * 0.05;
    rig.legs.forEach((leg, i) => (leg.rotation.z = (i === 0 || i === 3 ? 1 : -1) * Math.sin(st) * 0.6 * run));
    rig.tail.rotation.y = Math.sin(t * (showOff ? 16 : 9)) * 0.7;
    rig.tongue.scale.y = 0.8 + Math.sin(t * 14) * 0.25;
  }

  private updateSmoke(t: number): void {
    const show = t > BUILD.cottage + 0.6;
    const o = this.tmp;
    for (let i = 0; i < 8; i++) {
      const q = (t * 0.35 + i / 8) % 1;
      o.position.set(CHIMNEY.x + Math.sin(q * 5 + i) * 0.3 + q * 0.8, CHIMNEY.y + q * 4, CHIMNEY.z - q * 0.4);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(show ? 0.25 + q * 0.55 : 0.001);
      o.updateMatrix();
      this.smoke.setMatrixAt(i, o.matrix);
    }
    this.smoke.instanceMatrix.needsUpdate = true;
  }

  private updateSparkles(t: number): void {
    const o = this.tmp;
    let n = 0;
    for (const p of this.pieces) {
      const since = t - p.at;
      if (since < 0 || since > 1.1) continue;
      for (let k = 0; k < 14 && n < SPARKS; k++) {
        const a = hash2(k, Math.round(p.at * 10), 3) * Math.PI * 2;
        const up = 2 + hash2(k, 7, 3) * 3;
        const r = since * (3 + hash2(k, 8, 3) * 3);
        o.position.set(p.group.position.x + Math.cos(a) * r, p.group.position.y + 1 + since * up - since * since * 3, p.group.position.z + Math.sin(a) * r);
        o.rotation.set(t * 4 + k, t * 3, 0);
        o.scale.setScalar(0.22 * (1 - since / 1.1));
        o.updateMatrix();
        this.sparkles.setMatrixAt(n++, o.matrix);
      }
    }
    this.sparkles.count = n;
    this.sparkles.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- build

  private build(): void {
    const toy = toyMaterial(this.uTime, { clouds: true, rim: 0.35 });
    const scene = this.scene;

    // The island: a grassy top with soft rounded edges over a cliff of earth.
    const top = new THREE.CylinderGeometry(ISLAND, ISLAND - 0.6, 1.2, 64, 2);
    top.translate(0, -0.6, 0);
    const land = new THREE.Mesh(shaded(top, PAL.grassLight, PAL.grass, -1.2, 0), toy);
    land.receiveShadow = true;
    scene.add(land);
    const cliff = new THREE.CylinderGeometry(ISLAND - 0.5, ISLAND * 0.55, 7, 48, 3);
    cliff.translate(0, -4.6, 0);
    const pos = cliff.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const n = 1 + (hash2(Math.round(x * 3), Math.round(z * 3), 2) - 0.5) * 0.08;
      pos.setX(i, x * n);
      pos.setZ(i, z * n);
    }
    cliff.computeVertexNormals();
    scene.add(new THREE.Mesh(shaded(cliff, 0xb8875a, 0x7a5236, -8, -1.2), toy));

    // Always there: the paddock with its fence, the flock, the dog, a few trees.
    const parts: THREE.BufferGeometry[] = [];
    const fenceRing = (cx: number, cz: number, r: number, gapFrom: number, gapTo: number) => {
      const n = 22;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        if (a > gapFrom && a < gapTo) continue;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        const post = new RoundedBoxGeometry(0.26, 1.1, 0.26, 2, 0.1);
        post.translate(x, 0.55, z);
        parts.push(shaded(post, PAL.wood, PAL.woodDark, 0, 1.1));
        const a2 = ((i + 1) / n) * Math.PI * 2;
        if (i < n && !(a2 > gapFrom && a2 < gapTo)) {
          const x2 = cx + Math.cos(a2) * r;
          const z2 = cz + Math.sin(a2) * r;
          for (const hgt of [0.42, 0.86]) {
            const len = Math.hypot(x2 - x, z2 - z);
            const rail = new RoundedBoxGeometry(len, 0.16, 0.12, 2, 0.05);
            rail.rotateY(-Math.atan2(z2 - z, x2 - x));
            rail.translate((x + x2) / 2, hgt, (z + z2) / 2);
            parts.push(shaded(rail, PAL.wood, PAL.woodDark, hgt - 0.08, hgt + 0.08));
          }
        }
      }
    };
    fenceRing(PADDOCK.x, PADDOCK.z, PADDOCK.r, 0.2, 0.75);
    for (const [x, z, r] of [[-15, -6, 1.9], [-12, -12, 1.6], [14, -11, 2.0], [-16, 7, 1.6], [15.5, 6, 1.5]]) parts.push(...puffyTree(x, 0, -z, r, Math.round(x * 7 + z)));
    for (const [x, z] of [[-9, 13], [10, 14], [-3, 16]]) parts.push(stoneBlob(x, 0.3, -z, 0.7, Math.round(x * 3 + z)));
    const base = new THREE.Mesh(mergeGeometries(parts), toy);
    base.castShadow = true;
    base.receiveShadow = true;
    scene.add(base);

    // Sheep in the paddock.
    const geos = sheepGeometry();
    const inst = (geo: THREE.BufferGeometry) => {
      const im = new THREE.InstancedMesh(geo, toy, 11);
      im.castShadow = true;
      im.frustumCulled = false;
      scene.add(im);
      return im;
    };
    this.wool = inst(geos.wool);
    this.faces = inst(geos.face);
    this.legsA = inst(geos.legsA);
    this.legsB = inst(geos.legsB);
    const c = new THREE.Color();
    for (let i = 0; i < 11; i++) {
      const a = hash2(i, 1, 5) * Math.PI * 2;
      const r = Math.sqrt(hash2(i, 2, 5)) * (PADDOCK.r - 1.6);
      this.sheep.push({ x: PADDOCK.x + Math.cos(a) * r, z: PADDOCK.z + Math.sin(a) * r, a: hash2(i, 3, 5) * 6, phase: i, hop: 0 });
      this.wool.setColorAt(i, c.set(i === 6 ? 0x75675f : 0xffffff));
    }

    this.dog = dogModel(toy);
    scene.add(this.dog.root);
    this.cap = flatCap(toy);
    this.dog.head.add(this.cap);

    // Things you build, popping in on the BUILD timeline.
    this.piece(barn(toy), BARN, BUILD.barn);
    this.piece(cottage(toy), COTTAGE, BUILD.cottage);
    const garden = new THREE.Group();
    const gparts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 7; k++) gparts.push(...bush(-4 + k * 1.5, 0, -(-1 + Math.sin(k) * 0.4), 0.7, k + 40));
    for (let k = 0; k < 2; k++) gparts.push(...puffyTree(-9 + k * 16, 0, 2.5, 1.5, k + 60));
    const gm = new THREE.Mesh(mergeGeometries(gparts), toy);
    gm.castShadow = true;
    garden.add(gm);
    this.piece(garden, { x: 0, z: 1 }, BUILD.garden);
    this.piece(pond(toy, this.uTime), POND, BUILD.pond);

    // Chimney smoke and build sparkles.
    this.smoke = new THREE.InstancedMesh(blob(1, 2), new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }), 8);
    this.smoke.frustumCulled = false;
    scene.add(this.smoke);
    this.sparkles = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({ color: 0xffe14d }),
      SPARKS,
    );
    this.sparkles.frustumCulled = false;
    this.sparkles.count = 0;
    scene.add(this.sparkles);

    // A few soft clouds drifting below the island's edge for depth.
    const cl: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      const r = 30 + hash2(k, 9, 9) * 12;
      for (let j = 0; j < 4; j++) {
        const b = blob(2.2 + hash2(k, j, 9) * 1.8, 2);
        b.scale(1.6, 0.8, 1.1);
        b.translate(Math.cos(a) * r + j * 2.4, -6 - hash2(k, 4, 9) * 6 + j * 0.3, Math.sin(a) * r);
        cl.push(shaded(b, 0xffffff, 0xd8ecff, -12, 0));
      }
    }
    scene.add(new THREE.Mesh(mergeGeometries(cl), new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x4a5a70 })));
  }

  private piece(group: THREE.Group, at: { x: number; z: number }, time: number): void {
    group.position.set(at.x, 0, at.z);
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.scene.add(group);
    this.pieces.push({ group, at: time });
  }
}

const ISLAND = 19;
const SPARKS = 60;
const PADDOCK = { x: -5.5, z: 6.5, r: 6.2 };
const BARN = { x: 6.5, z: -7 };
const COTTAGE = { x: -7, z: -8 };
const POND = { x: 9.5, z: 7 };
const CHIMNEY = { x: COTTAGE.x + 2.2, y: 5.9, z: COTTAGE.z - 0.5 };

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Overshooting pop: 0 before, then springs up past full size and settles. */
function popScale(since: number): number {
  if (since <= 0) return 0;
  if (since >= 0.7) return 1;
  const q = since / 0.7;
  const c = 2.2;
  return 1 + (c + 1) * Math.pow(q - 1, 3) + c * Math.pow(q - 1, 2);
}

function mesh(parts: THREE.BufferGeometry[], mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(mergeGeometries(parts), mat);
}

/** Classic red barn with white trim and a rounded dark roof. */
function barn(mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const p: THREE.BufferGeometry[] = [];
  const body = new RoundedBoxGeometry(6.4, 4, 5, 3, 0.35);
  body.translate(0, 2, 0);
  p.push(shaded(body, 0xe0483e, 0xa82c27, 0, 4));
  // Roof: two rounded slabs meeting at the ridge, with a white ridge cap.
  for (const s of [-1, 1]) {
    const slab = new RoundedBoxGeometry(4.3, 0.42, 5.9, 2, 0.16);
    slab.rotateZ(-s * 0.62);
    slab.translate(s * 1.72, 5.05, 0);
    p.push(shaded(slab, 0x6b5a63, 0x4a3d44, 3.8, 6.3));
  }
  const ridge = new THREE.CapsuleGeometry(0.2, 5.6, 4, 10);
  ridge.rotateX(Math.PI / 2);
  ridge.translate(0, 6.32, 0);
  p.push(colored(ridge, new THREE.Color(0xfff6ea)));
  const door = new RoundedBoxGeometry(2.4, 2.8, 0.2, 2, 0.08);
  door.translate(0, 1.4, 2.55);
  p.push(colored(door, new THREE.Color(0xfff6ea)));
  for (const s of [-1, 1]) {
    const x = new RoundedBoxGeometry(0.22, 3.3, 0.22, 1, 0.05);
    x.rotateZ(s * 0.72);
    x.translate(0, 1.4, 2.68);
    p.push(colored(x, new THREE.Color(0xfff6ea)));
  }
  const loft = new RoundedBoxGeometry(1.3, 1.1, 0.2, 2, 0.08);
  loft.translate(0, 3.5, 2.55);
  p.push(colored(loft, new THREE.Color(0xfff6ea)));
  const bale = new THREE.CylinderGeometry(0.6, 0.6, 1, 16);
  bale.rotateX(Math.PI / 2);
  bale.translate(3.9, 0.6, 2.2);
  p.push(shaded(bale, 0xf5d77e, 0xc99a3e, 0, 1.2));
  const bale2 = bale.clone().translate(0.2, 1.15, -0.3);
  p.push(shaded(bale2, 0xf5d77e, 0xc99a3e, 1.1, 2.4));
  g.add(mesh(p, mat));
  return g;
}

/** Whitewashed Irish cottage with a golden thatch, blue door and a stone chimney. */
function cottage(mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const p: THREE.BufferGeometry[] = [];
  const walls = new RoundedBoxGeometry(6, 3, 3.8, 3, 0.3);
  walls.translate(0, 1.5, 0);
  p.push(shaded(walls, 0xffffff, 0xe6e0d4, 0, 3));
  const thatch = blob(2.4, 3, 0.08, 4);
  thatch.scale(1.42, 0.62, 0.98);
  thatch.translate(0, 3.25, 0);
  p.push(shaded(thatch, 0xf2c66a, 0xc08a3a, 2.4, 5.2));
  const door = new RoundedBoxGeometry(1.0, 1.9, 0.2, 2, 0.12);
  door.translate(-0.6, 0.95, 1.92);
  p.push(colored(door, new THREE.Color(0x3a7bd5)));
  for (const x of [-2.1, 1.3]) {
    const win = new RoundedBoxGeometry(0.95, 0.85, 0.15, 2, 0.08);
    win.translate(x, 1.65, 1.95);
    p.push(colored(win, new THREE.Color(0x9fd8ff)));
    const sill = new RoundedBoxGeometry(1.15, 0.14, 0.3, 1, 0.05);
    sill.translate(x, 1.18, 2.0);
    p.push(colored(sill, new THREE.Color(0xd9534f)));
    // Window box of flowers.
    for (let k = 0; k < 4; k++) {
      const f = blob(0.13, 1);
      f.translate(x - 0.4 + k * 0.27, 1.3, 2.1);
      p.push(colored(f, new THREE.Color(k % 2 ? 0xff7aa8 : 0xffe14d)));
    }
  }
  p.push(stoneBlob(CHIMNEY.x - COTTAGE.x, 4.3, -(CHIMNEY.z - COTTAGE.z), 0.55, 3));
  p.push(stoneBlob(CHIMNEY.x - COTTAGE.x, 5.0, -(CHIMNEY.z - COTTAGE.z), 0.48, 5));
  g.add(mesh(p, mat));
  return g;
}

function pond(mat: THREE.Material, time: { value: number }): THREE.Group {
  const g = new THREE.Group();
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(3.2, 40).rotateX(-Math.PI / 2).scale(1.3, 1, 1).translate(0, 0.04, 0),
    toyMaterial(time, { water: true }, new THREE.MeshPhongMaterial({ color: PAL.water, specular: 0xcffaff, shininess: 60 })),
  );
  g.add(water);
  const p: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    p.push(stoneBlob(Math.cos(a) * 4.2, 0.12, -Math.sin(a) * 3.3, 0.45 + hash2(k, 1, 1) * 0.2, k));
  }
  // Lily pads and a duck.
  for (let k = 0; k < 3; k++) {
    const pad = new THREE.CylinderGeometry(0.45, 0.45, 0.05, 14);
    pad.translate(-1.5 + k * 1.3, 0.08, -(0.8 - k * 0.7));
    p.push(colored(pad, new THREE.Color(0x4fae3a)));
  }
  const duck = blob(0.42, 2);
  duck.scale(1.3, 0.8, 1);
  duck.translate(1, 0.35, 0.3);
  p.push(colored(duck, new THREE.Color(0xfff6dc)));
  const head = blob(0.24, 2);
  head.translate(1.45, 0.75, 0.3);
  p.push(colored(head, new THREE.Color(0xfff6dc)));
  const beak = blob(0.1, 1);
  beak.scale(1.6, 0.6, 1);
  beak.translate(1.7, 0.7, 0.3);
  p.push(colored(beak, new THREE.Color(0xff9a2e)));
  g.add(mesh(p, mat));
  return g;
}

/** A tweed flat cap, sized for the collie's head. */
function flatCap(mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const crown = blob(0.2, 2);
  crown.scale(1.25, 0.45, 1.1);
  crown.translate(0.05, 0.27, 0);
  const brim = blob(0.13, 2);
  brim.scale(1.2, 0.25, 1.3);
  brim.translate(0.24, 0.22, 0);
  g.add(new THREE.Mesh(mergeGeometries([shaded(crown, 0x6f8f4a, 0x4a6a32, 0.2, 0.36), colored(brim, new THREE.Color(0x4a6a32))]), mat));
  return g;
}
