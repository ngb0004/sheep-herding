import { haptic, sfx } from './audio';
import { Autopilot } from './game/autopilot';
import { MAX_STAT_LEVEL, STAT_IDS, STAT_INFO, StatId, dogStats, upgradeCost } from './game/dog';
import { getLevel, starTargets } from './game/levels';
import { World } from './game/world';
import { Renderer } from './render/renderer';
import { SaveData, loadSave, writeSave } from './save';

type Screen = 'home' | 'playing' | 'paused' | 'results' | 'upgrades';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const canvas = $<HTMLCanvasElement>('game');
const overlay = $('overlay');
const hud = $('hud');
const countEl = $('count');
const progressEl = $('progress-fill');
const levelNameEl = $('level-name');
const bannerEl = $('banner');
const hintEl = $('hint');
const barkBtn = $<HTMLButtonElement>('bark');

const renderer = new Renderer(canvas);
const save: SaveData = loadSave();
sfx.enabled = save.sound;

const params = new URLSearchParams(location.search);
let screen: Screen = 'home';
let levelId = Number(params.get('level')) || save.unlocked;
let world = makeWorld(levelId);
let aspect = 2;
let lastCount = 0;
let doneAt = 0;
let lastFrame = performance.now();
let acc = 0;
let pointerActive = false;
let barkWasReady = true;
const keys = new Set<string>();
// ?auto=good|bad lets the autopilot herd (for testing and recording ad clips).
const autoMode = params.get('auto');
let pilot: Autopilot | null = autoMode ? new Autopilot(autoMode === 'bad') : null;

// ---------------------------------------------------------------- layout

function layout() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Portrait play area: full screen on phones, a column on wide screens.
  const w = Math.min(vw, Math.round(vh * 0.62));
  const h = vh;
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  stage.style.left = Math.round((vw - w) / 2) + 'px';
  stage.style.top = '0px';
  aspect = renderer.resize(w, h);
  world.setViewAspect(aspect);
}

function makeWorld(id: number): World {
  return new World(getLevel(id), dogStats(save.dog), aspect || 2);
}

window.addEventListener('resize', layout);
layout();

// ----------------------------------------------------------------- input

function setTarget(e: PointerEvent) {
  const r = canvas.getBoundingClientRect();
  // Lift the target above a fingertip so the dog isn't hidden under it.
  const lift = e.pointerType === 'touch' ? 50 : 0;
  world.target = {
    u: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    v: Math.min(0.98, Math.max(0.02, (e.clientY - r.top - lift) / r.height)),
  };
  if (screen === 'playing') hintEl.classList.add('gone');
}

canvas.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  pointerActive = true;
  canvas.setPointerCapture(e.pointerId);
  setTarget(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (pointerActive || e.pointerType === 'mouse') setTarget(e);
});
canvas.addEventListener('pointerup', () => (pointerActive = false));
canvas.addEventListener('pointercancel', () => (pointerActive = false));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

barkBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  sfx.unlock();
  doBark();
});

$('pause').addEventListener('click', () => pause());

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') {
    e.preventDefault();
    if (screen === 'playing' && !e.repeat) doBark();
  }
  if (e.code === 'Escape') {
    if (screen === 'playing') pause();
    else if (screen === 'paused') resume();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && screen === 'playing') pause();
});

function keyboardSteer(dt: number) {
  let du = 0;
  let dv = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) du -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) du += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) dv -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) dv += 1;
  if (du || dv) {
    world.target = {
      u: Math.min(1, Math.max(0, world.target.u + du * dt * 0.7)),
      v: Math.min(0.98, Math.max(0.02, world.target.v + dv * dt * 0.5)),
    };
    hintEl.classList.add('gone');
  }
}

function doBark() {
  if (screen !== 'playing') return;
  if (world.bark()) haptic(25);
}

// ------------------------------------------------------------ game loop

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (screen === 'playing') {
    keyboardSteer(dt);
    acc += dt;
    let steps = 0;
    while (acc >= 1 / 60 && steps < 4) {
      pilot?.update(world, 1 / 60);
      world.step(1 / 60);
      acc -= 1 / 60;
      steps++;
    }
    handleEvents();
    updateHud();
    if (world.phase === 'done' && doneAt && now - doneAt > 1300) {
      doneAt = 0;
      finishLevel();
    }
  } else {
    acc = 0;
  }
  renderer.render(world, screen === 'playing' ? dt : 0, now / 1000);
}

