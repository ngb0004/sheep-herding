// Ad 1, "Stampede": 6 sheep snowball through the gates into a vast flock and pour home.
const path = require('path');
const { open, setCaption, setCount, endCard, Frames, encode } = require('./common.cjs');

const out = process.argv[2];
const quick = process.argv.includes('--quick');

(async () => {
  const { browser, page } = await open('http://localhost:4190/sheep-herding/play/?level=100&auto=good&capture&msaa=0', { dpr: quick ? 1 : 3 });
  const frames = new Frames(path.join(out, 'stampede-frames'));
  // Game speed (whole game-frames per video frame) by game time: slow for the gates, quick through the walk.
  const speedAt = (t, penned) => (t < 3 ? 1 : t < 22 ? 2 : t < 58 ? 4 : penned === 0 ? 6 : 4);
  let done = false;
  let doneFrames = 0;
  let firstGate = -1;
  while (doneFrames < 40) {
    const st = await page.evaluate(() => {
      const m = window.__flock.world;
      return { t: m.time, flock: m.gathered - m.penned, penned: m.penned, done: m.phase === 'done', total: m.total };
    });
    if (st.done) done = true;
    if (done) doneFrames++;
    if (firstGate < 0 && st.flock > 9) firstGate = frames.seconds;
    // Captions by story beat.
    let cap = '';
    if (st.t < 4) cap = 'Start with 6 sheep… 🐑';
    else if (firstGate >= 0 && frames.seconds - firstGate < 3) cap = 'Multiply them! ✨';
    else if (st.flock > 300 && st.penned === 0 && st.flock < 700) cap = 'Keep growing the flock 😮';
    else if (st.penned > 0 || st.flock >= 700) cap = 'Now bring them ALL home! 🏡';
    await setCaption(page, cap);
    await setCount(page, st.t < 3 ? '' : st.penned > 0 ? `🏠 ${st.penned}` : `🐑 ${st.flock}`);
    await frames.shoot(page);
    if (!done) await page.evaluate((n) => window.__flock.advance(n, 30), speedAt(st.t, st.penned));
    else await page.evaluate(() => window.__flock.advance(1, 30));
    if (frames.n % 30 === 0) console.log(`video ${frames.seconds.toFixed(1)}s game ${st.t.toFixed(1)}s flock ${st.flock} home ${st.penned}`);
    if (quick && frames.n > 2000) break;
  }
  const home = await page.evaluate(() => window.__flock.world.penned);
  await endCard(page, `<div class="em">🐑🐕</div><h1>Flock<br>Rescue</h1><p>${home} sheep home.<br>How many can YOU save?</p><div class="cta">Play free ▶</div>`);
  await frames.shoot(page, 75);
  await browser.close();
  encode(frames.dir, path.join(out, 'ad-stampede.mp4'));
  console.log('wrote', path.join(out, 'ad-stampede.mp4'), frames.seconds.toFixed(1) + 's');
})();
