/** Tiny synthesized sound kit, so the prototype ships with zero audio files. */
class Sfx {
  ctx: AudioContext | null = null;
  enabled = true;
  private last: Record<string, number> = {};

  unlock(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Limits how often a sound can fire, so 200 sheep don't make 200 sounds. */
  private throttle(name: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.last[name] ?? 0) < ms) return false;
    this.last[name] = now;
    return true;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, vol: number, freq: number, q = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
  }

  baa(pitch = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.throttle('baa', 260)) return;
    const t0 = ctx.currentTime;
    const dur = 0.45;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const base = 230 * pitch * (0.9 + Math.random() * 0.2);
    o.frequency.setValueAtTime(base, t0);
    o.frequency.linearRampToValueAtTime(base * 0.92, t0 + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 8;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = base * 0.06;
    lfo.connect(lfoGain).connect(o.frequency);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1100;
    f.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(f).connect(g).connect(ctx.destination);
    o.start(t0);
    lfo.start(t0);
    o.stop(t0 + dur + 0.05);
    lfo.stop(t0 + dur + 0.05);
  }

  bark(): void {
    this.noise(0.12, 0.6, 700, 1.2);
    this.tone(420, 0.1, 'square', 0.06, 260);
    this.noise(0.1, 0.4, 900, 1.2);
  }

  pop(n: number): void {
    if (!this.throttle('pop', 60)) return;
    const f = 520 + Math.min(n, 30) * 18;
    this.tone(f, 0.09, 'sine', 0.1, f * 1.6);
  }

  thistle(): void {
    if (!this.throttle('thistle', 120)) return;
    this.tone(300, 0.15, 'triangle', 0.06, 180);
  }

  lost(): void {
    if (!this.throttle('lost', 200)) return;
    this.tone(330, 0.25, 'sine', 0.06, 200);
  }

  penned(): void {
    if (!this.throttle('pen', 45)) return;
    this.tone(880 + Math.random() * 200, 0.06, 'triangle', 0.05);
  }

  pickup(): void {
    this.tone(660, 0.1, 'triangle', 0.1);
    this.tone(990, 0.15, 'triangle', 0.1, undefined, 0.08);
  }

  star(i: number): void {
    this.tone(660 * Math.pow(1.26, i), 0.35, 'triangle', 0.12);
  }

  click(): void {
    this.tone(700, 0.04, 'square', 0.04);
  }

  fanfare(): void {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.1, undefined, i * 0.1));
  }
}

export const sfx = new Sfx();

export function haptic(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
}
