import { Patch, World } from './world';

/**
 * A simple herding "player" used for balance tests and ad clips.
 *
 * Each moment it either gathers (gets behind the sheep furthest from the
 * flock and pushes it back in) or drives (stands behind the flock on the line
 * to the next good patch). `chooseBadPatches` makes it aim for the worst patch,
 * for "fail" ad clips.
 */
export class Autopilot {
  private barkTimer = 0;

  constructor(private readonly chooseBadPatches = false) {}

  update(w: World, dt: number): void {
    let cx = 0, cy = 0, n = 0;
    for (const s of w.sheep) {
      if (s.state !== 'active') continue;
      cx += s.x;
      cy += s.y;
      n++;
    }
    if (n === 0) return;
    cx /= n;
    cy /= n;

    // Goal: the best patch in the next row, or the pen gate near the end.
    let gx = w.level.width / 2;
    let gy = cy + 12;
    const target = this.nextPatch(w, cy);
    if (target) {
      gx = target.x;
      gy = target.y;
    }
    if (cy > w.pen.funnelStart - 12) {
      gx = (w.pen.left + w.pen.right) / 2;
      gy = w.pen.bottom + 4;
    }

    // Gather the worst stray first: a sheep far from the flock, especially one behind it.
    const spread = 2.5 + Math.sqrt(n) * 0.45;
    let worst: { x: number; y: number } | null = null;
    let worstScore = 0;
    for (const s of w.sheep) {
      if (s.state !== 'active') continue;
      const d = Math.hypot(s.x - cx, s.y - cy);
      const behind = Math.max(0, cy - s.y);
      const score = d - spread + behind * 0.6;
      if (score > worstScore) {
        worstScore = score;
        worst = s;
      }
    }

    const presence = w.stats.presence;
    let tx: number;
    let ty: number;
    if (worst && worstScore > 3) {
      // Go round to the far side of the stray and push it toward the flock.
      const dx = worst.x - cx;
      const dy = worst.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      tx = worst.x + (dx / d) * presence * 0.6;
      ty = worst.y + (dy / d) * presence * 0.6;
    } else {
      const dx = gx - cx;
      const dy = Math.max(4, gy - cy);
      const d = Math.hypot(dx, dy);
      const stand = presence * 0.35 + spread * 0.4;
      tx = cx - (dx / d) * stand;
      ty = cy - (dy / d) * stand;
    }

    w.target = {
      u: (tx - w.viewLeft()) / w.viewW,
      v: 1 - (ty - w.camY) / w.viewH,
    };

    this.barkTimer -= dt;
    if (this.barkTimer <= 0 && worst && worstScore > 6) {
      w.bark();
      this.barkTimer = 2.5;
    }
  }

  private nextPatch(w: World, cy: number): Patch | null {
    const ahead = w.patches.filter(
      (p) => p.y > cy + 1 && (p.kind === 'mult' || (p.kind === 'add' && !p.spent) || p.kind === 'thistle' || p.kind === 'bog'),
    );
    if (!ahead.length) return null;
    const rowY = ahead[0].y;
    const row = ahead.filter((p) => Math.abs(p.y - rowY) < 1);
    const value = (p: Patch) => (p.kind === 'mult' ? (p.value ?? 1) * 10 : p.kind === 'add' ? (p.value ?? 0) : -10);
    row.sort((a, b) => value(b) - value(a));
    const pick = this.chooseBadPatches ? row[row.length - 1] : row[0];
    // If the row has only bad patches, aim between them instead.
    if (value(pick) < 0 && !this.chooseBadPatches) return null;
    return pick;
  }
}
