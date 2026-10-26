import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Meadow, streamYAt } from '../game/meadow';
import { MeadowDef } from '../game/meadowLevels';
import { clamp, hash2, segmentT, smoothNoise } from '../game/math';

/**
 * Stylized low-poly 3D view of a round-up meadow.
 *
 * Only draws: the herding simulation is the same 2D sim as before. Sim
 * coordinates (x, y) map to three.js (x, height, -y), so +y up the field is
 * "into the screen". Rolling hills are visual only.
 */
export class Meadow3D {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 0.5, 1, 400);
  private sun = new THREE.DirectionalLight(0xffffff, 2.4);
  private hemi = new THREE.HemisphereLight(0xcfe8ff, 0x4a6b2a, 1.1);
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private world: THREE.Group | null = null;
  private terrain: THREE.Mesh | null = null;
  private sheepMesh: THREE.InstancedMesh | null = null;
  /** Legs in diagonal pairs (front-left + back-right, and the other two), swung in opposite phase. */
  private legsA: THREE.InstancedMesh | null = null;
  private legsB: THREE.InstancedMesh | null = null;
  private dogLegs: THREE.Object3D[] = [];
  private dogStride = 0;
  private lastT = 0;
  private legLocal = new THREE.Matrix4();
  private legWorld = new THREE.Matrix4();
  private dog: THREE.Group | null = null;
  private dogTail: THREE.Object3D | null = null;
  private def: MeadowDef | null = null;
  private heights: (x: number, y: number) => number = () => 0;
  private tmp = new THREE.Object3D();
  private tmpV = new THREE.Vector3();
  private w = 1;
  private h = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
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
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.scene.fog = new THREE.Fog(0xcfe8ff, 70, 170);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.w = cssW;
    this.h = cssH;
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(cssW, cssH, false);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
  }

  // --------------------------------------------------------------- frame

  render(m: Meadow, t: number): void {
    if (m.def !== this.def) this.build(m);
    this.updateCamera(m);
    this.updateLight(m);
    this.updateSheep(m, t);
    this.updateDog(m, t);
    this.renderer.render(this.scene, this.camera);
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
    fog.near = dist * 1.4;
    fog.far = dist * 3.2;
  }

  /** Afternoon → golden hour → dusk, driven by the round-up timer. */
  private updateLight(m: Meadow): void {
    const p = clamp(m.time / m.limit, 0, 1);
    const elev = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(52, 11, Math.pow(p, 1.2)));
    const azim = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(-35, -70, p));
    const sunCol = gradient(p, [
      [0, 0xfff1d6],
      [0.55, 0xffd796],
      [0.85, 0xffb46e],
      [1, 0xff9a6a],
    ]);
    const sky = gradient(p, [
      [0, 0xbfe3ff],
      [0.55, 0xd9e6f0],
      [0.85, 0xffd2ad],
      [1, 0xc4a6d6],
    ]);
    const ground = gradient(p, [
      [0, 0x4f7a2c],
      [0.85, 0x5f5e32],
      [1, 0x4b4558],
    ]);
    this.sun.color.copy(sunCol);
    this.sun.intensity = THREE.MathUtils.lerp(2.6, 2.0, smooth(0.7, 1, p));
    this.hemi.color.copy(sky);
    this.hemi.groundColor.copy(ground);
    this.hemi.intensity = THREE.MathUtils.lerp(1.15, 0.95, smooth(0.75, 1, p));
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

  private updateSheep(m: Meadow, t: number): void {
    const mesh = this.sheepMesh!;
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
      const bob = Math.abs(Math.sin(stride)) * 0.12 * trot;
      o.position.set(s.x, this.heights(s.x, s.y) + bob, -s.y);
      o.rotation.set(0, s.heading, Math.sin(stride) * 0.05 * trot);
      const k = s.lamb ? 0.68 : 1;
      o.scale.set(k, k, k);
      o.updateMatrix();
      mesh.setMatrixAt(n, o.matrix);
      // Legs pivot at the hip; a grazing sheep's legs barely move.
      const swing = Math.sin(stride) * (0.08 + 0.55 * trot);
      this.legLocal.makeRotationZ(swing).setPosition(0, SHEEP_HIP, 0);
      legsA.setMatrixAt(n, this.legWorld.multiplyMatrices(o.matrix, this.legLocal));
      this.legLocal.makeRotationZ(-swing).setPosition(0, SHEEP_HIP, 0);
      legsB.setMatrixAt(n, this.legWorld.multiplyMatrices(o.matrix, this.legLocal));
      n++;
    }
    for (const im of [mesh, legsA, legsB]) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    }
    void t;
  }

  private updateDog(m: Meadow, t: number): void {
    const d = m.dog;
    const dog = this.dog!;
    const speed = Math.hypot(d.vx, d.vy);
    const run = Math.min(1, speed / 4);
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.dogStride += dt * (2 + speed * 2.6);
    const st = this.dogStride;
    dog.position.set(d.x, this.heights(d.x, d.y) + Math.abs(Math.sin(st)) * 0.14 * run, -d.y);
    dog.rotation.set(0, d.heading, Math.sin(st) * 0.04 * run);
    // Gallop-ish: diagonal pairs swing in opposite phase.
    const swing = Math.sin(st) * (0.1 + 0.75 * run);
    this.dogLegs.forEach((leg, i) => (leg.rotation.z = i === 0 || i === 3 ? swing : -swing));
    if (this.dogTail) this.dogTail.rotation.y = Math.sin(t * (6 + run * 10)) * 0.6;
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
    const flat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

    // Terrain: the field plus a rising bank all round it.
    const pad = 30;
    const W = def.width + pad * 2;
    const H = def.height + pad * 2;
    const seg = 1.6;
    const geo = new THREE.PlaneGeometry(W, H, Math.round(W / seg), Math.round(H / seg)).toNonIndexed();
    geo.rotateX(-Math.PI / 2);
    geo.translate(def.width / 2, 0, -def.height / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = -pos.getZ(i);
      pos.setY(i, this.heights(x, y));
    }
    // Colour per triangle (flat facets), from the triangle's centre.
    for (let i = 0; i < pos.count; i += 3) {
      const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const y = -(pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      groundColor(def, x, y, c);
      for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, flat);
    terrain.receiveShadow = true;
    g.add(terrain);
    this.terrain = terrain;

    this.buildWater(def, g);
    this.buildPen(m, g, flat);
    this.buildScenery(def, g, flat);

    // Sheep: an instanced low-poly body plus two instanced pairs of legs.
    const geos = sheepGeometry();
    const inst = (geo: THREE.BufferGeometry) => {
      const im = new THREE.InstancedMesh(geo, flat, Math.max(1, m.sheep.length));
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      g.add(im);
      return im;
    };
    this.sheepMesh = inst(geos.body);
    this.legsA = inst(geos.legsA);
    this.legsB = inst(geos.legsB);

    const { dog, tail, legs } = dogModel(flat);
    this.dog = dog;
    this.dogTail = tail;
    this.dogLegs = legs;
    g.add(dog);
  }

  private buildWater(def: MeadowDef, g: THREE.Group): void {
    const water = new THREE.MeshLambertMaterial({ color: 0x3f95cf, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    const plank = new THREE.MeshLambertMaterial({ color: 0xb08250, flatShading: true });
    const post = new THREE.MeshLambertMaterial({ color: 0x5c3d22, flatShading: true });
    for (const st of def.streams) {
      // A ribbon along the stream, sitting in the carved channel.
      const pts: number[] = [];
      const idx: number[] = [];
      const steps = 120;
      const x0 = st.points[0][0];
      const x1 = st.points[st.points.length - 1][0];
      for (let i = 0; i <= steps; i++) {
        const x = x0 - 2 + ((x1 - x0 + 4) * i) / steps;
        const y = streamYAt(st, clamp(x, x0, x1));
        const half = st.width / 2 + 0.6;
        pts.push(x, -0.55, -(y - half), x, -0.55, -(y + half));
        if (i < steps) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, water);
      mesh.receiveShadow = true;
      g.add(mesh);

      for (const br of st.bridges) {
        const y = streamYAt(st, br.x);
        const span = st.width + 3.4;
        // Deck sits level with the higher bank so it reads as a bridge, not a ramp.
        const deckY = Math.max(this.heights(br.x, y - span / 2), this.heights(br.x, y + span / 2), 0) + 0.25;
        const n = Math.round(span / 0.55);
        for (let i = 0; i < n; i++) {
          const z = -(y - span / 2) - (i + 0.5) * (span / n);
          const board = new THREE.Mesh(new THREE.BoxGeometry(br.w - 0.4, 0.14, span / n - 0.08), plank);
          board.position.set(br.x, deckY, z);
          board.rotation.y = (hash2(i, 3, 7) - 0.5) * 0.04;
          board.castShadow = true;
          board.receiveShadow = true;
          g.add(board);
        }
        for (const side of [-1, 1]) {
          const x = br.x + side * (br.w / 2 - 0.15);
          const beam = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.3, span + 0.4), post);
          beam.position.set(x, deckY - 0.18, -y);
          g.add(beam);
          const rail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, span), post);
          rail.position.set(x, deckY + 0.75, -y);
          rail.castShadow = true;
          g.add(rail);
          for (let k = 0; k <= 3; k++) {
            const p = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.85, 0.18), post);
            p.position.set(x, deckY + 0.35, -(y - span / 2) - (k * span) / 3);
            p.castShadow = true;
            g.add(p);
          }
        }
      }
    }
  }

  private buildPen(m: Meadow, g: THREE.Group, flat: THREE.Material): void {
    const p = m.pen;
    const straw = new THREE.Mesh(
      new THREE.BoxGeometry(p.right - p.left, 0.12, p.top - p.bottom),
      new THREE.MeshLambertMaterial({ color: 0xd9c27a, flatShading: true }),
    );
    straw.position.set((p.left + p.right) / 2, this.heights((p.left + p.right) / 2, (p.bottom + p.top) / 2) + 0.02, -(p.bottom + p.top) / 2);
    straw.receiveShadow = true;
    g.add(straw);

    const parts: THREE.BufferGeometry[] = [];
    const wood = new THREE.Color(0x7a5532);
    const dark = new THREE.Color(0x5c3d22);
    const fence = (ax: number, ay: number, bx: number, by: number) => {
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.1) return;
      const ang = Math.atan2(by - ay, bx - ax);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const h = this.heights(mx, my);
      for (const rh of [0.45, 0.85]) {
        const rail = new THREE.BoxGeometry(len, 0.1, 0.08);
        rail.rotateY(ang);
        rail.translate(mx, h + rh, -my);
        parts.push(colored(rail, wood));
      }
      const n = Math.max(1, Math.round(len / 1.8));
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const y = ay + ((by - ay) * i) / n;
        const post = new THREE.BoxGeometry(0.18, 1.1, 0.18);
        post.translate(x, this.heights(x, y) + 0.55, -y);
        parts.push(colored(post, dark));
      }
    };
    const side = (s: string, ax: number, ay: number, bx: number, by: number) => {
      if (s !== p.gate) return fence(ax, ay, bx, by);
      if (ay === by) {
        fence(ax, ay, p.gateA, by);
        fence(p.gateB, ay, bx, by);
      } else {
        fence(ax, ay, bx, p.gateA);
        fence(ax, p.gateB, bx, by);
      }
    };
    side('south', p.left, p.bottom, p.right, p.bottom);
    side('north', p.left, p.top, p.right, p.top);
    side('west', p.left, p.bottom, p.left, p.top);
    side('east', p.right, p.bottom, p.right, p.top);
    const mesh = new THREE.Mesh(mergeGeometries(parts), flat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }

  private buildScenery(def: MeadowDef, g: THREE.Group, flat: THREE.Material): void {
    const parts: THREE.BufferGeometry[] = [];
    const add = (geo: THREE.BufferGeometry, color: THREE.Color | number) => parts.push(colored(geo, new THREE.Color(color)));
    const H = (x: number, y: number) => this.heights(x, y);

    for (const o of def.obstacles) {
      const h = H(o.x, o.y);
      const r = hash2(Math.round(o.x * 7), Math.round(o.y * 7), 3);
      if (o.kind === 'tree') {
        const trunk = new THREE.CylinderGeometry(0.22, 0.32, 2.2, 6);
        trunk.translate(o.x, h + 1.1, -o.y);
        add(trunk, 0x6b4a2b);
        const crown = new THREE.IcosahedronGeometry(o.r * 1.35, 0);
        crown.scale(1, 1.15, 1);
        crown.rotateY(r * 6);
        crown.translate(o.x, h + 2.2 + o.r, -o.y);
        add(crown, r < 0.5 ? 0x2f6f26 : 0x3a7d2c);
        const top = new THREE.IcosahedronGeometry(o.r * 0.8, 0);
        top.translate(o.x + 0.3, h + 3 + o.r * 1.4, -o.y - 0.2);
        add(top, 0x478f35);
      } else if (o.kind === 'rock') {
        const rock = new THREE.DodecahedronGeometry(o.r, 0);
        rock.scale(1, 0.65, 1);
        rock.rotateY(r * 6);
        rock.translate(o.x, h + o.r * 0.35, -o.y);
        add(rock, 0x8d8a80);
      } else {
        const bush = new THREE.IcosahedronGeometry(o.r, 0);
        bush.scale(1, 0.75, 1);
        bush.translate(o.x, h + o.r * 0.5, -o.y);
        add(bush, 0x2f6d25);
      }
    }

    // Dry-stone walls: two courses of rough stones.
    for (const [ax, ay, bx, by] of def.walls) {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(len / 0.7));
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const y = ay + ((by - ay) * i) / n;
        const h = H(x, y);
        const r = hash2(i, Math.round(ax + ay), 11);
        for (const course of [0, 1]) {
          const st = new THREE.DodecahedronGeometry(0.42 - course * 0.06, 0);
          st.scale(1.1, 0.75, 0.9);
          st.rotateY(r * 6 + course);
          st.translate(x + (course ? 0.3 : 0), h + 0.3 + course * 0.45, -y);
          add(st, new THREE.Color().setHSL(0.11, 0.06, 0.5 + r * 0.18 - course * 0.05));
        }
      }
    }

    // Hedgerow round the field.
    const ring = (x: number, y: number, i: number) => {
      const r = 1.2 + hash2(i, 5, def.seed) * 0.7;
      const b = new THREE.IcosahedronGeometry(r, 0);
      b.scale(1, 0.9, 1);
      b.translate(x, H(x, y) + r * 0.6, -y);
      add(b, i % 3 ? 0x24561b : 0x2d6322);
    };
    let i = 0;
    for (let x = -1; x <= def.width + 1; x += 2.2) {
      ring(x, -1.6, i++);
      ring(x, def.height + 1.6, i++);
    }
    for (let y = -1; y <= def.height + 1; y += 2.2) {
      ring(-1.6, y, i++);
      ring(def.width + 1.6, y, i++);
    }

    // A few trees out beyond the hedge for depth.
    for (let k = 0; k < 40; k++) {
      const side = k % 4;
      const tt = hash2(k, 1, def.seed);
      const off = 5 + hash2(k, 2, def.seed) * 18;
      const x = side < 2 ? tt * def.width : side === 2 ? -off : def.width + off;
      const y = side >= 2 ? tt * def.height : side === 0 ? -off : def.height + off;
      const h = H(x, y);
      const crown = new THREE.IcosahedronGeometry(2 + hash2(k, 3, def.seed) * 1.5, 0);
      crown.scale(1, 1.2, 1);
      crown.translate(x, h + 3.5, -y);
      add(crown, 0x2b5f22);
      const trunk = new THREE.CylinderGeometry(0.3, 0.4, 2.5, 5);
      trunk.translate(x, h + 1.25, -y);
      add(trunk, 0x5a3e24);
    }

    const mesh = new THREE.Mesh(mergeGeometries(parts), flat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);

    // Flowers: tiny instanced specks scattered through the grass.
    const flowerGeo = colored(new THREE.OctahedronGeometry(0.09, 0), new THREE.Color(0xffffff));
    const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), 700);
    const fc = new THREE.Color();
    for (let k = 0; k < 700; k++) {
      const x = hash2(k, 7, def.seed) * def.width;
      const y = hash2(k, 8, def.seed) * def.height;
      this.tmp.position.set(x, H(x, y) + 0.08, -y);
      this.tmp.rotation.set(0, 0, 0);
      this.tmp.scale.setScalar(1);
      this.tmp.updateMatrix();
      flowers.setMatrixAt(k, this.tmp.matrix);
      fc.set(k % 3 === 0 ? 0xffe14d : k % 7 === 0 ? 0xc77ddb : 0xffffff);
      flowers.setColorAt(k, fc);
    }
    g.add(flowers);

    // Grass tufts: little three-sided blades in a few greens.
    const tuftGeo = new THREE.ConeGeometry(0.12, 0.36, 3, 1);
    tuftGeo.translate(0, 0.16, 0);
    const tufts = new THREE.InstancedMesh(
      colored(tuftGeo, new THREE.Color(0xffffff)),
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      2600,
    );
    const tc = new THREE.Color();
    for (let k = 0; k < 2600; k++) {
      const x = hash2(k, 17, def.seed) * def.width;
      const y = hash2(k, 18, def.seed) * def.height;
      const s = 0.7 + hash2(k, 19, def.seed) * 0.9;
      this.tmp.position.set(x, H(x, y), -y);
      this.tmp.rotation.set(0, hash2(k, 20, def.seed) * 6, (hash2(k, 21, def.seed) - 0.5) * 0.4);
      this.tmp.scale.set(s, s * (0.8 + hash2(k, 22, def.seed)), s);
      this.tmp.updateMatrix();
      tufts.setMatrixAt(k, this.tmp.matrix);
      tc.setHSL(0.23 + hash2(k, 23, def.seed) * 0.05, 0.62, 0.27 + hash2(k, 24, def.seed) * 0.12);
      tufts.setColorAt(k, tc);
    }
    tufts.receiveShadow = true;
    g.add(tufts);
  }
}