function handleEvents() {
  for (const e of world.events) {
    switch (e.type) {
      case 'gain':
        sfx.pop(e.patch.gain);
        renderer.burst(e.x, e.y, '#ffffff', 3, 2.5, 0.14);
        if (Math.random() < 0.15) sfx.baa(1.2);
        haptic(6);
        break;
      case 'thistle':
        sfx.thistle();
        renderer.burst(e.x, e.y, '#c45ae0', 4, 3);
        if (Math.random() < 0.3) sfx.baa(1.4);
        break;
      case 'lost':
        sfx.lost();
        renderer.floatText('-1', e.x, e.y + 1.5, '#ff7070', 1);
        break;
      case 'penned':
        sfx.penned();
        renderer.burst(e.x, e.y, '#ffe27a', 2, 2, 0.1);
        if (Math.random() < 0.08) sfx.baa();
        break;
      case 'bark':
        sfx.bark();
        renderer.ring(e.x, e.y, e.radius, 'rgba(255,255,255,0.9)');
        renderer.addShake(0.25);
        break;
      case 'pickup':
        sfx.pickup();
        renderer.ring(e.x, e.y, 3, e.kind === 'bone' ? '#ff9b2f' : '#3fa9ff');
        renderer.floatText(e.kind === 'bone' ? 'ZOOM!' : 'HUDDLE!', e.x, e.y + 1, '#fff', 1.2);
        break;
      case 'finale':
        showBanner('Pen them!');
        break;
      case 'done':
        doneAt = performance.now();
        showBanner(world.penned > 0 ? `${world.penned} penned!` : 'They got away…');
        break;
    }
  }
  world.events.length = 0;
}

function updateHud() {
  const count = world.penned + world.activeCount();
  if (count !== lastCount) {
    countEl.textContent = '🐑 ' + count;
    if (count > lastCount) {
      countEl.classList.add('pop');
      setTimeout(() => countEl.classList.remove('pop'), 90);
    }
    lastCount = count;
  }
  progressEl.style.width = (world.progress() * 100).toFixed(1) + '%';
  const cd = world.dog.barkCooldown / world.stats.barkCooldown;
  barkBtn.style.setProperty('--cd', cd.toFixed(3));
  const ready = cd <= 0;
  if (ready && !barkWasReady) {
    barkBtn.classList.remove('ready');
    void barkBtn.offsetWidth;
    barkBtn.classList.add('ready');
  }
  barkWasReady = ready;
  if (world.phase === 'finale') {
    levelNameEl.textContent = `Pen them! ${world.activeCount()} left`;
  }
}

let bannerTimer = 0;
function showBanner(text: string) {
  bannerEl.textContent = text;
  bannerEl.classList.remove('hidden');
  bannerEl.style.animation = 'none';
  void bannerEl.offsetWidth;
  bannerEl.style.animation = '';
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => bannerEl.classList.add('hidden'), 1500);
}

// --------------------------------------------------------------- screens

function startLevel(id: number) {
  sfx.unlock();
  levelId = id;
  world = makeWorld(id);
  world.setViewAspect(aspect);
  lastCount = -1;
  doneAt = 0;
  screen = 'playing';
  overlay.innerHTML = '';
  hud.classList.remove('hidden');
  hintEl.classList.toggle('gone', id > 2);
  window.setTimeout(() => hintEl.classList.add('gone'), 5000);
  levelNameEl.textContent = `Level ${id} · ${world.level.name}`;
  showBanner(`Level ${id}`);
  updateHud();
}

function pause() {
  if (screen !== 'playing') return;
  screen = 'paused';
  overlay.innerHTML = `
    <div class="screen" style="justify-content:center">
      <div class="card" style="text-align:center">
        <h2>Paused</h2>
        <p class="muted">${world.level.name}</p>
        <div style="display:grid;gap:10px">
          <button class="btn primary" data-act="resume">Resume</button>
          <button class="btn" data-act="restart">Restart level</button>
          <button class="btn" data-act="home">Home</button>
        </div>
      </div>
    </div>`;
}

function resume() {
  screen = 'playing';
  overlay.innerHTML = '';
  lastFrame = performance.now();
}

function finishLevel() {
  const targets = starTargets(world.level);
  const penned = world.penned;
  const stars = targets.filter((t) => penned >= t).length;
  const wool = penned + stars * 10;
  save.wool += wool;
  save.stars[levelId] = Math.max(save.stars[levelId] ?? 0, stars);
  save.best[levelId] = Math.max(save.best[levelId] ?? 0, penned);
  const unlockedNext = stars >= 1 && levelId + 1 > save.unlocked;
  if (stars >= 1) save.unlocked = Math.max(save.unlocked, levelId + 1);
  writeSave(save);

  screen = 'results';
  hud.classList.add('hidden');
  const next = targets.find((t) => penned < t);
  const starHtml = [0, 1, 2]
    .map((i) => (i < stars ? `<span class="on" style="animation-delay:${0.25 + i * 0.3}s">★</span>` : '★'))
    .join('');
  overlay.innerHTML = `
    <div class="screen" style="justify-content:center">
      <div class="card" style="text-align:center">
        <p class="muted">Level ${levelId} · ${world.level.name}</p>
        <div class="stars">${starHtml}</div>
        <div class="big-number">${penned}</div>
        <p style="margin:4px 0 0;font-weight:800">sheep penned</p>
        <p class="muted">${world.lost} got away${next ? ` · ${next} for the next ★` : ' · perfect herding!'}</p>
        <p><span class="wool">🧶 +${wool} wool</span></p>
        ${stars === 0 ? `<p class="muted">Pen at least ${targets[0]} sheep to open the next field.</p>` : ''}
        ${unlockedNext ? `<p style="font-weight:800;color:#3b8a22">New field unlocked!</p>` : ''}
      </div>
      <div class="row">
        <button class="btn" data-act="retry">Retry</button>
        <button class="btn green" data-act="dog">Dog 🐕</button>
      </div>
      <div class="row">
        ${stars >= 1 ? `<button class="btn primary" data-act="next">Next field ▶</button>` : `<button class="btn primary" data-act="retry">Try again</button>`}
      </div>
      <button class="toggle" data-act="home">Home</button>
    </div>`;
  if (stars > 0) {
    sfx.fanfare();
    for (let i = 0; i < stars; i++) setTimeout(() => sfx.star(i), 250 + i * 300);
  }
}

