import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Meadow, streamYAt } from '../game/meadow';
import { MeadowDef } from '../game/meadowLevels';
import { clamp, hash2, segmentT, smoothNoise } from '../game/math';

/**
 * "Sunny Irish toy diorama" view of a round-up meadow.
 *
 * Style rules (keep every asset to these):
 * - Soft, chunky, rounded shapes. No hard corners, no flat facets.
 * - Every object carries a vertical colour gradient (darker underneath, lit on top)
 *   and a soft warm rim light, so it reads like a painted toy.
 * - Bright, saturated palette (PAL below). Detail goes on the characters and the pen;
 *   the field stays calm so every sheep reads at a glance.
 *
 * Only draws: the herding simulation is the same 2D sim as before. Sim
 * coordinates (x, y) map to three.js (x, height, -y), so +y up the field is
 * "into the screen". Rolling hills are visual only.
 */

const PAL = {
  grass: 0x5fb43c,
  grassLight: 0x9fd85a,
  grassDark: 0x3c8f30,
  bank: 0xd8c08a,
  water: 0x2fc6dd,
  foam: 0xeafcff,
  stone: 0xd7c7a8,
  stoneDark: 0xa8977a,
  wood: 0xc07d43,
  woodDark: 0x8a5530,
  straw: 0xf0d27a,
  leaf: 0x7fd14a,
  leafDark: 0x2f8a35,
  trunk: 0x8a5a33,
  wool: 0xfffaf0,
  woolShade: 0xe6dccb,
  face: 0x3a2f2c,
  collie: 0x23242c,
  collieWhite: 0xfbfaf5,
  tongue: 0xff8fa3,
  nose: 0xf2a0a0,
};

