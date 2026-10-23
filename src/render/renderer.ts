import { DogStats } from '../game/dog';
import { Dog, Obstacle, Sheep } from '../game/flock';
import { Meadow, streamYAt } from '../game/meadow';
import { Patch, World } from '../game/world';
import { clamp, hash2 } from '../game/math';

/** What drawAnimals needs; both game modes provide it. */
interface AnimalScene {
  sheep: Sheep[];
  dog: Dog;
  stats: DogStats;
  boneTime: number;
  whistleTime: number;
}

/** Visible world rectangle, in metres. */
interface Bounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
}
import { Sprite, dogSprite, drawSprite, sheepSprite } from './sprites';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

interface FloatText {
  text: string;
  x: number;
  y: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  life: number;
  max: number;
  color: string;
}

const UI_FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const EMOJI = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/**
 * Draws a World onto a canvas. Works in device pixels; world metres are
 * converted with `k` (pixels per metre). Screen y grows downward, world y
 * grows forward up the field.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  dpr = 1;
  w = 0;
  h = 0;
  k = 1;
  private sheepSprite?: Sprite;
  private lambSprite?: Sprite;
  private dogSprite?: Sprite;
  private spriteK = 0;
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private rings: Ring[] = [];
  private shake = 0;
  /** Pre-rendered hill shading for the current meadow (2 px per metre, drawn smoothed). */
  private groundCache: { key: number; canvas: HTMLCanvasElement } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  /** Returns the view aspect (height / width) for the world. */
  resize(cssW: number, cssH: number): number {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.round(cssW * this.dpr);
    this.h = Math.round(cssH * this.dpr);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    return cssH / cssW;
  }

  // ------------------------------------------------------------ effects

  burst(x: number, y: number, color: string, n: number, speed = 3, size = 0.12) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.5 + Math.random() * 0.4, size, color });
    }
  }

  floatText(text: string, x: number, y: number, color: string, size = 1.1, life = 1.1) {
    this.texts.push({ text, x, y, life: 0, max: life, color, size });
  }

  ring(x: number, y: number, r: number, color: string, life = 0.45) {
    this.rings.push({ x, y, r, life: 0, max: life, color });
  }

  addShake(amount: number) {
    this.shake = Math.max(this.shake, amount);
  }

  // -------------------------------------------------------------- frame

  private ensureSprites(k: number) {
    // Re-render sprites only when the zoom changes noticeably.
    if (Math.abs(this.spriteK - k) / Math.max(1, this.spriteK) > 0.08) {
      this.spriteK = k;
      this.sheepSprite = sheepSprite(k * 1.15);
      this.lambSprite = sheepSprite(k * 1.15, '#fffaf0');
      this.dogSprite = dogSprite(k * 1.15);
    }
  }

  render(world: World, dt: number, t: number) {
    const ctx = this.ctx;
    this.k = this.w / world.viewW;
    const k = this.k;
    this.ensureSprites(k);

    let ox = 0;
    let oy = 0;
    if (this.shake > 0.01) {
      ox = (Math.random() - 0.5) * this.shake * k;
      oy = (Math.random() - 0.5) * this.shake * k;
      this.shake *= Math.pow(0.02, dt);
    }
    const left = world.viewLeft();
    const sx = (x: number) => (x - left) * k + ox;
    const sy = (y: number) => this.h - (y - world.camY) * k + oy;
    const top = world.camY + world.viewH;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawGround(world, sx, sy, left, top);
    this.drawPatches(world, sx, sy, t);
    this.drawPen(world, sx, sy);
    this.drawWalls(world, sx, sy, top);
    const bounds = { left, right: left + world.viewW, bottom: world.camY, top };
    this.drawObstacles(world.level.obstacles, bounds, sx, sy);
    this.drawAnimals(world, bounds, sx, sy, t);
    this.drawEffects(dt, sx, sy);
    this.drawPatchLabels(world, sx, sy, t);

    // Morning mist over the hill crest.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const mist = ctx.createLinearGradient(0, 0, 0, this.h * 0.18);
    mist.addColorStop(0, 'rgba(235,245,240,0.75)');
    mist.addColorStop(1, 'rgba(235,245,240,0)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, 0, this.w, this.h * 0.18);
    const v = ctx.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.35, this.w / 2, this.h / 2, this.h * 0.8);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,30,10,0.28)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  // ------------------------------------------------------------ meadow

  renderMeadow(m: Meadow, dt: number, t: number) {
    const ctx = this.ctx;
    this.k = this.w / m.viewW;
    const k = this.k;
    this.ensureSprites(k);
    let ox = 0;
    let oy = 0;
    if (this.shake > 0.01) {
      ox = (Math.random() - 0.5) * this.shake * k;
      oy = (Math.random() - 0.5) * this.shake * k;
      this.shake *= Math.pow(0.02, dt);
    }
    const left = m.viewLeft();
    const bottom = m.viewBottom();
    const sx = (x: number) => (x - left) * k + ox;
    const sy = (y: number) => this.h - (y - bottom) * k + oy;
    const b: Bounds = { left, right: left + m.viewW, bottom, top: bottom + m.viewH };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawMeadowGround(m, b, sx, sy);
    this.drawStreams(m, sx, sy, t);
    this.drawMeadowPen(m, sx, sy);
    this.drawMeadowWalls(m, b, sx, sy);
    this.drawObstacles(m.obstacles, b, sx, sy);
    this.drawAnimals(m, b, sx, sy, t);
    this.drawEffects(dt, sx, sy);
    this.drawSunset(m);
    this.drawPointers(m, sx, sy, t);
  }

  private drawMeadowGround(m: Meadow, b: Bounds, sx: (x: number) => number, sy: (y: number) => number) {
    const ctx = this.ctx;
    const k = this.k;
    const W = m.def.width;
    const H = m.def.height;
    ctx.fillStyle = '#2b5a20';
    ctx.fillRect(0, 0, this.w, this.h);

    // Rolling hills: smooth noise shading, rendered once per meadow and scaled up smoothly.
    const ground = this.meadowGround(m);
    const ppm = ground.width / W;
    const vx0 = Math.max(0, b.left);
    const vy0 = Math.max(0, b.bottom);
    const vx1 = Math.min(W, b.right);
    const vy1 = Math.min(H, b.top);
    if (vx1 > vx0 && vy1 > vy0) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        ground,
        vx0 * ppm, (H - vy1) * ppm, (vx1 - vx0) * ppm, (vy1 - vy0) * ppm,
        sx(vx0), sy(vy1), (vx1 - vx0) * k, (vy1 - vy0) * k,
      );
    }

    // Flowers and tufts.
    const cell = 1.6;
    for (let cx = Math.max(0, Math.floor(b.left / cell)); cx < Math.min(W / cell, b.right / cell + 1); cx++) {
      for (let cy = Math.max(0, Math.floor(b.bottom / cell)); cy < Math.min(H / cell, b.top / cell + 1); cy++) {
        const h = hash2(cx, cy, m.def.seed);
        if (h > 0.45) continue;
        const px = sx((cx + hash2(cx, cy, 7)) * cell);
        const py = sy((cy + hash2(cx, cy, 9)) * cell);
        if (h < 0.04) {
          ctx.fillStyle = '#ffffff';
          dot(ctx, px, py, 0.09 * k);
          ctx.fillStyle = '#ffd84a';
          dot(ctx, px, py, 0.04 * k);
        } else if (h < 0.07) {
          ctx.fillStyle = '#ffe14d';
          dot(ctx, px, py, 0.07 * k);
        } else {
          ctx.fillStyle = h < 0.25 ? 'rgba(25,80,15,0.3)' : 'rgba(180,225,120,0.3)';
          ctx.fillRect(px, py, 0.08 * k, 0.28 * k);
          ctx.fillRect(px + 0.12 * k, py + 0.05 * k, 0.07 * k, 0.22 * k);
        }
      }
    }

    // Hedgerow around the edge of the field.
    ctx.fillStyle = '#224d19';
    const step = 2.4;
    const ring = (x: number, y: number, i: number) => {
      if (x < b.left - 3 || x > b.right + 3 || y < b.bottom - 3 || y > b.top + 3) return;
      dot(ctx, sx(x), sy(y), (1.3 + hash2(i, 3, m.def.seed) * 0.6) * k);
    };
    for (let x = 0, i = 0; x <= W; x += step, i++) {
      ring(x, -1.2, i);
      ring(x, H + 1.2, i + 500);
    }
    for (let y = 0, i = 0; y <= H; y += step, i++) {
      ring(-1.2, y, i + 1000);
      ring(W + 1.2, y, i + 1500);
    }
  }

  private meadowGround(m: Meadow): HTMLCanvasElement {
    const key = m.def.id * 100000 + m.def.seed;
    if (this.groundCache?.key === key) return this.groundCache.canvas;
    const ppm = 2;
    const W = m.def.width;
    const H = m.def.height;
    const c = document.createElement('canvas');
    c.width = Math.ceil(W * ppm);
    c.height = Math.ceil(H * ppm);
    const g = c.getContext('2d')!;
    const img = g.createImageData(c.width, c.height);
    for (let py = 0; py < c.height; py++) {
      const y = H - py / ppm;
      for (let px = 0; px < c.width; px++) {
        const x = px / ppm;
        const n = smoothNoise(x / 22, y / 22, m.def.seed) * 0.75 + smoothNoise(x / 7, y / 7, m.def.seed + 1) * 0.25;
        const [r, gg, bb] = hslToRgb((96 + n * 8) / 360, (50 + n * 6) / 100, (36 + n * 15) / 100);
        const i = (py * c.width + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = gg;
        img.data[i + 2] = bb;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.groundCache = { key, canvas: c };
    return c;
  }

  private drawStreams(m: Meadow, sx: (x: number) => number, sy: (y: number) => number, t: number) {
    const ctx = this.ctx;
    const k = this.k;
    for (const st of m.def.streams) {
      const path = () => {
        ctx.beginPath();
        st.points.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      };
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      path();
      ctx.strokeStyle = '#6e5d3c';
      ctx.lineWidth = (st.width + 1.4) * k;
      ctx.stroke();
      path();
      ctx.strokeStyle = '#3f86bd';
      ctx.lineWidth = st.width * k;
      ctx.stroke();
      path();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = st.width * 0.25 * k;
      ctx.setLineDash([1.2 * k, 2.4 * k]);
      ctx.lineDashOffset = -t * 1.5 * k;
      ctx.stroke();
      ctx.setLineDash([]);

      for (const br of st.bridges) {
        const y = streamYAt(st, br.x);
        const half = st.width / 2 + 1.1;
        const x0 = sx(br.x - br.w / 2);
        const y0 = sy(y + half);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x0 + 0.25 * k, y0 + 0.3 * k, br.w * k, half * 2 * k);
        ctx.fillStyle = '#9a6f43';
        ctx.fillRect(x0, y0, br.w * k, half * 2 * k);
        ctx.strokeStyle = '#6d4a2a';
        ctx.lineWidth = 0.08 * k;
        for (let yy = -half; yy <= half; yy += 0.7) {
          ctx.beginPath();
          ctx.moveTo(x0, sy(y + yy));
          ctx.lineTo(x0 + br.w * k, sy(y + yy));
          ctx.stroke();
        }
        ctx.fillStyle = '#5c3d22';
        ctx.fillRect(x0 - 0.15 * k, y0, 0.3 * k, half * 2 * k);
        ctx.fillRect(x0 + br.w * k - 0.15 * k, y0, 0.3 * k, half * 2 * k);
      }
    }
  }

  private drawMeadowWalls(m: Meadow, b: Bounds, sx: (x: number) => number, sy: (y: number) => number) {
    const ctx = this.ctx;
    const k = this.k;
    for (const [ax, ay, bx, by] of m.def.walls) {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(len / 0.8));
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const y = ay + ((by - ay) * i) / n;
        if (x < b.left - 2 || x > b.right + 2 || y < b.bottom - 2 || y > b.top + 2) continue;
        const h = hash2(Math.round(x * 10), Math.round(y * 10), 5);
        ctx.fillStyle = `hsl(40, 6%, ${50 + h * 22}%)`;
        roundRect(ctx, sx(x) - 0.42 * k, sy(y) - 0.38 * k, 0.84 * k, 0.76 * k, 0.24 * k);
        ctx.fill();
      }
    }
  }

  private drawMeadowPen(m: Meadow, sx: (x: number) => number, sy: (y: number) => number) {
    const ctx = this.ctx;
    const k = this.k;
    const p = m.pen;
    ctx.fillStyle = '#d8c27a';
    ctx.fillRect(sx(p.left), sy(p.top), (p.right - p.left) * k, (p.top - p.bottom) * k);
    ctx.fillStyle = 'rgba(160,120,50,0.25)';
    for (let i = 0; i < 40; i++) {
      const x = p.left + hash2(i, 1, 2) * (p.right - p.left);
      const y = p.bottom + hash2(i, 2, 2) * (p.top - p.bottom);
      ctx.fillRect(sx(x), sy(y), 0.5 * k, 0.06 * k);
    }
    // Fences, leaving the gate open.
    const sides: [string, number, number, number, number][] = [
      ['south', p.left, p.bottom, p.right, p.bottom],
      ['north', p.left, p.top, p.right, p.top],
      ['west', p.left, p.bottom, p.left, p.top],
      ['east', p.right, p.bottom, p.right, p.top],
    ];
    for (const [side, ax, ay, bx, by] of sides) {
      if (side !== p.gate) {
        this.fence(sx(ax), sy(ay), sx(bx), sy(by));
        continue;
      }
      if (ay === by) {
        this.fence(sx(ax), sy(ay), sx(p.gateA), sy(by));
        this.fence(sx(p.gateB), sy(ay), sx(bx), sy(by));
        ctx.fillStyle = '#4a2f18';
        dot(ctx, sx(p.gateA), sy(ay), 0.32 * k);
        dot(ctx, sx(p.gateB), sy(ay), 0.32 * k);
      } else {
        this.fence(sx(ax), sy(ay), sx(bx), sy(p.gateA));
        this.fence(sx(ax), sy(p.gateB), sx(bx), sy(by));
        ctx.fillStyle = '#4a2f18';
        dot(ctx, sx(ax), sy(p.gateA), 0.32 * k);
        dot(ctx, sx(ax), sy(p.gateB), 0.32 * k);
      }
    }
    // Count sign.
    const cx = sx((p.left + p.right) / 2);
    const cy = sy(p.top - 1.4);
    ctx.font = `800 ${0.85 * k}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5c3d22';
    roundRect(ctx, cx - 2 * k, cy - 0.55 * k, 4 * k, 1.1 * k, 0.2 * k);
    ctx.fill();
    ctx.fillStyle = '#fff6dc';
    ctx.fillText(`PEN ${m.penned}/${m.total}`, cx, cy);
  }

  /** Warm evening light that deepens toward sunset. */
  private drawSunset(m: Meadow) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const p = m.time / m.limit;
    const warm = smoothstep(0.4, 1, p);
    if (warm > 0) {
      ctx.fillStyle = `rgba(255,140,40,${(0.22 * warm).toFixed(3)})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    const dusk = smoothstep(0.8, 1, p);
    if (dusk > 0) {
      ctx.fillStyle = `rgba(60,20,90,${(0.28 * dusk).toFixed(3)})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    const v = ctx.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.35, this.w / 2, this.h / 2, this.h * 0.8);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,25,10,${(0.25 + dusk * 0.25).toFixed(3)})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  /** Edge-of-screen arrows to the pen and to the nearest sheep still out grazing. */
  private drawPointers(m: Meadow, sx: (x: number) => number, sy: (y: number) => number, t: number) {
    const p = m.pen;
    this.pointer(sx((p.left + p.right) / 2), sy((p.bottom + p.top) / 2), '🏠', '#ffe7a8', t);

    let best: Sheep | null = null;
    let bestD = Infinity;
    for (const s of m.sheep) {
      if (s.state !== 'active' || s.gathered) continue;
      const d = Math.hypot(s.x - m.dog.x, s.y - m.dog.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      let n = 0;
      for (const s of m.sheep) if (s.state === 'active' && !s.gathered && Math.hypot(s.x - best.x, s.y - best.y) < 8) n++;
      this.pointer(sx(best.x), sy(best.y), '🐑' + n, '#ffffff', t);
    }
  }

  private pointer(px: number, py: number, label: string, color: string, t: number) {
    const ctx = this.ctx;
    const margin = 34 * this.dpr;
    const topInset = 92 * this.dpr;
    const bottomInset = 110 * this.dpr;
    if (px > margin && px < this.w - margin && py > topInset && py < this.h - bottomInset) return;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const dx = px - cx;
    const dy = py - cy;
    // Scale the direction until it hits the inset rectangle.
    const sxk = dx === 0 ? Infinity : ((dx > 0 ? this.w - margin : margin) - cx) / dx;
    const syk = dy === 0 ? Infinity : ((dy > 0 ? this.h - bottomInset : topInset) - cy) / dy;
    const s = Math.min(sxk, syk);
    const x = cx + dx * s;
    const y = cy + dy * s;
    const a = Math.atan2(dy, dx);
    const pulse = 1 + Math.sin(t * 5) * 0.06;
    const r = 20 * this.dpr * pulse;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(20,40,15,0.75)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * (r + 10 * this.dpr), y + Math.sin(a) * (r + 10 * this.dpr));
    ctx.lineTo(x + Math.cos(a + 0.5) * r, y + Math.sin(a + 0.5) * r);
    ctx.lineTo(x + Math.cos(a - 0.5) * r, y + Math.sin(a - 0.5) * r);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(12 * this.dpr)}px ${EMOJI}`;
    ctx.fillStyle = color;
    ctx.fillText(label, x, y + 1);
  }

  private drawGround(world: World, sx: (x: number) => number, sy: (y: number) => number, left: number, top: number) {
    const ctx = this.ctx;
    const k = this.k;
    const W = world.level.width;
    const bottom = world.camY - 2;

    // Off-field rough grass.
    ctx.fillStyle = '#3f7a2c';
    ctx.fillRect(0, 0, this.w, this.h);

    // Mowing stripes with a slow light/dark roll to suggest hills.
    const band = 4;
    const start = Math.floor(bottom / band) * band;
    for (let y = start; y < top + band; y += band) {
      const hill = Math.sin(y * 0.035) * 0.5 + 0.5;
      const stripe = (Math.floor(y / band) & 1) === 0;
      const l = 40 + hill * 9 + (stripe ? 3 : 0);
      ctx.fillStyle = `hsl(98, 52%, ${l}%)`;
      ctx.fillRect(sx(0), sy(y + band), W * k, band * k + 1);
    }

    // Flowers, clover and tufts.
    const cell = 1.6;
    const x0 = Math.max(0, Math.floor(left / cell));
    const x1 = Math.min(Math.ceil(W / cell), Math.ceil((left + world.viewW) / cell));
    const y0 = Math.floor(bottom / cell);
    const y1 = Math.ceil(top / cell);
    for (let cx = x0; cx < x1; cx++) {
      for (let cy = y0; cy < y1; cy++) {
        const h = hash2(cx, cy, world.level.seed);
        if (h > 0.5) continue;
        const px = sx((cx + hash2(cx, cy, 7)) * cell);
        const py = sy((cy + hash2(cx, cy, 9)) * cell);
        if (h < 0.05) {
          ctx.fillStyle = '#ffffff';
          dot(ctx, px, py, 0.09 * k);
          ctx.fillStyle = '#ffd84a';
          dot(ctx, px, py, 0.04 * k);
        } else if (h < 0.08) {
          ctx.fillStyle = '#ffe14d';
          dot(ctx, px, py, 0.07 * k);
        } else {
          ctx.fillStyle = h < 0.3 ? 'rgba(30,90,20,0.35)' : 'rgba(170,220,110,0.35)';
          ctx.fillRect(px, py, 0.08 * k, 0.28 * k);
          ctx.fillRect(px + 0.12 * k, py + 0.05 * k, 0.07 * k, 0.22 * k);
        }
      }
    }

    // Hedgerows outside the walls.
    for (const side of [-1, 1]) {
      const baseX = side < 0 ? -1.8 : W + 1.8;
      for (let y = Math.floor(bottom / 2.2) * 2.2; y < top + 2; y += 2.2) {
        const r = (1.2 + hash2(Math.round(y * 10), side, 3) * 0.7) * k;
        ctx.fillStyle = '#2d5e22';
        dot(ctx, sx(baseX), sy(y), r);
        ctx.fillStyle = '#3c7a2c';
        dot(ctx, sx(baseX) - r * 0.25, sy(y) - r * 0.25, r * 0.6);
      }
    }
  }

  private drawWalls(world: World, sx: (x: number) => number, sy: (y: number) => number, top: number) {
    const ctx = this.ctx;
    const k = this.k;
    const pen = world.pen;
    const bottom = world.camY - 2;
    // Dry-stone walls up both sides, until the funnel starts.
    for (const x of [0, world.level.width]) {
      for (let y = Math.floor(bottom / 0.8) * 0.8; y < Math.min(top + 1, pen.funnelStart); y += 0.8) {
        const h = hash2(Math.round(y * 10), x, 5);
        ctx.fillStyle = `hsl(40, 6%, ${52 + h * 22}%)`;
        roundRect(ctx, sx(x) - 0.38 * k, sy(y + 0.8), 0.76 * k, 0.74 * k, 0.22 * k);
        ctx.fill();
      }
    }
    // Wooden fences: funnel and pen.
    for (const seg of world.segments.slice(1, 6)) this.fence(sx(seg.ax), sy(seg.ay), sx(seg.bx), sy(seg.by));
  }

  private fence(ax: number, ay: number, bx: number, by: number) {
    const ctx = this.ctx;
    const k = this.k;
    ctx.strokeStyle = '#7a5532';
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.18 * k;
    for (const off of [-0.12, 0.12]) {
      ctx.beginPath();
      ctx.moveTo(ax, ay + off * k);
      ctx.lineTo(bx, by + off * k);
      ctx.stroke();
    }
    const len = Math.hypot(bx - ax, by - ay) / k;
    const n = Math.max(1, Math.round(len / 2));
    ctx.fillStyle = '#5c3d22';
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      dot(this.ctx, ax + (bx - ax) * t, ay + (by - ay) * t, 0.2 * k);
    }
  }

  private drawPen(world: World, sx: (x: number) => number, sy: (y: number) => number) {
    const ctx = this.ctx;
    const k = this.k;
    const p = world.pen;
    ctx.fillStyle = '#d8c27a';
    ctx.fillRect(sx(p.left), sy(p.top), (p.right - p.left) * k, (p.top - p.bottom) * k);
    ctx.fillStyle = 'rgba(160,120,50,0.25)';
    for (let i = 0; i < 40; i++) {
      const x = p.left + hash2(i, 1, 2) * (p.right - p.left);
      const y = p.bottom + hash2(i, 2, 2) * (p.top - p.bottom);
      ctx.fillRect(sx(x), sy(y), 0.5 * k, 0.06 * k);
    }
    // Funnel fill so the pasture reads as closing in.
    ctx.fillStyle = '#3f7a2c';
    ctx.beginPath();
    ctx.moveTo(sx(0), sy(p.funnelStart));
    ctx.lineTo(sx(p.left), sy(p.bottom));
    ctx.lineTo(sx(p.left), sy(p.top + 20));
    ctx.lineTo(sx(0), sy(p.top + 20));
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx(world.level.width), sy(p.funnelStart));
    ctx.lineTo(sx(p.right), sy(p.bottom));
    ctx.lineTo(sx(p.right), sy(p.top + 20));
    ctx.lineTo(sx(world.level.width), sy(p.top + 20));
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#3f7a2c';
    ctx.fillRect(sx(p.left), sy(p.top + 20), (p.right - p.left) * k, 20 * k);

    // Sign
    ctx.font = `800 ${0.9 * k}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5c3d22';
    roundRect(ctx, sx((p.left + p.right) / 2) - 1.6 * k, sy(p.bottom + 1.6) - 0.55 * k, 3.2 * k, 1.1 * k, 0.2 * k);
    ctx.fill();
    ctx.fillStyle = '#fff6dc';
    ctx.fillText('PEN', sx((p.left + p.right) / 2), sy(p.bottom + 1.6));
  }

  private drawPatches(world: World, sx: (x: number) => number, sy: (y: number) => number, t: number) {
    const ctx = this.ctx;
    const k = this.k;
    const bottom = world.camY - 4;
    const top = world.camY + world.viewH + 4;
    for (const p of world.patches) {
      if (p.y + p.h < bottom || p.y - p.h > top) continue;
      const x = sx(p.x - p.w / 2);
      const y = sy(p.y + p.h / 2);
      const w = p.w * k;
      const h = p.h * k;
      const pulse = 0.5 + 0.5 * Math.sin(t * 4 + p.id);
      ctx.globalAlpha = p.spent && p.kind !== 'mult' && p.kind !== 'bog' && p.kind !== 'thistle' ? 0.35 : 1;
      switch (p.kind) {
        case 'mult': {
          ctx.fillStyle = `rgba(120,255,90,${0.28 + pulse * 0.12})`;
          roundRect(ctx, x, y, w, h, 0.6 * k);
          ctx.fill();
          ctx.strokeStyle = 'rgba(230,255,200,0.9)';
          ctx.lineWidth = 0.12 * k;
          ctx.stroke();
          ctx.fillStyle = 'rgba(40,140,30,0.55)';
          for (let i = 0; i < 6; i++) clover(ctx, x + w * (0.12 + 0.16 * i), y + h * (i % 2 ? 0.25 : 0.75), 0.22 * k);
          break;
        }
        case 'add':
          ctx.fillStyle = '#e8cc72';
          roundRect(ctx, x, y, w, h, 0.9 * k);
          ctx.fill();
          ctx.strokeStyle = '#b08a32';
          ctx.lineWidth = 0.1 * k;
          for (let i = 0; i < 9; i++) {
            const a = (i / 9) * Math.PI;
            ctx.beginPath();
            ctx.moveTo(x + w / 2 + Math.cos(a) * w * 0.4, y + h / 2 + Math.sin(a) * h * 0.3);
            ctx.lineTo(x + w / 2 - Math.cos(a) * w * 0.4, y + h / 2 - Math.sin(a) * h * 0.3);
            ctx.stroke();
          }
          break;
        case 'thistle':
          ctx.fillStyle = 'rgba(120,40,140,0.32)';
          roundRect(ctx, x, y, w, h, 0.6 * k);
          ctx.fill();
          for (let i = 0; i < 7; i++) {
            const tx = x + w * hash2(p.id, i, 1);
            const ty = y + h * hash2(p.id, i, 2);
            ctx.fillStyle = '#2f6b2a';
            spikes(ctx, tx, ty + 0.15 * k, 0.3 * k);
            ctx.fillStyle = '#a33fc2';
            dot(ctx, tx, ty, 0.16 * k);
          }
          break;
        case 'bog':
          ctx.fillStyle = '#6b5232';
          roundRect(ctx, x, y, w, h, 1.2 * k);
          ctx.fill();
          ctx.strokeStyle = 'rgba(200,180,140,0.45)';
          ctx.lineWidth = 0.08 * k;
          for (let i = 0; i < 4; i++) {
            const r = ((t * 0.6 + i * 0.25) % 1) * 0.9 * k;
            ctx.beginPath();
            ctx.ellipse(x + w * hash2(p.id, i, 3), y + h * hash2(p.id, i, 4), r * 1.6, r, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          break;
        case 'bone':
        case 'whistle': {
          if (p.spent) break;
          const cx = sx(p.x);
          const cy = sy(p.y) - Math.sin(t * 3 + p.id) * 0.15 * k;
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          dot(ctx, cx, cy, 0.85 * k);
          ctx.strokeStyle = p.kind === 'bone' ? '#ff9b2f' : '#3fa9ff';
          ctx.lineWidth = 0.14 * k;
          ctx.beginPath();
          ctx.arc(cx, cy, 0.85 * k, 0, Math.PI * 2);
          ctx.stroke();
          ctx.font = `${0.95 * k}px ${EMOJI}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.kind === 'bone' ? '🦴' : '📯', cx, cy + 0.05 * k);
          break;
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawPatchLabels(world: World, sx: (x: number) => number, sy: (y: number) => number, t: number) {
    const ctx = this.ctx;
    const k = this.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of world.patches) {
      if (p.y < world.camY - 4 || p.y > world.camY + world.viewH + 4) continue;
      let label = '';
      let color = '#fff';
      if (p.kind === 'mult') label = '×' + p.value;
      else if (p.kind === 'add') label = '+' + p.value;
      else if (p.kind === 'thistle') { label = '✖'; color = '#f3d6ff'; }
      if (!label) continue;
      if (p.kind === 'add' && p.spent) continue;
      const size = (p.kind === 'thistle' ? 0.9 : 1.5) * k * (1 + 0.04 * Math.sin(t * 5 + p.id));
      ctx.font = `900 ${size}px ${UI_FONT}`;
      ctx.lineWidth = 0.22 * k;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.strokeText(label, sx(p.x), sy(p.y));
      ctx.fillStyle = color;
      ctx.fillText(label, sx(p.x), sy(p.y));

      if (p.gain > 0) this.gainLabel(p, sx, sy);
    }
  }

  private gainLabel(p: Patch, sx: (x: number) => number, sy: (y: number) => number) {
    const ctx = this.ctx;
    const k = this.k;
    const age = 1.4 - p.gainTimer;
    const pop = age < 0.12 ? 1 + (0.12 - age) * 4 : 1;
    ctx.globalAlpha = Math.min(1, p.gainTimer * 2);
    ctx.font = `900 ${1.3 * k * pop}px ${UI_FONT}`;
    const y = sy(p.y + p.h / 2 + 1.2 + age * 1.2);
    ctx.lineWidth = 0.25 * k;
    ctx.strokeStyle = 'rgba(0,60,0,0.6)';
    ctx.strokeText('+' + p.gain, sx(p.x), y);
    ctx.fillStyle = '#d8ff6a';
    ctx.fillText('+' + p.gain, sx(p.x), y);
    ctx.globalAlpha = 1;
  }

  private drawObstacles(obstacles: Obstacle[], b: Bounds, sx: (x: number) => number, sy: (y: number) => number) {
    const ctx = this.ctx;
    const k = this.k;
    for (const o of obstacles) {
      if (o.y < b.bottom - 4 || o.y > b.top + 4 || o.x < b.left - 4 || o.x > b.right + 4) continue;
      const x = sx(o.x);
      const y = sy(o.y);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(x + 0.2 * k, y + 0.25 * k, o.r * k, o.r * 0.8 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      if (o.kind === 'tree') {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        dot(ctx, x + 0.5 * k, y + 0.6 * k, o.r * 1.5 * k);
        ctx.fillStyle = '#245c1e';
        dot(ctx, x, y, o.r * 1.4 * k);
        ctx.fillStyle = '#2f7526';
        dot(ctx, x - o.r * 0.35 * k, y - o.r * 0.35 * k, o.r * 0.95 * k);
        ctx.fillStyle = '#3f8f33';
        dot(ctx, x - o.r * 0.55 * k, y - o.r * 0.55 * k, o.r * 0.5 * k);
      } else if (o.kind === 'rock') {
        ctx.fillStyle = '#8d8a80';
        dot(ctx, x, y, o.r * k);
        ctx.fillStyle = '#aaa79c';
        dot(ctx, x - o.r * 0.3 * k, y - o.r * 0.3 * k, o.r * 0.55 * k);
      } else {
        ctx.fillStyle = '#2f6d25';
        dot(ctx, x, y, o.r * k);
        ctx.fillStyle = '#46913a';
        dot(ctx, x - o.r * 0.25 * k, y - o.r * 0.3 * k, o.r * 0.6 * k);
        ctx.fillStyle = '#e4495a';
        for (let i = 0; i < 4; i++) dot(ctx, x + (hash2(i, o.x | 0, 1) - 0.5) * o.r * k, y + (hash2(i, o.y | 0, 2) - 0.5) * o.r * k, 0.08 * k);
      }
    }
  }

  private drawAnimals(world: AnimalScene, b: Bounds, sx: (x: number) => number, sy: (y: number) => number, t: number) {
    const ctx = this.ctx;
    const k = this.k;
    const bottom = b.bottom - 3;
    const top = b.top + 3;

    // Shadows first so no sheep's shadow covers another sheep.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(20,50,10,0.28)';
    ctx.beginPath();
    for (const s of world.sheep) {
      if (s.state === 'lost' || s.y < bottom || s.y > top) continue;
      const r = (s.lamb ? 0.3 : 0.45) * k;
      const x = sx(s.x) + 0.12 * k;
      const y = sy(s.y) + 0.15 * k;
      ctx.moveTo(x + r, y);
      ctx.ellipse(x, y, r, r * 0.8, 0, 0, Math.PI * 2);
    }
    ctx.fill();

    for (const s of world.sheep) {
      if (s.state === 'lost' || s.y < bottom || s.y > top) continue;
      const bob = 1 + Math.sin(s.phase * 3) * 0.035;
      const sprite = s.lamb ? this.lambSprite! : this.sheepSprite!;
      drawSprite(ctx, sprite, sx(s.x), sy(s.y), -s.heading, k, (s.lamb ? 0.68 : 1) * bob);
    }

    // Dog
    const d = world.dog;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (world.boneTime > 0 || world.whistleTime > 0) {
      ctx.fillStyle = world.boneTime > 0 ? 'rgba(255,160,40,0.3)' : 'rgba(60,170,255,0.3)';
      dot(ctx, sx(d.x), sy(d.y), 1.1 * k * (1 + 0.1 * Math.sin(t * 10)));
    }
    // Presence circle: lets players learn their dog's reach.
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 0.08 * k;
    ctx.beginPath();
    ctx.arc(sx(d.x), sy(d.y), world.stats.presence * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(20,50,10,0.3)';
    ctx.beginPath();
    ctx.ellipse(sx(d.x) + 0.12 * k, sy(d.y) + 0.15 * k, 0.6 * k, 0.4 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    const run = Math.hypot(d.vx, d.vy);
    drawSprite(ctx, this.dogSprite!, sx(d.x), sy(d.y), -d.heading, k, 1 + Math.sin(t * 18) * 0.03 * Math.min(1, run / 3));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawEffects(dt: number, sx: (x: number) => number, sy: (y: number) => number) {
    const ctx = this.ctx;
    const k = this.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    this.rings = this.rings.filter((r) => (r.life += dt) < r.max);
    for (const r of this.rings) {
      const p = r.life / r.max;
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 0.25 * k * (1 - p) + 1;
      ctx.beginPath();
      ctx.arc(sx(r.x), sy(r.y), r.r * k * (0.3 + 0.7 * p), 0, Math.PI * 2);
      ctx.stroke();
    }

    this.particles = this.particles.filter((p) => (p.life += dt) < p.max);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      dot(ctx, sx(p.x), sy(p.y), p.size * k);
    }

    this.texts = this.texts.filter((f) => (f.life += dt) < f.max);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.texts) {
      const p = f.life / f.max;
      ctx.globalAlpha = p > 0.7 ? 1 - (p - 0.7) / 0.3 : 1;
      ctx.font = `900 ${f.size * k}px ${UI_FONT}`;
      const y = sy(f.y + p * 1.5);
      ctx.lineWidth = 0.2 * k;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.strokeText(f.text, sx(f.x), y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, sx(f.x), y);
    }
    ctx.globalAlpha = 1;
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
  ctx.fill();
}

function clover(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    dot(ctx, x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.55);
  }
}

function spikes(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const rr = i % 2 ? r * 0.4 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smooth value noise in [0, 1). */
function smoothNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}