// ------------------------------------------------------------------ models

function colored(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) color.toArray(arr, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

const SHEEP_HIP = 0.42;

/**
 * Chunky low-poly sheep facing +x (matches the sim's heading 0), feet at y = 0.
 * Legs come separately, in diagonal pairs, with their pivot (the hip) at the origin.
 */
function sheepGeometry(): { body: THREE.BufferGeometry; legsA: THREE.BufferGeometry; legsB: THREE.BufferGeometry } {
  const wool = new THREE.Color(0xf3efe4);
  const woolHi = new THREE.Color(0xfffcf4);
  const face = new THREE.Color(0x2a2522);
  const parts: THREE.BufferGeometry[] = [];
  const torso = new THREE.IcosahedronGeometry(0.45, 1);
  torso.scale(1.3, 0.95, 1.0);
  torso.translate(0, 0.66, 0);
  parts.push(colored(torso, wool));
  for (const [x, y, z, r] of [
    [0.2, 1.02, 0.14, 0.2],
    [-0.22, 1.0, -0.12, 0.22],
    [0.02, 1.06, -0.16, 0.18],
    [-0.35, 0.86, 0.18, 0.18],
  ]) {
    const puff = new THREE.IcosahedronGeometry(r, 0);
    puff.translate(x, y, z);
    parts.push(colored(puff, woolHi));
  }
  const head = new THREE.BoxGeometry(0.3, 0.3, 0.26);
  head.translate(0.62, 0.78, 0);
  parts.push(colored(head, face));
  const tuft = new THREE.IcosahedronGeometry(0.13, 0);
  tuft.translate(0.52, 0.96, 0);
  parts.push(colored(tuft, woolHi));
  for (const z of [-0.17, 0.17]) {
    const ear = new THREE.BoxGeometry(0.08, 0.06, 0.16);
    ear.translate(0.55, 0.86, z * 1.25);
    parts.push(colored(ear, face));
  }
  const pair = (legs: [number, number][]) => {
    const g = mergeGeometries(
      legs.map(([x, z]) => colored(new THREE.BoxGeometry(0.1, SHEEP_HIP + 0.04, 0.1).translate(x, -SHEEP_HIP / 2, z), face)),
    );
    g.computeVertexNormals();
    return g;
  };
  // The sim's heading is measured from +x toward +y (up the field), which is -z here.
  const body = mergeGeometries(parts);
  body.computeVertexNormals();
  return {
    body,
    legsA: pair([[0.28, 0.17], [-0.28, -0.17]]),
    legsB: pair([[0.28, -0.17], [-0.28, 0.17]]),
  };
}

/** Border collie, facing +x. */
function dogModel(mat: THREE.Material): { dog: THREE.Group; tail: THREE.Object3D; legs: THREE.Object3D[] } {
  const black = new THREE.Color(0x1d1d22);
  const white = new THREE.Color(0xf1f1f1);
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color) => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(x, y, z);
    parts.push(colored(b, c));
  };
  box(0.8, 0.32, 0.32, 0, 0.55, 0, black);
  box(0.26, 0.36, 0.34, 0.32, 0.6, 0, white); // chest
  box(0.3, 0.26, 0.26, 0.55, 0.8, 0, black); // head
  box(0.18, 0.12, 0.16, 0.74, 0.74, 0, white); // muzzle
  box(0.06, 0.06, 0.06, 0.84, 0.76, 0, black); // nose
  box(0.08, 0.16, 0.08, 0.5, 0.98, 0.09, black); // ears
  box(0.08, 0.16, 0.08, 0.5, 0.98, -0.09, black);
  const body = new THREE.Mesh(mergeGeometries(parts), mat);
  body.castShadow = true;
  const tailGeo = colored(new THREE.BoxGeometry(0.45, 0.09, 0.09).translate(-0.22, 0, 0), black);
  const tail = new THREE.Mesh(tailGeo, mat);
  tail.position.set(-0.4, 0.66, 0);
  tail.rotation.z = 0.5;
  tail.castShadow = true;
  const dog = new THREE.Group();
  dog.add(body, tail);
  // Legs pivot at the hip so they can swing. Order: front-left, front-right, back-left, back-right.
  const legs: THREE.Object3D[] = [];
  const legGeo = colored(new THREE.BoxGeometry(0.09, 0.44, 0.09).translate(0, -0.2, 0), white);
  for (const [x, z] of [[0.3, 0.11], [0.3, -0.11], [-0.28, 0.11], [-0.28, -0.11]]) {
    const leg = new THREE.Mesh(legGeo, mat);
    leg.position.set(x, 0.42, z);
    leg.castShadow = true;
    dog.add(leg);
    legs.push(leg);
  }
  dog.scale.setScalar(1.25);
  return { dog, tail, legs };
}