export class Meadow3D {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 0.5, 1, 400);
  private sun = new THREE.DirectionalLight(0xfff1d6, 2.3);
  private hemi = new THREE.HemisphereLight(0xcfeaff, 0x6a9a3a, 1.25);
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private world: THREE.Group | null = null;
  private terrain: THREE.Mesh | null = null;
  /** Seconds, shared by the cloud-shadow, grass-sway and water shaders. */
  private uTime = { value: 0 };
  /** When each sheep was first seen in the pen, for its hop over the threshold. */
  private pennedAt = new Map<number, number>();
  private dust: THREE.InstancedMesh | null = null;
  private puffs: { x: number; y: number; h: number; vx: number; vy: number; life: number; max: number; size: number }[] = [];
  private woolColor = new THREE.Color();
  private dustT = 0;
  private wool: THREE.InstancedMesh | null = null;
  private faces: THREE.InstancedMesh | null = null;
  /** Simpler sheep for when the camera has pulled right out over a huge flock. */
  private woolLo: THREE.InstancedMesh | null = null;
  private facesLo: THREE.InstancedMesh | null = null;
  private lo = false;
  private gates: { group: THREE.Group; panel: THREE.Mesh }[] = [];
  /** Legs in diagonal pairs (front-left + back-right, and the other two), swung in opposite phase. */
  private legsA: THREE.InstancedMesh | null = null;
  private legsB: THREE.InstancedMesh | null = null;
  private dog: DogRig | null = null;
  private dogStride = 0;
  private crouch = 0;
  private barkT = -9;
  private lastCooldown = 0;
  private lastT = 0;
  private local = new THREE.Matrix4();
  private world4 = new THREE.Matrix4();
  private def: MeadowDef | null = null;
  private heights: (x: number, y: number) => number = () => 0;
  /** Bridge decks, so animals walk over the planks instead of through them. */
  private decks: { x0: number; x1: number; y0: number; y1: number; top: number }[] = [];
  private tmp = new THREE.Object3D();
  private tmpV = new THREE.Vector3();
  private w = 1;
  private h = 1;
  private composer: EffectComposer;
  private blurX: ShaderPass;
  private blurY: ShaderPass;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    // Neutral keeps the greens and turquoise vivid where ACES would wash them out.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -38;
    sc.right = 38;
    sc.top = 38;
    sc.bottom = -38;
    sc.near = 1;
    sc.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 5;
    this.sun.shadow.blurSamples = 10;
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.scene.fog = new THREE.Fog(0xbfe6ff, 70, 170);

    // Tilt-shift: the far edge of the field softens, like a photo of a tabletop
    // model. Two blur passes in linear HDR, then tone mapping and colour space.
    const samples = Number(new URLSearchParams(location.search).get('msaa') ?? 4);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.blurX = new ShaderPass(TILT_SHIFT);
    this.blurY = new ShaderPass(TILT_SHIFT);
    this.blurY.uniforms.dir.value.set(0, 1);
    this.composer.addPass(this.blurX);
    this.composer.addPass(this.blurY);
    this.composer.addPass(new OutputPass());
  }

  /** Highest device pixel ratio to render at (raised for ad recording). */
  private maxDpr = 2;
  private lastDpr = 1;

  setMaxDpr(v: number): void {
    this.maxDpr = v;
    this.resize(this.w, this.h, this.lastDpr);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.w = cssW;
    this.h = cssH;
    this.lastDpr = dpr;
    this.renderer.setPixelRatio(Math.min(dpr, this.maxDpr));
    this.renderer.setSize(cssW, cssH, false);
    this.composer.setPixelRatio(Math.min(dpr, this.maxDpr));
    this.composer.setSize(cssW, cssH);
    const px = Math.min(dpr, this.maxDpr);
    this.blurX.uniforms.texel.value.set(1 / (cssW * px), 1 / (cssH * px));
    this.blurY.uniforms.texel.value.set(1 / (cssW * px), 1 / (cssH * px));
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
  }

  // --------------------------------------------------------------- frame

  render(m: Meadow, t: number): void {
    if (m.def !== this.def) this.build(m);
    this.uTime.value = t;
    this.updateCamera(m);
    this.updateLight(m);
    this.updateSheep(m, t);
    this.updateDog(m, t);
    this.updateDust();
    this.composer.render();
  }

  /** Screen position (CSS px within the canvas) of a sim point, for 2D overlays. */
  project = (x: number, y: number): [number, number] => {
    const v = this.tmpV.set(x, this.heights(x, y) + 1, -y).project(this.camera);
    return [((v.x + 1) / 2) * this.w, ((1 - v.y) / 2) * this.h];
  };

  /** The sim point under a screen position (CSS px within the canvas), or null. */
  pick(px: number, py: number): { x: number; y: number } | null {
    if (!this.terrain) return null;
    this.ndc.set((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    if (hit) return { x: hit.point.x, y: -hit.point.z };
    // Off the terrain: fall back to the flat ground plane.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = this.raycaster.ray.intersectPlane(plane, this.tmpV);
    return p ? { x: p.x, y: -p.z } : null;
  }

  private updateCamera(m: Meadow): void {
    // Look at the sim's camera centre from behind and above (3/4 view), far
    // enough that roughly the sim's view width fits across the screen.
    const pitch = THREE.MathUtils.degToRad(50);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (m.viewW * 0.88) / (2 * Math.tan(hfov / 2));
    const tx = m.camX;
    const ty = m.camY;
    const th = this.heights(tx, ty);
    this.camera.position.set(tx, th + Math.sin(pitch) * dist, -ty + Math.cos(pitch) * dist);
    this.camera.lookAt(tx, th, -ty);
    this.camera.far = dist * 3.5;
    this.camera.updateProjectionMatrix();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = dist * 1.5;
    fog.far = dist * 3.4;
  }

  /** Afternoon → golden hour → dusk, driven by the round-up timer. */
  private updateLight(m: Meadow): void {
    const p = clamp(m.time / m.limit, 0, 1);
    const elev = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(55, 14, Math.pow(p, 1.2)));
    const azim = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(-35, -70, p));
    const sunCol = gradient(p, [
      [0, 0xfff3dc],
      [0.55, 0xffe0a8],
      [0.85, 0xffbf7a],
      [1, 0xffa477],
    ]);
    const sky = gradient(p, [
      [0, 0xa8e0ff],
      [0.55, 0xd2e8f0],
      [0.8, 0xffe0b8],
      [0.92, 0xffc8a0],
      [1, 0xd8b0e0],
    ]);
    const ground = gradient(p, [
      [0, 0x6a9a3a],
      [0.7, 0x8a9a48],
      [0.9, 0x9a8458],
      [1, 0x6a5a80],
    ]);
    this.sun.color.copy(sunCol);
    // A low sun lights the field at a grazing angle, so push it harder to keep the gold glow.
    this.sun.intensity = THREE.MathUtils.lerp(2.3, 3.1, smooth(0.45, 0.85, p)) - smooth(0.9, 1, p) * 0.9;
    this.hemi.color.copy(sky);
    this.hemi.groundColor.copy(ground);
    this.hemi.intensity = THREE.MathUtils.lerp(1.25, 1.1, smooth(0.75, 1, p));
    this.scene.background = sky.clone();
    (this.scene.fog as THREE.Fog).color.copy(sky);

    const tx = m.camX;
    const ty = m.camY;
    const d = 60;
    this.sun.position.set(
      tx + Math.cos(elev) * Math.sin(azim) * d,
      Math.sin(elev) * d,
      -ty + Math.cos(elev) * Math.cos(azim) * d,
    );
    this.sun.target.position.set(tx, 0, -ty);
    this.sun.target.updateMatrixWorld();
  }

  /** Where an animal's feet go: the ground, or the bridge deck when it's on one. */
  private standAt(x: number, y: number): number {
    let h = this.heights(x, y);
    for (const d of this.decks) if (x > d.x0 && x < d.x1 && y > d.y0 && y < d.y1) h = Math.max(h, d.top);
    return h;
  }

  /** A little cloud of dust kicked up at a sim point. */
  private puff(x: number, y: number, size: number): void {
    if (this.puffs.length >= DUST_MAX) return;
    const a = Math.random() * Math.PI * 2;
    this.puffs.push({ x, y, h: this.standAt(x, y) + 0.15, vx: Math.cos(a) * 0.4, vy: Math.sin(a) * 0.4, life: 0, max: 0.6 + Math.random() * 0.4, size });
  }

  private updateDust(): void {
    const dust = this.dust;
    if (!dust) return;
    const dt = clamp(this.uTime.value - this.dustT, 0, 0.1);
    this.dustT = this.uTime.value;
    this.puffs = this.puffs.filter((p) => (p.life += dt) < p.max);
    const o = this.tmp;
    this.puffs.forEach((p, i) => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.h += 0.5 * dt;
      const q = p.life / p.max;
      // Swell quickly, then shrink away.
      const sc = p.size * Math.min(1, q * 5) * (1 - q * q);
      o.position.set(p.x, p.h, -p.y);
      o.rotation.set(q * 2, q * 3, 0);
      o.scale.setScalar(Math.max(0.001, sc));
      o.updateMatrix();
      dust.setMatrixAt(i, o.matrix);
    });
    dust.count = this.puffs.length;
    dust.instanceMatrix.needsUpdate = true;
  }

  private updateSheep(m: Meadow, t: number): void {
    // Switch detail with a little hysteresis so it doesn't flicker.
    if (!this.lo && m.viewW > 31) this.lo = true;
    else if (this.lo && m.viewW < 29) this.lo = false;
    this.wool!.visible = this.faces!.visible = !this.lo;
    this.woolLo!.visible = this.facesLo!.visible = this.lo;
    const wool = this.lo ? this.woolLo! : this.wool!;
    const faces = this.lo ? this.facesLo! : this.faces!;
    const legsA = this.legsA!;
    const legsB = this.legsB!;
    const o = this.tmp;
    let n = 0;
    for (const s of m.sheep) {
      if (s.state === 'lost') continue;
      const speed = Math.hypot(s.vx, s.vy);
      const trot = Math.min(1, speed / 3);
      // s.phase advances faster the faster the sheep moves, so stride follows speed.
      const stride = s.phase * 3;
      let bob = Math.abs(Math.sin(stride)) * 0.12 * trot;
      let tilt = Math.sin(stride) * 0.05 * trot;
      if (s.state === 'penned') {
        // A happy hop over the threshold, then the odd skip of joy while they mill about.
        if (!this.pennedAt.has(s.id)) this.pennedAt.set(s.id, t);
        const since = t - this.pennedAt.get(s.id)!;
        const hop = since < 0.5 ? Math.sin((since / 0.5) * Math.PI) * 0.9 : 0;
        const joy = Math.max(0, Math.sin(t * 2.1 + s.id * 2.39) - 0.93) * 6;
        bob += hop + joy;
        tilt += hop * 0.4;
      } else if (speed > 3.2 && Math.random() < speed * 0.012) {
        this.puff(s.x - Math.cos(s.heading) * 0.5, s.y - Math.sin(s.heading) * 0.5, 0.45 + Math.random() * 0.3);
      }
      o.position.set(s.x, this.standAt(s.x, s.y) + bob, -s.y);
      o.rotation.set(0, s.heading, tilt);
      const k = (s.lamb ? 0.68 : 1) * (0.92 + hash2(s.id, 1, 9) * 0.16);
      o.scale.set(k, k, k);
      o.updateMatrix();
      wool.setMatrixAt(n, o.matrix);
      // Roughly one in twelve is a black sheep.
      wool.setColorAt(n, this.woolColor.set(s.id % 12 === 7 ? 0x75675f : 0xffffff));

      // Heads dip to graze now and then when the sheep is standing about.
      const idle = s.state === 'penned' ? 0 : clamp(1 - speed / 0.4, 0, 1);
      const graze = idle * smooth(0.2, 0.7, Math.sin(t * 0.45 + s.id * 1.7));
      // Rotate about the neck: R, then shift so the pivot stays put.
      const ga = -graze * 0.75;
      const gc = Math.cos(ga);
      const gs = Math.sin(ga);
      this.local.makeRotationZ(ga).setPosition(NECK.x - (gc * NECK.x - gs * NECK.y), NECK.y - (gs * NECK.x + gc * NECK.y), 0);
      faces.setMatrixAt(n, this.world4.multiplyMatrices(o.matrix, this.local));

      // Legs pivot at the hip; a grazing sheep's legs barely move.
      const swing = Math.sin(stride) * (0.08 + 0.55 * trot);
      this.local.makeRotationZ(swing).setPosition(0, SHEEP_HIP, 0);
      legsA.setMatrixAt(n, this.world4.multiplyMatrices(o.matrix, this.local));
      this.local.makeRotationZ(-swing).setPosition(0, SHEEP_HIP, 0);
      legsB.setMatrixAt(n, this.world4.multiplyMatrices(o.matrix, this.local));
      n++;
    }
    for (const im of [wool, faces, legsA, legsB]) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    }
    if (wool.instanceColor) wool.instanceColor.needsUpdate = true;
    // Gates shimmer.
    this.gates.forEach((g, i) => {
      (g.panel.material as THREE.MeshBasicMaterial).opacity = 0.42 + Math.sin(t * 3 + i) * 0.08;
    });
  }

  private updateDog(m: Meadow, t: number): void {
    const d = m.dog;
    const rig = this.dog!;
    const speed = Math.hypot(d.vx, d.vy);
    const run = Math.min(1, speed / 4);
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.dogStride += dt * (2 + speed * 2.6);
    const st = this.dogStride;

    // The classic collie "eye": creeping up on sheep, he drops low and stares.
    let near = Infinity;
    for (const s of m.sheep) if (s.state === 'active') near = Math.min(near, Math.hypot(s.x - d.x, s.y - d.y));
    const wantCrouch = speed < 2.6 && near < m.stats.presence + 1.5 ? 1 : 0;
    this.crouch += (wantCrouch - this.crouch) * Math.min(1, dt * 6);
    const cr = this.crouch;

    if (d.barkCooldown > this.lastCooldown + 0.05) this.barkT = t;
    this.lastCooldown = d.barkCooldown;
    const bark = clamp(1 - (t - this.barkT) / 0.35, 0, 1);
    const barkHop = Math.sin(bark * Math.PI) * 0.22;

    rig.root.position.set(d.x, this.standAt(d.x, d.y) + Math.abs(Math.sin(st)) * 0.14 * run + barkHop, -d.y);
    rig.root.rotation.set(0, d.heading, Math.sin(st) * 0.03 * run);
    rig.torso.position.y = DOG_TORSO_Y - cr * 0.14 + Math.sin(st * 2) * 0.02 * run;
    rig.torso.rotation.z = Math.sin(st) * 0.08 * run - cr * 0.05;
    // Head: low and forward in the crouch, up when barking, bobbing as he runs.
    rig.head.rotation.z = -cr * 0.35 + bark * 0.35 + Math.sin(st + 0.6) * 0.06 * run;
    rig.head.position.y = DOG_HEAD.y - cr * 0.05;
    // Gallop-ish: diagonal pairs swing in opposite phase; crouched legs splay a little.
    const swing = Math.sin(st) * (0.1 + 0.75 * run);
    rig.legs.forEach((leg, i) => {
      leg.rotation.z = (i === 0 || i === 3 ? swing : -swing) + (i < 2 ? cr * 0.35 : -cr * 0.35);
      leg.scale.y = 1 - cr * 0.25;
    });
    // Tail streams out when running, drops when stalking, wags when happy.
    rig.tail.rotation.z = 0.35 - cr * 0.7 - run * 0.25;
    rig.tail.rotation.y = Math.sin(t * (6 + run * 10)) * 0.6 * (1 - cr * 0.8);
    // Panting when he's not stalking.
    rig.tongue.scale.y = (1 - cr) * (0.8 + Math.sin(t * 14) * 0.25);
    rig.tongue.visible = cr < 0.7;

    if (speed > 4.5 && Math.random() < 0.25) this.puff(d.x - Math.cos(d.heading) * 0.6, d.y - Math.sin(d.heading) * 0.6, 0.35);
  }

  // ---------------------------------------------------------------- build

  private build(m: Meadow): void {
    if (this.world) {
      this.scene.remove(this.world);
      this.world.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
    this.def = m.def;
    const def = m.def;
    const g = new THREE.Group();
    this.world = g;
    this.scene.add(g);
    this.heights = makeHeights(def);
    this.decks = [];
    this.pennedAt.clear();
    this.puffs = [];
    const toy = toyMaterial(this.uTime, { clouds: true, rim: 0.35 });

    this.buildTerrain(def, g);
    this.buildWater(def, g, toy);
    this.buildPen(m, g, toy);
    this.buildScenery(def, g, toy);
    this.buildGrass(def, g);

    // Sheep: instanced wool (tinted per sheep), face, and two pairs of legs.
    const geos = sheepGeometry();
    const cap = Math.max(1, m.sheep.length, m.def.snowball?.maxSheep ?? 0);
    const inst = (geo: THREE.BufferGeometry) => {
      const im = new THREE.InstancedMesh(geo, toy, cap);
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      g.add(im);
      return im;
    };
    this.wool = inst(geos.wool);
    this.wool.setColorAt(0, this.woolColor.set(0xffffff));
    this.faces = inst(geos.face);
    this.woolLo = inst(geos.woolLo);
    this.woolLo.setColorAt(0, this.woolColor.set(0xffffff));
    this.facesLo = inst(geos.faceLo);
    this.legsA = inst(geos.legsA);
    this.legsB = inst(geos.legsB);

    this.dust = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshLambertMaterial({ color: 0xf2e6c8, emissive: 0x6b5f45, transparent: true, opacity: 0.55, depthWrite: false }),
      DUST_MAX,
    );
    this.dust.count = 0;
    this.dust.frustumCulled = false;
    g.add(this.dust);

    this.dog = dogModel(toy);
    g.add(this.dog.root);

    this.gates = (def.gates ?? []).map((gd) => {
      const gate = gateModel(gd.x1 - gd.x0, gd.kind, gd.n, toy);
      const cx = (gd.x0 + gd.x1) / 2;
      gate.group.position.set(cx, Math.max(this.heights(gd.x0, gd.y), this.heights(gd.x1, gd.y), this.heights(cx, gd.y)), -gd.y);
      g.add(gate.group);
      return gate;
    });
  }

  private buildTerrain(def: MeadowDef, g: THREE.Group): void {
    // A smooth, finely divided sheet: the field plus a rising bank all round it.
    const pad = 30;
    const W = def.width + pad * 2;
    const H = def.height + pad * 2;
    const geo = new THREE.PlaneGeometry(W, H, Math.round(W / 1.1), Math.round(H / 1.1));
    geo.rotateX(-Math.PI / 2);
    geo.translate(def.width / 2, 0, -def.height / 2);
    geo.deleteAttribute('uv');
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const shade = contactShade(def, this.pennedBox());
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = -pos.getZ(i);
      const h = this.heights(x, y);
      pos.setY(i, h);
      groundColor(def, x, y, h, c);
      c.multiplyScalar(shade(x, y));
      c.toArray(colors, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, toyMaterial(this.uTime, { clouds: true }));
    terrain.receiveShadow = true;
    g.add(terrain);
    this.terrain = terrain;
  }

  private pennedBox() {
    const p = this.def!.pen;
    return { left: p.x, right: p.x + p.w, bottom: p.y, top: p.y + p.h };
  }

  private buildWater(def: MeadowDef, g: THREE.Group, toy: THREE.Material): void {
    const water = toyMaterial(this.uTime, { water: true }, new THREE.MeshPhongMaterial({
      color: PAL.water,
      specular: 0xcffaff,
      shininess: 60,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    }));
    const foam = toyMaterial(this.uTime, { water: true }, new THREE.MeshLambertMaterial({ color: PAL.foam, transparent: true, opacity: 0.75, depthWrite: false }));
    for (const st of def.streams) {
      const x0 = st.points[0][0];
      const x1 = st.points[st.points.length - 1][0];
      // Ribbons along the stream: the water itself, and a foamy edge at each bank.
      const ribbon = (inner: number, outer: number, yLevel: number) => {
        const pts: number[] = [];
        const idx: number[] = [];
        const steps = 160;
        for (let i = 0; i <= steps; i++) {
          const x = x0 - 2 + ((x1 - x0 + 4) * i) / steps;
          const y = streamYAt(st, clamp(x, x0, x1));
          pts.push(x, yLevel, -(y + inner), x, yLevel, -(y + outer));
          if (i < steps) {
            const a = i * 2;
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        return geo;
      };
      const half = st.width / 2 + 0.6;
      const waterMesh = new THREE.Mesh(ribbon(-half, half, -0.5), water);
      waterMesh.receiveShadow = true;
      g.add(waterMesh);
      for (const side of [-1, 1]) {
        const fm = new THREE.Mesh(ribbon(side * (half - 0.7), side * (half + 0.15), -0.46), foam);
        g.add(fm);
      }

      const parts: THREE.BufferGeometry[] = [];
      for (const br of st.bridges) {
        const y = streamYAt(st, br.x);
        const span = st.width + 3.4;
        // Deck sits level with the higher bank so it reads as a bridge, not a ramp.
        const deckY = Math.max(this.heights(br.x, y - span / 2), this.heights(br.x, y + span / 2), 0) + 0.25;
        this.decks.push({ x0: br.x - br.w / 2, x1: br.x + br.w / 2, y0: y - span / 2, y1: y + span / 2, top: deckY + 0.08 });
        const n = Math.round(span / 0.6);
        for (let i = 0; i < n; i++) {
          const z = -(y - span / 2) - (i + 0.5) * (span / n);
          const board = new RoundedBoxGeometry(br.w - 0.3, 0.18, span / n - 0.08, 2, 0.06);
          board.rotateY((hash2(i, 3, 7) - 0.5) * 0.05);
          board.translate(br.x, deckY, z);
          parts.push(shaded(board, i % 2 ? PAL.wood : 0xcf8c50, PAL.woodDark, deckY - 0.1, deckY + 0.1));
        }
        for (const side of [-1, 1]) {
          const x = br.x + side * (br.w / 2 - 0.1);
          const rail = new RoundedBoxGeometry(0.2, 0.2, span, 2, 0.08);
          rail.translate(x, deckY + 0.85, -y);
          parts.push(shaded(rail, PAL.wood, PAL.woodDark, deckY + 0.75, deckY + 0.95));
          for (let k = 0; k <= 3; k++) {
            const pz = -(y - span / 2) - (k * span) / 3;
            const p = new RoundedBoxGeometry(0.28, 1.05, 0.28, 2, 0.1);
            p.translate(x, deckY + 0.4, pz);
            parts.push(shaded(p, PAL.wood, PAL.woodDark, deckY - 0.1, deckY + 0.9));
            const cap = new THREE.SphereGeometry(0.17, 12, 8);
            cap.translate(x, deckY + 0.95, pz);
            parts.push(shaded(cap, 0xd8955a, PAL.wood, deckY + 0.85, deckY + 1.1));
          }
          // Round stone footings at each end, with a cap of grass.
          for (const end of [-1, 1]) {
            const sy = y + end * (span / 2 + 0.2);
            const sx = br.x + side * (br.w / 2 + 0.2);
            parts.push(stoneBlob(sx, this.heights(sx, sy) + 0.2, sy, 0.75, i32(sx, sy)));
          }
        }
      }
      if (parts.length) {
        const mesh = new THREE.Mesh(mergeGeometries(parts), toy);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        g.add(mesh);
      }
    }
  }

  private buildPen(m: Meadow, g: THREE.Group, toy: THREE.Material): void {
    const p = m.pen;
    const parts: THREE.BufferGeometry[] = [];
    // Straw floor with soft colour patches.
    const fw = p.right - p.left;
    const fh = p.top - p.bottom;
    const floor = new THREE.PlaneGeometry(fw, fh, Math.round(fw * 2), Math.round(fh * 2));
    floor.rotateX(-Math.PI / 2);
    floor.translate((p.left + p.right) / 2, 0, -(p.bottom + p.top) / 2);
    floor.deleteAttribute('uv');
    const fpos = floor.attributes.position as THREE.BufferAttribute;
    const fcol = new Float32Array(fpos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < fpos.count; i++) {
      const x = fpos.getX(i);
      const y = -fpos.getZ(i);
      fpos.setY(i, this.heights(x, y) + 0.06);
      const n = smoothNoise(x / 1.6, y / 1.6, 5) * 0.6 + hash2(Math.round(x * 4), Math.round(y * 4), 5) * 0.4;
      const edge = Math.min(x - p.left, p.right - x, y - p.bottom, p.top - y);
      c.set(PAL.straw).lerp(new THREE.Color(0xc9933f), n * 0.7).multiplyScalar(0.82 + 0.18 * smooth(0, 1.2, edge));
      c.toArray(fcol, i * 3);
    }
    floor.setAttribute('color', new THREE.BufferAttribute(fcol, 3));
    floor.computeVertexNormals();
    parts.push(floor.toNonIndexed());

    const fence = (ax: number, ay: number, bx: number, by: number) => {
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.1) return;
      const ang = Math.atan2(by - ay, bx - ax);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const h = this.heights(mx, my);
      for (const rh of [0.42, 0.88]) {
        const rail = new RoundedBoxGeometry(len, 0.18, 0.13, 2, 0.06);
        rail.rotateY(ang);
        rail.translate(mx, h + rh, -my);
        parts.push(shaded(rail, PAL.wood, PAL.woodDark, h + rh - 0.09, h + rh + 0.09));
      }
      const n = Math.max(1, Math.round(len / 1.9));
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const y = ay + ((by - ay) * i) / n;
        const ph = this.heights(x, y);
        const post = new RoundedBoxGeometry(0.26, 1.15, 0.26, 2, 0.1);
        post.translate(x, ph + 0.55, -y);
        parts.push(shaded(post, PAL.wood, PAL.woodDark, ph, ph + 1.1));
      }
    };
    const gatePost = (x: number, y: number) => {
      const h = this.heights(x, y);
      const post = new RoundedBoxGeometry(0.4, 1.5, 0.4, 2, 0.14);
      post.translate(x, h + 0.72, -y);
      parts.push(shaded(post, 0xcf8c50, PAL.woodDark, h, h + 1.4));
      const cap = new THREE.SphereGeometry(0.26, 14, 10);
      cap.translate(x, h + 1.55, -y);
      parts.push(shaded(cap, 0xffffff, 0xe0d8c8, h + 1.4, h + 1.8));
    };
    const side = (s: string, ax: number, ay: number, bx: number, by: number) => {
      if (s !== p.gate) return fence(ax, ay, bx, by);
      if (ay === by) {
        fence(ax, ay, p.gateA, by);
        fence(p.gateB, ay, bx, by);
        gatePost(p.gateA, ay);
        gatePost(p.gateB, ay);
      } else {
        fence(ax, ay, bx, p.gateA);
        fence(ax, p.gateB, bx, by);
        gatePost(ax, p.gateA);
        gatePost(ax, p.gateB);
      }
    };
    side('south', p.left, p.bottom, p.right, p.bottom);
    side('north', p.left, p.top, p.right, p.top);
    side('west', p.left, p.bottom, p.left, p.top);
    side('east', p.right, p.bottom, p.right, p.top);
    for (const w of p.wings) fence(w.ax, w.ay, w.bx, w.by);

    // A couple of hay bales in the back corner: cosy, and they say "home".
    const inX = p.gate === 'west' ? p.right - 1.1 : p.left + 1.1;
    const inY = p.gate === 'north' ? p.bottom + 1.0 : p.top - 1.0;
    for (const [dx, dz] of [[0, 0], [p.gate === 'west' ? -1.3 : 1.3, 0]]) {
      const bx = inX + dx;
      const by = inY + dz;
      const bale = new THREE.CylinderGeometry(0.55, 0.55, 0.9, 16, 1);
      bale.rotateX(Math.PI / 2);
      bale.translate(bx, this.heights(bx, by) + 0.55, -by);
      parts.push(shaded(bale, 0xf5d77e, 0xc99a3e, this.heights(bx, by), this.heights(bx, by) + 1.1));
    }

    const mesh = new THREE.Mesh(mergeGeometries(parts), toy);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }

  private buildScenery(def: MeadowDef, g: THREE.Group, toy: THREE.Material): void {
    const parts: THREE.BufferGeometry[] = [];
    const H = (x: number, y: number) => this.heights(x, y);

    for (const o of def.obstacles) {
      const h = H(o.x, o.y);
      const seed = i32(o.x, o.y);
      if (o.kind === 'tree') parts.push(...puffyTree(o.x, h, o.y, o.r, seed));
      else if (o.kind === 'rock') {
        parts.push(stoneBlob(o.x, h + o.r * 0.25, o.y, o.r, seed));
        parts.push(grassCap(o.x, h + o.r * 0.6, o.y, o.r * 0.95, seed));
      } else parts.push(...bush(o.x, h, o.y, o.r, seed));
    }

    // Dry-stone walls: fat rounded stones with grass growing along the top.
    for (const [ax, ay, bx, by] of def.walls) {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(len / 0.75));
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const y = ay + ((by - ay) * i) / n;
        const h = H(x, y);
        const r = hash2(i, Math.round(ax + ay), 11);
        parts.push(stoneBlob(x, h + 0.3, y, 0.5 - r * 0.08, i * 7 + 1));
        parts.push(stoneBlob(x + 0.35, h + 0.78, y + (r - 0.5) * 0.1, 0.42, i * 7 + 3));
        if (i % 2 === 0) parts.push(grassCap(x + 0.2, h + 1.1, y, 0.62, i));
      }
    }

    // Hedgerow round the field: soft, overlapping, cloud-like.
    const ring = (x: number, y: number, i: number) => {
      const r = 1.3 + hash2(i, 5, def.seed) * 0.6;
      parts.push(leafBlob(x, H(x, y) + r * 0.55, y, r, 0.9, i));
    };
    let i = 0;
    for (let x = -1; x <= def.width + 1; x += 2.0) {
      ring(x, -1.7, i++);
      ring(x, def.height + 1.7, i++);
    }
    for (let y = -1; y <= def.height + 1; y += 2.0) {
      ring(-1.7, y, i++);
      ring(def.width + 1.7, y, i++);
    }

    // Trees out beyond the hedge for depth.
    for (let k = 0; k < 44; k++) {
      const side = k % 4;
      const tt = hash2(k, 1, def.seed);
      const off = 5 + hash2(k, 2, def.seed) * 20;
      const x = side < 2 ? tt * def.width : side === 2 ? -off : def.width + off;
      const y = side >= 2 ? tt * def.height : side === 0 ? -off : def.height + off;
      parts.push(...puffyTree(x, H(x, y), y, 1.9 + hash2(k, 3, def.seed) * 1.3, k * 13));
    }

    const mesh = new THREE.Mesh(mergeGeometries(parts), toy);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }

  private buildGrass(def: MeadowDef, g: THREE.Group): void {
    const H = (x: number, y: number) => this.heights(x, y);
    const nearWater = (x: number, y: number) =>
      def.streams.some((st) => x > st.points[0][0] - 2 && Math.abs(y - streamYAt(st, x)) < st.width / 2 + 1.4);
    const p = def.pen;
    const inPen = (x: number, y: number) => x > p.x - 0.3 && x < p.x + p.w + 0.3 && y > p.y - 0.3 && y < p.y + p.h + 0.3;

    // Flowers: little daisies and buttercups.
    const petals: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const petal = new THREE.SphereGeometry(0.06, 6, 4);
      petal.scale(1.4, 0.4, 0.8);
      petal.rotateY(-a);
      petal.translate(Math.cos(a) * 0.07, 0.1, -Math.sin(a) * 0.07);
      petals.push(colored(petal, new THREE.Color(0xffffff)));
    }
    const centre = new THREE.SphereGeometry(0.045, 6, 4);
    centre.translate(0, 0.12, 0);
    petals.push(colored(centre, new THREE.Color(0xffd23a)));
    const flowerGeo = mergeGeometries(petals);
    // Density follows the field's size, within what a phone can draw.
    const area = def.width * def.height;
    const maxFlowers = Math.min(1800, Math.round(area * 0.21));
    const maxTufts = Math.min(6500, Math.round(area * 0.75));
    const flowers = new THREE.InstancedMesh(flowerGeo, toyMaterial(this.uTime, { clouds: true, sway: true }), maxFlowers);
    const fc = new THREE.Color();
    let nf = 0;
    for (let k = 0; k < maxFlowers * 1.6 && nf < maxFlowers; k++) {
      // Flowers grow in drifts, not evenly.
      const x = hash2(k, 7, def.seed) * def.width;
      const y = hash2(k, 8, def.seed) * def.height;
      if (smoothNoise(x / 9, y / 9, def.seed + 40) < 0.45 || nearWater(x, y) || inPen(x, y)) continue;
      this.tmp.position.set(x, H(x, y), -y);
      this.tmp.rotation.set(0, hash2(k, 9, def.seed) * 6, 0);
      this.tmp.scale.setScalar(0.9 + hash2(k, 10, def.seed) * 0.6);
      this.tmp.updateMatrix();
      flowers.setMatrixAt(nf, this.tmp.matrix);
      fc.set(k % 4 === 0 ? 0xffe14d : k % 9 === 0 ? 0xffa6c9 : 0xffffff);
      flowers.setColorAt(nf, fc);
      nf++;
    }
    flowers.count = nf;
    g.add(flowers);

    // Grass clumps: three curved blades, dark at the root and sunlit at the tip.
    const blades: THREE.BufferGeometry[] = [];
    for (let b = 0; b < 5; b++) {
      const tall = b === 0 ? 0.38 : 0.26 + (b % 2) * 0.06;
      const blade = new THREE.ConeGeometry(0.075, tall, 5, 3);
      blade.translate(0, tall / 2, 0);
      const pos = blade.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        pos.setX(i, pos.getX(i) + y * y * 0.9);
      }
      blade.rotateY((b / 5) * Math.PI * 2 + 0.4);
      blade.deleteAttribute('normal');
      blade.computeVertexNormals();
      blades.push(shaded(blade, 0xc4ee78, PAL.grass, 0, tall));
    }
    const tuftGeo = mergeGeometries(blades);
    const tufts = new THREE.InstancedMesh(tuftGeo, toyMaterial(this.uTime, { clouds: true, sway: true }), maxTufts);
    const tc = new THREE.Color();
    let nt = 0;
    for (let k = 0; k < maxTufts * 1.3 && nt < maxTufts; k++) {
      const x = hash2(k, 17, def.seed) * (def.width + 4) - 2;
      const y = hash2(k, 18, def.seed) * (def.height + 4) - 2;
      if (inPen(x, y) || nearWater(x, y)) continue;
      const s = 0.7 + hash2(k, 19, def.seed) * 0.8;
      this.tmp.position.set(x, H(x, y), -y);
      this.tmp.rotation.set(0, hash2(k, 20, def.seed) * 6, (hash2(k, 21, def.seed) - 0.5) * 0.3);
      this.tmp.scale.set(s, s * (0.8 + hash2(k, 22, def.seed) * 0.6), s);
      this.tmp.updateMatrix();
      tufts.setMatrixAt(nt, this.tmp.matrix);
      tc.setHSL(0, 0, 0.9 + hash2(k, 23, def.seed) * 0.2);
      tufts.setColorAt(nt, tc);
      nt++;
    }
    tufts.count = nt;
    tufts.receiveShadow = true;
    g.add(tufts);
  }
}

