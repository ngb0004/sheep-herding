# Flock Rescue (sheep-herding)

A one-finger herding game for phones. You steer a border collie; the sheep keep
their distance from him, and the whole flock moves like a ball you push.

**Landing page:** https://ngb0004.github.io/sheep-herding/ (trailer, "play free", coming-soon badges)
**Play:** https://ngb0004.github.io/sheep-herding/play/ (deploys on every push to `main`)

Handy URLs: `play/?level=100` Stampede Valley, `play/?auto=good` autopilot, `play/?gfx=2d` 2D look,
`play/?scene=farm` the farm diorama.

## Round-up (main mode)

An open Irish meadow with little groups of sheep grazing all over it. Sweep
them into one flock (every group you reach joins, "+6"), then bring everyone
home to the pen before the sun goes down. Walls have gaps, rivers have one
bridge, and the pen's gate can face any way. Arrows at the screen edge point to
the pen and to the nearest sheep still out grazing. Pen every sheep early for
a sunset bonus.

Round-up draws in stylized low-poly 3D (three.js): rolling hills, hedgerows,
stone walls, a river with a plank bridge, and sunlight that slides from
afternoon to golden hour to dusk as the timer runs out. The original 2D look is
one tap away on the home screen ("Graphics: 3D/2D"), or `?gfx=2d`.

## Stampede Valley (snowball)

Start with 6 sheep at the bottom of a long valley. Drive them through glowing
gates (×2, ×3, +12…) that multiply every sheep walking through, sweep up the
grazing groups (a bigger flock calls strays from further away), cross the wall
gap and the wide bridge, and pour the whole flock (often 700+) into the giant
pen at the top. The camera pulls out as the flock grows. Stars are for how many
you bring home.

## Marketing

`marketing/AD-TEST-PLAN.md` is the plan for testing three ad angles on Meta.
`marketing/recorder/` records the ads from the real game: `?capture` steps the
game one video frame at a time, so clips are perfectly smooth even on a slow
machine. With `npx vite preview --port 4190` running:
`node marketing/recorder/stampede.cjs <outDir>` (also `nearmiss.cjs`, `farm.cjs`).

## Trail (classic)

The original scrolling run: drive the flock up a corridor over ×2/×3 clover,
past thistles and bogs, into the pen at the top.

## How the herding works

- **Drag** anywhere: the dog runs toward your finger, with momentum. Agility upgrades reduce the lag.
- **Flight distance:** sheep move away just fast enough to keep the dog at the edge of its presence.
  Walk the dog in and they walk; sprint in and they run. Hold back and they slow to a graze.
- **One body:** sheep that touch form a group that flees together, along the line from the dog
  through the group's centre. Push from the back-left and the flock veers right.
- **Bark** (button or Space) shoves nearby sheep away from the dog.
- Wool from penned sheep buys dog upgrades: speed, agility, presence (reach), bark.

Desktop: mouse to steer, Space to bark, Esc to pause.

## Code

```
src/game/      Pure simulation (no DOM): flock.ts (shared flocking), meadow.ts (round-up),
               world.ts (trail), levels, dog stats, autopilots for balance tests
src/render/    2D canvas renderer (trail mode, 2D round-up, and the HUD overlay over 3D)
src/render3d/  three.js renderer for round-up: low-poly models built in code, lighting
src/main.ts    Screens, input, HUD, upgrades, save
src/audio.ts   Synthesized sounds (no audio files)
```

```bash
npm install
npm run dev        # play at http://localhost:5173
npm test           # sim tests + headless autopilot balance runs
npm run build
```

`?level=N` jumps to a meadow (`&mode=trail` for the trail); `?auto=good` lets the
autopilot herd, which is how ad clips will be recorded.
