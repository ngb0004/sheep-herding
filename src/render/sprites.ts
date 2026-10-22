/**
 * Pre-rendered top-down sprites, drawn once per zoom level and then stamped
 * with rotation. Every sprite faces +x (to the right) at angle 0.
 */
export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Size in metres; the sprite is centred on the animal. */
  size: number;
}

function makeCanvas(sizeM: number, pxPerM: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  const px = Math.max(8, Math.ceil(sizeM * pxPerM));
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d')!;
  ctx.translate(px / 2, px / 2);
  ctx.scale(pxPerM, pxPerM);
  return [c, ctx];
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export function sheepSprite(pxPerM: number, tint = '#f7f4ec'): Sprite {
  const size = 1.4;
  const [c, ctx] = makeCanvas(size, pxPerM);
  // fleece: a cluster of puffs
  const puffs: [number, number, number][] = [
    [-0.22, 0, 0.3], [0.05, 0, 0.32], [-0.08, -0.2, 0.24], [-0.08, 0.2, 0.24],
    [0.2, -0.13, 0.2], [0.2, 0.13, 0.2], [-0.34, -0.12, 0.18], [-0.34, 0.12, 0.18],
  ];
  ctx.fillStyle = 'rgba(120,110,95,0.35)';
  for (const [x, y, r] of puffs) blob(ctx, x + 0.02, y + 0.03, r);
  ctx.fillStyle = tint;
  for (const [x, y, r] of puffs) blob(ctx, x, y, r);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (const [x, y, r] of puffs) blob(ctx, x - r * 0.25, y - r * 0.25, r * 0.45);
  // head
  ctx.fillStyle = '#2a2522';
  ctx.beginPath();
  ctx.ellipse(0.42, 0, 0.17, 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  // ears
  ctx.beginPath();
  ctx.ellipse(0.36, -0.15, 0.08, 0.04, -0.6, 0, Math.PI * 2);
  ctx.ellipse(0.36, 0.15, 0.08, 0.04, 0.6, 0, Math.PI * 2);
  ctx.fill();
  // tuft on the head
  ctx.fillStyle = tint;
  blob(ctx, 0.3, 0, 0.08);
  return { canvas: c, size };
}

export function dogSprite(pxPerM: number): Sprite {
  const size = 2.0;
  const [c, ctx] = makeCanvas(size, pxPerM);
  // tail
  ctx.strokeStyle = '#1b1b1f';
  ctx.lineWidth = 0.14;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-0.45, 0);
  ctx.quadraticCurveTo(-0.75, 0.1, -0.85, 0.02);
  ctx.stroke();
  ctx.strokeStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.moveTo(-0.78, 0.07);
  ctx.lineTo(-0.88, 0.02);
  ctx.stroke();
  // body
  ctx.fillStyle = '#1b1b1f';
  ctx.beginPath();
  ctx.ellipse(-0.05, 0, 0.48, 0.24, 0, 0, Math.PI * 2);
  ctx.fill();
  // white collar
  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.ellipse(0.32, 0, 0.13, 0.25, 0, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.fillStyle = '#1b1b1f';
  ctx.beginPath();
  ctx.ellipse(0.55, 0, 0.2, 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  // ears
  ctx.beginPath();
  ctx.moveTo(0.48, -0.13);
  ctx.lineTo(0.4, -0.27);
  ctx.lineTo(0.58, -0.15);
  ctx.moveTo(0.48, 0.13);
  ctx.lineTo(0.4, 0.27);
  ctx.lineTo(0.58, 0.15);
  ctx.fill();
  // white blaze and muzzle
  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.ellipse(0.66, 0, 0.11, 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
  blob(ctx, 0.76, 0, 0.035);
  return { canvas: c, size };
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  s: Sprite,
  x: number,
  y: number,
  angle: number,
  pxPerM: number,
  scale = 1,
) {
  const px = s.size * pxPerM * scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.drawImage(s.canvas, -px / 2, -px / 2, px, px);
}