// ---------------------------------------------------------------- material

const DUST_MAX = 160;

/** One direction of a blur that grows toward the top (far) edge of the screen. */
const TILT_SHIFT = {
  name: 'TiltShift',
  uniforms: {
    tDiffuse: { value: null },
    dir: { value: new THREE.Vector2(1, 0) },
    texel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 dir;
    uniform vec2 texel;
    varying vec2 vUv;
    void main() {
      float amount = smoothstep(0.66, 1.0, vUv.y) * 2.1 + smoothstep(0.1, 0.0, vUv.y) * 0.9;
      vec2 step = dir * texel * amount;
      vec4 sum = texture2D(tDiffuse, vUv) * 0.2270;
      sum += texture2D(tDiffuse, vUv + step * 1.3846) * 0.3162;
      sum += texture2D(tDiffuse, vUv - step * 1.3846) * 0.3162;
      sum += texture2D(tDiffuse, vUv + step * 3.2308) * 0.0703;
      sum += texture2D(tDiffuse, vUv - step * 3.2308) * 0.0703;
      gl_FragColor = sum;
    }`,
};

interface Look {
  /** Drifting cloud shadows dim the sunlight. */
  clouds?: boolean;
  /** Sway in the wind (grass, flowers): bends with height above the model's origin. */
  sway?: boolean;
  /** Soft warm rim light, so shapes pop off the grass. */
  rim?: number;
  /** Moving glints on water. */
  water?: boolean;
}

/** One material family for the whole diorama: smooth Lambert (or the given base) plus the touches in `look`. */
function toyMaterial<T extends THREE.MeshLambertMaterial | THREE.MeshPhongMaterial = THREE.MeshLambertMaterial>(
  time: { value: number },
  look: Look,
  base?: T,
): T {
  const mat = (base ?? new THREE.MeshLambertMaterial({ vertexColors: true })) as T;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec2 vWorldXZ;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 toyWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          toyWorld = instanceMatrix * toyWorld;
        #endif
        toyWorld = modelMatrix * toyWorld;
        vWorldXZ = toyWorld.xz;
        ${look.sway ? `
        float gust = sin(uTime * 1.6 + toyWorld.x * 0.22 + toyWorld.z * 0.15) * 0.5 + 0.5;
        float bend = max(0.0, position.y) * (0.15 + 0.4 * gust);
        transformed.x += bend * sin(uTime * 3.1 + toyWorld.x * 0.7);
        transformed.z += bend * 0.5 * cos(uTime * 2.7 + toyWorld.z * 0.6);` : ''}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        varying vec2 vWorldXZ;
        float toyHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float toyNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(toyHash(i), toyHash(i + vec2(1.0, 0.0)), f.x),
                     mix(toyHash(i + vec2(0.0, 1.0)), toyHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        ${look.clouds ? `
        vec2 cp = vWorldXZ * 0.035 + vec2(uTime * 0.035, uTime * 0.018);
        float cn = toyNoise(cp) * 0.65 + toyNoise(cp * 2.3 + 7.0) * 0.35;
        reflectedLight.directDiffuse *= mix(1.0, 0.62, smoothstep(0.55, 0.72, cn));` : ''}
        ${look.rim ? `
        float rimF = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 2.5);
        totalEmissiveRadiance += vec3(1.0, 0.95, 0.82) * rimF * ${look.rim.toFixed(2)} * (0.4 + 0.6 * diffuseColor.rgb);` : ''}
        ${look.water ? `
        float w1 = sin(vWorldXZ.x * 1.1 - uTime * 1.4 + sin(vWorldXZ.y * 0.9 + uTime * 0.8) * 1.6);
        float w2 = sin(vWorldXZ.y * 1.7 + uTime * 1.1 + vWorldXZ.x * 0.3);
        totalEmissiveRadiance += vec3(0.85, 1.0, 1.0) * 0.28 * smoothstep(0.55, 1.0, w1 * w2);` : ''}`,
      );
  };
  const key = `toy-${look.clouds ? 'c' : ''}${look.sway ? 's' : ''}${look.rim ?? ''}${look.water ? 'w' : ''}-${mat.type}`;
  mat.customProgramCacheKey = () => key;
  return mat;
}

