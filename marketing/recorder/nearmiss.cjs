// Ad 2, "So close!": the flock pours into the pen... and the last sheep is left outside as night falls.
const path = require('path');
const { open, setCaption, setCount, endCard, Frames, encode } = require('./common.cjs');

const out = process.argv[2];
const quick = process.argv.includes('--quick');

(async () => {
  const { browser, page } = await open('http://localhost:4190/sheep-herding/play/?level=1&auto=good&capture&msaa=0', { dpr: quick ? 1 : 3 });
  const frames = new Frames(path.join(out, 'nearmiss-frames'));
  let stuck = false;
  let doneFrames = 0;
  while (doneFrames < 30) {
    const st = await page.evaluate((stuck) => {
      const f = window.__flock;
      const m = f.world;
      const c = m.flockCenter();
      const atGate = c.n > 0 && Math.hypot(c.x - (m.pen.left + m.pen.right) / 2, c.y - m.pen.bottom) < 8;
      if (!stuck && (atGate || m.penned > 0)) {
        // Stage the near miss: the dog eases off, the others drift in, and the
        // straggler furthest from the gate stops dead outside it.
        f.setAutopilot(null);
        const p = m.pen;
        let far = null;
        for (const s of m.sheep) {
          if (s.state !== 'active') continue;
          if (!far || Math.hypot(s.x - p.outsideX, s.y - p.outsideY) > Math.hypot(far.x - p.outsideX, far.y - p.outsideY)) far = s;
        }
        window.__straggler = far;
        stuck = true;
      }
      if (stuck) {
        m.target = { u: (m.dog.x - m.viewLeft()) / m.viewW, v: 1 - (m.dog.y - m.viewBottom()) / m.viewH };
        const s = window.__straggler;
        if (s && s.state === 'active') {
          s.gathered = false; s.fs = 0; s.panic = 0; s.vx *= 0.5; s.vy *= 0.5;
          // Keep the straggler a few steps outside the gate.
          const gy = m.pen.bottom - 3.5;
          if (s.y > gy) s.y = gy;
        }
      }
      return { t: m.time, limit: m.limit, penned: m.penned, total: m.total, done: m.phase === 'done', stuck };
    }, stuck);
    stuck = st.stuck;
    if (st.done) doneFrames++;
    const left = Math.ceil(st.limit - st.t);
    let cap = '';
    if (st.t < 5) cap = 'Get them ALL home before dark! 🌙';
    else if (!stuck && st.penned >= st.total - 6) cap = 'Almost… 🤞';
    else if (stuck && !st.done && st.penned < st.total - 1) cap = 'Almost… 🤞';
    else if (stuck && !st.done) cap = left <= 10 ? `HURRY!! ⏰ ${left}s` : 'Just 1 left!! 😱';
    else if (st.done) cap = `NOOO! ${st.penned}/${st.total} 😭`;
    await setCaption(page, cap);
    await setCount(page, st.t < 2 ? '' : `🏠 ${st.penned}/${st.total}`);
    await frames.shoot(page);
    // Normal speed as the flock reaches the gate, so the staging can't overshoot; fast through the sunset.
    const settling = stuck && st.penned < st.total - 1;
    const speed = st.t < 2 ? 1 : stuck ? (settling ? 1 : st.limit - st.t > 6 ? 8 : 2) : st.penned >= st.total - 10 ? 1 : 2;
    await page.evaluate((n) => window.__flock.advance(n, 30), st.done ? 1 : speed);
    if (frames.n % 30 === 0) console.log(`video ${frames.seconds.toFixed(1)}s game ${st.t.toFixed(1)}s home ${st.penned}/${st.total}`);
  }
  await frames.shoot(page, 20);
  await endCard(page, `<div class="em">😩🐑</div><h1>Only 2%</h1><p>bring every sheep home.<br><b>Can you?</b></p><div class="cta">Play free ▶</div>`);
  await frames.shoot(page, 75);
  await browser.close();
  encode(frames.dir, path.join(out, 'ad-so-close.mp4'));
  console.log('wrote', path.join(out, 'ad-so-close.mp4'), frames.seconds.toFixed(1) + 's');
})();