function showHome() {
  screen = 'home';
  hud.classList.add('hidden');
  levelId = Math.min(levelId, save.unlocked);
  world = makeWorld(save.unlocked);
  world.setViewAspect(aspect);
  const next = save.unlocked;
  const chips: string[] = [];
  for (let i = Math.max(1, next - 7); i <= next; i++) {
    const s = save.stars[i] ?? 0;
    chips.push(
      `<button class="level-chip ${i === next ? 'current' : ''}" data-act="play" data-level="${i}">${i}<small>${'★'.repeat(s) || '&nbsp;'}</small></button>`,
    );
  }
  overlay.innerHTML = `
    <div class="screen">
      <div class="logo">
        <h1>Flock Rescue</h1>
        <p>Herd the flock. Fill the pen.</p>
      </div>
      <div style="flex:1"></div>
      <span class="wool">🧶 ${save.wool} wool</span>
      <div class="card" style="text-align:center">
        <p class="muted" style="margin:0">Level ${next}</p>
        <h2>${getLevel(next).name}</h2>
        <button class="btn primary" data-act="play" data-level="${next}">Herd! ▶</button>
      </div>
      <div class="row">
        <button class="btn green" data-act="dog">Upgrade dog 🐕</button>
      </div>
      <div class="levels">${chips.join('')}</div>
      <button class="toggle" data-act="sound">Sound: ${save.sound ? 'on' : 'off'}</button>
    </div>`;
}

function showUpgrades() {
  screen = 'upgrades';
  hud.classList.add('hidden');
  const rows = STAT_IDS.map((id) => {
    const lvl = save.dog[id];
    const info = STAT_INFO[id];
    const maxed = lvl >= MAX_STAT_LEVEL;
    const cost = upgradeCost(lvl);
    const pips = Array.from({ length: MAX_STAT_LEVEL }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
    return `
      <div class="stat">
        <div class="icon">${info.icon}</div>
        <div>
          <b>${info.name}</b> <span class="muted">Lv ${lvl}</span>
          <div class="muted" style="font-size:12px">${info.blurb}</div>
          <div class="pips">${pips}</div>
        </div>
        <button class="buy" data-act="buy" data-stat="${id}" ${maxed || save.wool < cost ? 'disabled' : ''}>
          ${maxed ? 'MAX' : `🧶 ${cost}`}
        </button>
      </div>`;
  }).join('');
  overlay.innerHTML = `
    <div class="screen">
      <div class="logo" style="margin-top:2vh"><h1 style="font-size:32px">Your Dog 🐕</h1></div>
      <span class="wool">🧶 ${save.wool} wool</span>
      <div class="card">${rows}</div>
      <p class="muted" style="color:#fff;text-align:center;max-width:340px">A better dog keeps bigger flocks together. Good herders can still win with a puppy.</p>
      <div class="row"><button class="btn primary" data-act="home">Back</button></div>
    </div>`;
}

overlay.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  sfx.unlock();
  sfx.click();
  switch (el.dataset.act) {
    case 'play':
      startLevel(Number(el.dataset.level));
      break;
    case 'resume':
      resume();
      break;
    case 'restart':
    case 'retry':
      startLevel(levelId);
      break;
    case 'next':
      startLevel(levelId + 1);
      break;
    case 'home':
      showHome();
      break;
    case 'dog':
      showUpgrades();
      break;
    case 'buy': {
      const id = el.dataset.stat as StatId;
      const cost = upgradeCost(save.dog[id]);
      if (save.wool >= cost && save.dog[id] < MAX_STAT_LEVEL) {
        save.wool -= cost;
        save.dog[id]++;
        writeSave(save);
        sfx.pickup();
        haptic(15);
      }
      showUpgrades();
      break;
    }
    case 'sound':
      save.sound = !save.sound;
      sfx.enabled = save.sound;
      writeSave(save);
      showHome();
      break;
  }
});

// Debug/automation hook for tests and ad-clip recording.
(window as unknown as { __flock: unknown }).__flock = {
  get world() {
    return world;
  },
  get screen() {
    return screen;
  },
  startLevel,
  save,
  setAutopilot(mode: 'good' | 'bad' | null) {
    pilot = mode ? new Autopilot(mode === 'bad') : null;
  },
};

if (params.get('level')) startLevel(levelId);
else showHome();
requestAnimationFrame(frame);