// ------------------------------------------------------------------ models

function colored(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) color.toArray(arr, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

/** Vertex colours running from `bottom` (at y0) to `top` (at y1): the painted-toy look. */
function shaded(geo: THREE.BufferGeometry, top: number, bottom: number, y0: number, y1: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  const ct = new THREE.Color(top);
  const cb = new THREE.Color(bottom);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = clamp((pos.getY(i) - y0) / (y1 - y0 || 1), 0, 1);
    c.copy(cb).lerp(ct, t * t * (3 - 2 * t));
    c.toArray(arr, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

/** A smooth sphere, gently lumpy if `lump` > 0, with soft normals. */
function blob(r: number, detail: number, lump = 0, seed = 0): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(r, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  if (lump > 0) {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = smoothNoise(v.x * 2.2 + seed, v.y * 2.2 + v.z * 1.7, seed) - 0.5;
      v.multiplyScalar(1 + n * lump);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

function i32(x: number, y: number): number {
  return (Math.round(x * 13) * 31 + Math.round(y * 17)) & 0xffff;
}

function stoneBlob(x: number, h: number, y: number, r: number, seed: number): THREE.BufferGeometry {
  const s = blob(r, 2, 0.35, seed % 97);
  s.scale(1.15, 0.8, 1.0);
  s.rotateY(hash2(seed, 2, 3) * 6);
  s.translate(x, h, -y);
  const tone = hash2(seed, 4, 5);
  const top = new THREE.Color(PAL.stone).offsetHSL(0, 0, (tone - 0.5) * 0.08).getHex();
  return shaded(s, top, PAL.stoneDark, h - r * 0.8, h + r * 0.8);
}

/** A soft green cushion of grass draped over the top of a stone. */
function grassCap(x: number, h: number, y: number, r: number, seed: number): THREE.BufferGeometry {
  const c = blob(r, 2, 0.25, seed % 89);
  c.scale(1.1, 0.42, 1.05);
  c.translate(x, h, -y);
  return shaded(c, PAL.grassLight, PAL.grass, h - r * 0.3, h + r * 0.4);
}

function leafBlob(x: number, h: number, y: number, r: number, squash: number, seed: number): THREE.BufferGeometry {
  const b = blob(r, 2, 0.18, seed % 83);
  b.scale(1, squash, 1);
  b.translate(x, h, -y);
  return shaded(b, PAL.leaf, PAL.leafDark, h - r * squash, h + r * squash);
}

/** Round-topped tree: a tapered trunk and a cluster of soft canopy puffs. */
function puffyTree(x: number, h: number, y: number, r: number, seed: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const trunkH = 1.6 + r * 0.5;
  const trunk = new THREE.CylinderGeometry(0.18 + r * 0.06, 0.3 + r * 0.08, trunkH, 10, 1);
  trunk.translate(x, h + trunkH / 2, -y);
  out.push(shaded(trunk, 0xa06c3e, PAL.trunk, h, h + trunkH));
  const cy = h + trunkH + r * 0.55;
  out.push(leafBlob(x, cy, y, r * 1.05, 0.95, seed));
  for (let k = 0; k < 4; k++) {
    const a = hash2(seed, k, 1) * Math.PI * 2;
    const d = r * (0.55 + hash2(seed, k, 2) * 0.25);
    const pr = r * (0.55 + hash2(seed, k, 3) * 0.2);
    out.push(leafBlob(x + Math.cos(a) * d, cy + (hash2(seed, k, 4) - 0.3) * r * 0.6, y + Math.sin(a) * d, pr, 0.9, seed + k + 1));
  }
  out.push(leafBlob(x + 0.1, cy + r * 0.75, y - 0.1, r * 0.6, 0.9, seed + 9));
  return out;
}

function bush(x: number, h: number, y: number, r: number, seed: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + hash2(seed, k, 6);
    const pr = r * (0.6 + hash2(seed, k, 7) * 0.2);
    out.push(leafBlob(x + Math.cos(a) * r * 0.4, h + pr * 0.7, y + Math.sin(a) * r * 0.4, pr, 0.85, seed + k));
  }
  // A few white blossoms dotted over it.
  for (let k = 0; k < 6; k++) {
    const a = hash2(seed, k, 8) * Math.PI * 2;
    const b = new THREE.SphereGeometry(0.08, 6, 4);
    b.translate(x + Math.cos(a) * r * 0.7, h + r * (0.7 + hash2(seed, k, 9) * 0.6), -(y + Math.sin(a) * r * 0.7));
    out.push(colored(b, new THREE.Color(k % 2 ? 0xffffff : 0xffc2dc)));
  }
  return out;
}

const SHEEP_HIP = 0.45;
/** Where a sheep's head pivots when it dips to graze. */
const NECK = { x: 0.42, y: 0.82 };

/**
 * Fluffy sheep facing +x (matches the sim's heading 0), feet at y = 0.
 * Wool and face are separate so black sheep can tint just their fleece and
 * heads can dip to graze. Legs come in diagonal pairs, pivoting at the hip.
 */
function sheepGeometry(): {
  wool: THREE.BufferGeometry;
  face: THREE.BufferGeometry;
  woolLo: THREE.BufferGeometry;
  faceLo: THREE.BufferGeometry;
  legsA: THREE.BufferGeometry;
  legsB: THREE.BufferGeometry;
} {
  const woolParts: THREE.BufferGeometry[] = [];
  const add = (r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
    const b = blob(r, 2);
    b.scale(sx, sy, sz);
    b.translate(x, y, z);
    woolParts.push(shaded(b, PAL.wool, PAL.woolShade, 0.4, 1.15));
  };
  add(0.5, 0, 0.74, 0, 1.2, 0.9, 1.0);
  // Puffs round the top and sides give the cloud silhouette.
  for (const [x, y, z, r] of [
    [0.25, 1.04, 0.16, 0.24],
    [0.22, 1.02, -0.18, 0.24],
    [-0.12, 1.1, 0.0, 0.27],
    [-0.36, 0.98, 0.2, 0.22],
    [-0.38, 0.98, -0.2, 0.22],
    [0.05, 0.8, 0.42, 0.24],
    [0.05, 0.8, -0.42, 0.24],
    [-0.3, 0.72, 0.38, 0.22],
    [-0.3, 0.72, -0.38, 0.22],
    [-0.6, 0.82, 0.0, 0.16],
  ]) add(r, x, y, z);

  const faceParts: THREE.BufferGeometry[] = [];
  const part = (geo: THREE.BufferGeometry, color: number) => faceParts.push(colored(geo, new THREE.Color(color)));
  const head = blob(0.27, 2);
  head.scale(1.12, 1.0, 0.9);
  head.translate(0.62, 0.86, 0);
  faceParts.push(shaded(head, 0x4a3d39, 0x2a2220, 0.65, 1.1));
  const topknot = blob(0.15, 2);
  topknot.scale(1.1, 0.8, 1.1);
  topknot.translate(0.58, 1.1, 0);
  faceParts.push(shaded(topknot, PAL.wool, PAL.woolShade, 1.0, 1.2));
  for (const z of [-1, 1]) {
    const eye = blob(0.08, 2);
    eye.translate(0.8, 0.93, z * 0.11);
    part(eye, 0xffffff);
    const pupil = blob(0.05, 1);
    pupil.translate(0.86, 0.93, z * 0.115);
    part(pupil, 0x111111);
    const glint = blob(0.018, 1);
    glint.translate(0.905, 0.96, z * 0.1);
    part(glint, 0xffffff);
    const ear = blob(0.1, 1);
    ear.scale(0.5, 0.35, 1.3);
    ear.rotateX(z * 0.5);
    ear.translate(0.56, 0.93, z * 0.28);
    part(ear, 0x3a2f2c);
  }
  const nose = blob(0.06, 1);
  nose.scale(0.6, 0.6, 1.2);
  nose.translate(0.87, 0.78, 0);
  part(nose, PAL.nose);

  const pair = (legs: [number, number][]) =>
    mergeGeometries(
      legs.map(([x, z]) => {
        const leg = new THREE.CapsuleGeometry(0.07, SHEEP_HIP - 0.1, 4, 8);
        leg.translate(x, -SHEEP_HIP / 2 + 0.02, z);
        return shaded(leg, 0x3a2f2c, 0x241c1a, -SHEEP_HIP, 0);
      }),
    );
  // Low detail: a few soft lumps and a dark head, read from far away.
  const woolLo: THREE.BufferGeometry[] = [];
  for (const [r, x, y, z, sx] of [
    [0.5, 0, 0.74, 0, 1.2],
    [0.3, -0.12, 1.06, 0, 1.1],
    [0.26, 0.2, 1.0, 0, 1],
  ]) {
    const b = blob(r, 1);
    b.scale(sx, 0.9, 1);
    b.translate(x, y, z);
    woolLo.push(shaded(b, PAL.wool, PAL.woolShade, 0.4, 1.15));
  }
  const headLo = blob(0.28, 1);
  headLo.scale(1.12, 1, 0.9);
  headLo.translate(0.62, 0.86, 0);
  return {
    woolLo: mergeGeometries(woolLo),
    faceLo: shaded(headLo, 0x4a3d39, 0x2a2220, 0.65, 1.1),
    wool: mergeGeometries(woolParts),
    face: mergeGeometries(faceParts),
    legsA: pair([[0.28, 0.18], [-0.28, -0.18]]),
    legsB: pair([[0.28, -0.18], [-0.28, 0.18]]),
  };
}

/**
 * A multiplier gate, centred on its group's origin: two rounded white posts,
 * a glowing see-through panel and a big label. Green multiplies, blue adds.
 */
function gateModel(width: number, kind: 'x' | '+', n: number, mat: THREE.Material): { group: THREE.Group; panel: THREE.Mesh } {
  const group = new THREE.Group();
  const colour = kind === 'x' ? (n >= 3 ? 0x2bd96b : 0x4fd1ff) : 0x5b8cff;
  const h = 2.6;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const post = new RoundedBoxGeometry(0.5, h + 0.4, 0.5, 2, 0.18);
    post.translate((side * width) / 2, (h + 0.4) / 2, 0);
    parts.push(shaded(post, 0xffffff, 0xd8dde6, 0, h));
    const ball = new THREE.SphereGeometry(0.42, 16, 12);
    ball.translate((side * width) / 2, h + 0.6, 0);
    parts.push(colored(ball, new THREE.Color(colour)));
  }
  const posts = new THREE.Mesh(mergeGeometries(parts), mat);
  posts.castShadow = true;
  group.add(posts);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(width, h),
    new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
  );
  panel.position.y = h / 2;
  group.add(panel);

  // Label, drawn once to a canvas texture.
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 256;
  const ctx = cv.getContext('2d')!;
  ctx.font = '900 190px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 22;
  ctx.strokeStyle = 'rgba(0,40,30,0.55)';
  const text = (kind === 'x' ? '×' : '+') + n;
  ctx.strokeText(text, 256, 140);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 256, 140);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const lw = Math.min(width * 0.8, 9);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(lw, lw / 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  // Tip it back toward the camera so it reads from above.
  label.rotation.x = -0.55;
  label.position.set(0, h + lw * 0.22, 0.2);
  group.add(label);
  return { group, panel };
}

interface DogRig {
  root: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  tail: THREE.Group;
  tongue: THREE.Mesh;
  legs: THREE.Group[];
}

const DOG_TORSO_Y = 0.6;
const DOG_HEAD = { x: 0.4, y: 0.24 };

/** Border collie, facing +x: black coat, white blaze, ruff, chest, socks and tail tip. */
function dogModel(mat: THREE.Material): DogRig {
  const black = PAL.collie;
  const white = PAL.collieWhite;
  const mesh = (parts: THREE.BufferGeometry[]) => {
    const m = new THREE.Mesh(mergeGeometries(parts), mat);
    m.castShadow = true;
    return m;
  };
  const piece = (geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number) => {
    geo.translate(x, y, z);
    return colored(geo, new THREE.Color(color));
  };
  const ell = (r: number, sx: number, sy: number, sz: number) => {
    const b = blob(r, 2);
    b.scale(sx, sy, sz);
    return b;
  };

  const root = new THREE.Group();
  const torso = new THREE.Group();
  torso.position.y = DOG_TORSO_Y;
  root.add(torso);
  const body = new THREE.CapsuleGeometry(0.2, 0.46, 6, 14);
  body.rotateZ(Math.PI / 2);
  torso.add(
    mesh([
      piece(body, black, -0.02, 0, 0),
      piece(ell(0.19, 1.1, 0.75, 0.9), white, 0.08, -0.1, 0), // belly
      piece(ell(0.2, 0.75, 1.15, 1.2), white, 0.3, 0.06, 0), // ruff
      piece(ell(0.18, 1.0, 1.0, 1.0), white, 0.3, -0.06, 0), // chest
    ]),
  );

  const head = new THREE.Group();
  head.position.set(DOG_HEAD.x, DOG_HEAD.y, 0);
  torso.add(head);
  const headParts = [
    piece(ell(0.21, 1.05, 0.95, 0.95), black, 0.06, 0.06, 0),
    piece(ell(0.07, 2.0, 0.55, 0.6), white, 0.14, 0.17, 0), // blaze
    piece(ell(0.12, 1.35, 0.8, 0.95), white, 0.24, -0.03, 0), // muzzle
    piece(blob(0.05, 1), 0x111111, 0.4, 0.01, 0), // nose
  ];
  for (const z of [-1, 1]) {
    headParts.push(piece(blob(0.06, 2), 0xffffff, 0.19, 0.1, z * 0.11));
    headParts.push(piece(blob(0.042, 1), 0x2b1a10, 0.225, 0.1, z * 0.117));
    headParts.push(piece(blob(0.014, 1), 0xffffff, 0.25, 0.125, z * 0.11));
    // Half-folded ears: an upright base with the tip tipping forward.
    const ear = new THREE.ConeGeometry(0.075, 0.18, 10);
    ear.rotateX(z * -0.25);
    headParts.push(piece(ear, black, 0.0, 0.27, z * 0.12));
    headParts.push(piece(ell(0.05, 1.3, 0.6, 1.0), black, 0.05, 0.35, z * 0.135));
  }
  head.add(mesh(headParts));
  const tongue = new THREE.Mesh(colored(ell(0.06, 0.7, 1.0, 0.8).translate(0, -0.05, 0), new THREE.Color(PAL.tongue)), mat);
  tongue.position.set(0.3, -0.1, 0);
  head.add(tongue);

  const tail = new THREE.Group();
  tail.position.set(-0.36, 0.06, 0);
  tail.rotation.z = 0.35;
  torso.add(tail);
  tail.add(
    mesh([
      piece(ell(0.09, 1.4, 0.9, 0.9), black, -0.1, 0, 0),
      piece(ell(0.1, 1.4, 0.9, 0.9), black, -0.24, -0.01, 0),
      piece(ell(0.08, 1.2, 0.9, 0.9), white, -0.38, -0.02, 0),
    ]),
  );

  // Legs pivot at the hip so they can swing. Order: front-left, front-right, back-left, back-right.
  const legs: THREE.Group[] = [];
  for (const [x, z] of [[0.24, 0.1], [0.24, -0.1], [-0.24, 0.1], [-0.24, -0.1]]) {
    const leg = new THREE.Group();
    leg.position.set(x, 0.46, z);
    const shin = new THREE.CapsuleGeometry(0.065, 0.3, 4, 10);
    leg.add(
      mesh([
        piece(shin, white, 0, -0.24, 0),
        piece(ell(0.08, 1.0, 1.0, 1.0), black, 0, -0.04, 0),
        piece(ell(0.075, 1.3, 0.6, 1.0), white, 0.03, -0.43, 0),
      ]),
    );
    root.add(leg);
    legs.push(leg);
  }
  root.scale.setScalar(1.3);
  return { root, torso, head, tail, tongue, legs };
}

// -------------------------------------------------------------- terrain

/** Gentle rolling hills, a bank rising outside the field, channels for streams, and a level pen. */
function makeHeights(def: MeadowDef): (x: number, y: number) => number {
  const p = def.pen;
  return (x: number, y: number) => {
    let h = (smoothNoise(x / 34, y / 34, def.seed) - 0.5) * 6 + (smoothNoise(x / 11, y / 11, def.seed + 3) - 0.5) * 1.0;
    const out = Math.max(0, -x, x - def.width, -y, y - def.height);
    h += Math.min(out, 12) * 0.55;
    for (const st of def.streams) {
      const d = streamDist(st.points, x, y);
      const r = st.width / 2 + 1.6;
      if (d < r) h = h * (d / r) - (1 - d / r) * 1.3;
    }
    // Level ground under and around the pen.
    const pd = Math.max(0, p.x - 2 - x, x - (p.x + p.w + 2), p.y - 2 - y, y - (p.y + p.h + 2));
    if (pd < 4) h *= pd / 4;
    return h;
  };
}

function streamDist(points: [number, number][], x: number, y: number): number {
  let d = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const t = segmentT(x, y, ax, ay, bx, by);
    d = Math.min(d, Math.hypot(x - (ax + (bx - ax) * t), y - (ay + (by - ay) * t)));
  }
  return d;
}

const PATCHWORK = [0x5fb83a, 0x79c94a, 0x4fa83a, 0x8acb52, 0xb5c95a];

function groundColor(def: MeadowDef, x: number, y: number, h: number, out: THREE.Color): void {
  const n = smoothNoise(x / 16, y / 16, def.seed) * 0.7 + smoothNoise(x / 5, y / 5, def.seed + 9) * 0.3;
  const outside = x < -0.5 || y < -0.5 || x > def.width + 0.5 || y > def.height + 0.5;
  if (outside) {
    // Irish patchwork: neighbouring fields in slightly different greens.
    const i = Math.floor(hash2(Math.floor((x + 200) / 17), Math.floor((y + 200) / 13), def.seed) * PATCHWORK.length);
    out.set(PATCHWORK[i]).offsetHSL(0, 0, (n - 0.5) * 0.06);
    return;
  }
  // Broad soft patches, sunlit hilltops lighter and warmer, hollows deeper green.
  const patch = smoothNoise(x / 9, y / 9, def.seed + 21);
  out.set(PAL.grass).lerp(new THREE.Color(PAL.grassLight), clamp(0.2 + h * 0.13 + (n - 0.5) * 0.7, 0, 0.85));
  out.lerp(new THREE.Color(PAL.grassDark), smooth(0.55, 0.85, patch) * 0.45);
  out.offsetHSL((smoothNoise(x / 25, y / 25, def.seed + 33) - 0.5) * 0.04, 0, 0);
  for (const st of def.streams) {
    const d = streamDist(st.points, x, y);
    const r = st.width / 2 + 1.5;
    if (d < r) out.lerp(new THREE.Color(PAL.bank), smooth(r, r - 0.9, d));
  }
}

/** Soft darkening where the ground meets things standing on it, so nothing floats. */
function contactShade(def: MeadowDef, pen: { left: number; right: number; bottom: number; top: number }): (x: number, y: number) => number {
  const blobs = def.obstacles.map((o) => ({ x: o.x, y: o.y, r: o.r * (o.kind === 'tree' ? 1.3 : 1.0) }));
  return (x: number, y: number) => {
    let s = 1;
    for (const b of blobs) {
      const d = Math.hypot(x - b.x, y - b.y) - b.r * 0.6;
      if (d < 2) s = Math.min(s, 0.72 + 0.28 * smooth(0, 2, d));
    }
    for (const [ax, ay, bx, by] of def.walls) {
      const t = segmentT(x, y, ax, ay, bx, by);
      const d = Math.hypot(x - (ax + (bx - ax) * t), y - (ay + (by - ay) * t));
      if (d < 1.6) s = Math.min(s, 0.75 + 0.25 * smooth(0.3, 1.6, d));
    }
    const pd = Math.max(pen.left - x, x - pen.right, pen.bottom - y, y - pen.top);
    if (Math.abs(pd) < 0.8) s = Math.min(s, 0.85 + 0.15 * smooth(0, 0.8, Math.abs(pd)));
    // Under the hedge round the field.
    const edge = Math.min(Math.abs(x), Math.abs(y), Math.abs(def.width - x), Math.abs(def.height - y));
    if (edge < 2.5) s = Math.min(s, 0.78 + 0.22 * smooth(0, 2.5, edge));
    return s;
  };
}

// --------------------------------------------------------------- helpers

function gradient(p: number, stops: [number, number][]): THREE.Color {
  for (let i = 0; i + 1 < stops.length; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (p <= b) return new THREE.Color(ca).lerp(new THREE.Color(cb), (p - a) / (b - a));
  }
  return new THREE.Color(stops[stops.length - 1][1]);
}

function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
