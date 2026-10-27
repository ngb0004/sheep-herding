// Ad 3, "Cozy farm": build your little island farm, piece by piece, and dress up your pup.
const path = require('path');
const { open, setCaption, endCard, Frames, encode } = require('./common.cjs');

const out = process.argv[2];
const quick = process.argv.includes('--quick');
// Must match BUILD in src/render3d/farm3d.ts.
const BUILD = { barn: 3.2, cottage: 7.2, garden: 11.0, pond: 13.6, cap: 16.4 };
const CARDS = [
  { at: BUILD.barn, icon: '🛖', name: 'Red Barn', cost: 500 },
  { at: BUILD.cottage, icon: '🏡', name: 'Thatched Cottage', cost: 900 },
  { at: BUILD.garden, icon: '🌸', name: 'Flower Garden', cost: 300 },
  { at: BUILD.pond, icon: '🦆', name: 'Duck Pond', cost: 450 },
  { at: BUILD.cap, icon: '🧢', name: 'Flat Cap', cost: 150 },
];

(async () => {
  const { browser, page } = await open('http://localhost:4190/sheep-herding/play/?scene=farm&capture&msaa=0', { dpr: quick ? 1 : 3 });
  await page.waitForTimeout(2500);
  await page.addStyleTag({ content: `
    .farm-ui { position: absolute; inset: 0; pointer-events: none; z-index: 60; font-family: 'Inter', 'Noto Color Emoji', sans-serif; }
    .wool { position: absolute; top: 18px; right: 14px; background: #fff; border-radius: 22px; padding: 7px 14px; font-weight: 900; font-size: 20px; color: #3a2e1c; box-shadow: 0 4px 0 rgba(0,0,0,0.18); }
    .bcard { position: absolute; left: 50%; bottom: 42px; width: 270px; margin-left: -135px; background: #fffaf0; border-radius: 22px; padding: 12px 14px;
      display: flex; align-items: center; gap: 12px; box-shadow: 0 7px 0 rgba(0,0,0,0.18), 0 10px 30px rgba(0,0,0,0.18); }
    .bcard .ic { font-size: 40px; }
    .bcard .nm { flex: 1; font-weight: 900; font-size: 17px; color: #3a2e1c; line-height: 1.15; }
    .bcard .nm small { display: block; font-weight: 800; color: #8a7a5a; font-size: 14px; }
    .bcard .go { background: #4cc23a; color: #fff; font-weight: 900; font-size: 18px; padding: 10px 14px; border-radius: 14px; box-shadow: 0 4px 0 #2f8a24; }
    .bcard .go.pressed { transform: translateY(3px); box-shadow: 0 1px 0 #2f8a24; background: #3fb02f; }
    .finger { position: absolute; font-size: 46px; filter: drop-shadow(0 4px 4px rgba(0,0,0,0.3)); }
  ` });
  await page.evaluate(() => {
    const ui = document.createElement('div');
    ui.className = 'farm-ui';
    ui.innerHTML = '<div class="wool"></div><div class="bcard" style="display:none"><div class="ic"></div><div class="nm"></div><div class="go">Build!</div></div><div class="finger" style="display:none">👆</div>';
    document.getElementById('stage').appendChild(ui);
  });
  const frames = new Frames(path.join(out, 'farm-frames'));
  const total = 19.6;
  for (let f = 0; f < total * 30; f++) {
    const t = f / 30;
    // The card for the next thing to build slides up ~2s before it pops in; the finger taps Build.
    const card = CARDS.find((c) => t < c.at + 0.5 && t > c.at - 2.2);
    let wool = 2400;
    for (const c of CARDS) if (t >= c.at) wool -= c.cost;
    let cap = 'Bring your flock home… 🐑';
    if (t > 2) cap = 'Build your dream farm 🏡';
    if (t > BUILD.cottage - 1.5) cap = 'Make it cozy ☕';
    if (t > BUILD.garden - 1.5) cap = 'Grow a garden 🌸';
    if (t > BUILD.pond - 1.2) cap = 'Dig a duck pond 🦆';
    if (t > BUILD.cap - 1.2) cap = 'Dress up your pup! 🧢';
    await page.evaluate(({ card, wool, t }) => {
      document.querySelector('.wool').textContent = `🧶 ${wool.toLocaleString()}`;
      const el = document.querySelector('.bcard');
      const finger = document.querySelector('.finger');
      if (!card) {
        el.style.display = 'none';
        finger.style.display = 'none';
        return;
      }
      el.style.display = 'flex';
      const since = t - (card.at - 2.2);
      el.style.transform = `translateY(${Math.max(0, 1 - since / 0.3) * 160}px)`;
      el.querySelector('.ic').textContent = card.icon;
      el.querySelector('.nm').innerHTML = `${card.name}<small>🧶 ${card.cost}</small>`;
      const tapIn = card.at - t;
      el.querySelector('.go').classList.toggle('pressed', tapIn < 0.25 && tapIn > -0.1);
      finger.style.display = tapIn < 1.3 && tapIn > -0.4 ? 'block' : 'none';
      const press = tapIn < 0.25 && tapIn > -0.1 ? 10 : 0;
      finger.style.left = 268 + 'px';
      finger.style.top = 640 - 74 + Math.min(1, Math.max(0, tapIn - 0.3)) * 40 + press + 'px';
    }, { card, wool, t });
    await setCaption(page, cap);
    await page.evaluate(() => window.__farm.advance(1, 30));
    await frames.shoot(page);
    if (f % 30 === 0) console.log(`farm ${t.toFixed(1)}s`);
  }
  await page.evaluate(() => (document.querySelector('.farm-ui').style.display = 'none'));
  await endCard(page, `<div class="em">🏡🐑🐕</div><h1>Flock<br>Rescue</h1><p>Herd sheep. Build your farm.<br>Coming soon!</p><div class="cta">Play the demo ▶</div>`);
  await frames.shoot(page, 75);
  await browser.close();
  encode(frames.dir, path.join(out, 'ad-cozy-farm.mp4'));
  console.log('wrote', path.join(out, 'ad-cozy-farm.mp4'), frames.seconds.toFixed(1) + 's');
})();