// -------------------------------------------------------------- terrain

/** Gentle rolling hills, a bank rising outside the field, channels for streams, and a level pen. */
function makeHeights(def: MeadowDef): (x: number, y: number) => number {
  const p = def.pen;
  return (x: number, y: number) => {
    let h = (smoothNoise(x / 34, y / 34, def.seed) - 0.5) * 6 + (smoothNoise(x / 11, y / 11, def.seed + 3) - 0.5) * 1.2;
    const out = Math.max(0, -x, x - def.width, -y, y - def.height);
    h += Math.min(out, 12) * 0.55;
    for (const st of def.streams) {
      let d = Infinity;
      for (let i = 0; i + 1 < st.points.length; i++) {
        const [ax, ay] = st.points[i];
        const [bx, by] = st.points[i + 1];
        const t = segmentT(x, y, ax, ay, bx, by);
        d = Math.min(d, Math.hypot(x - (ax + (bx - ax) * t), y - (ay + (by - ay) * t)));
      }
      const r = st.width / 2 + 1.6;
      if (d < r) h = h * (d / r) - (1 - d / r) * 1.3;
    }
    // Level ground under and around the pen.
    const pd = Math.max(0, p.x - 2 - x, x - (p.x + p.w + 2), p.y - 2 - y, y - (p.y + p.h + 2));
    if (pd < 4) h *= pd / 4;
    return h;
  };
}

function groundColor(def: MeadowDef, x: number, y: number, out: THREE.Color): void {
  const n = smoothNoise(x / 20, y / 20, def.seed) * 0.7 + smoothNoise(x / 5, y / 5, def.seed + 9) * 0.3;
  const jitter = hash2(Math.round(x * 3), Math.round(y * 3), def.seed) * 0.04;
  const outside = x < -0.5 || y < -0.5 || x > def.width + 0.5 || y > def.height + 0.5;
  if (outside) out.setHSL(0.28, 0.55, 0.16 + n * 0.06 + jitter);
  else out.setHSL(0.24 + n * 0.04, 0.68, 0.24 + n * 0.11 + jitter);
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
