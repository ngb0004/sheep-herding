# Flock Rescue (sheep-herding)

A one-finger herding game for phones. You steer a border collie; the sheep keep
their distance from him, and the whole flock moves like a ball you push.

**Play:** https://ngb0004.github.io/sheep-herding/ (deploys on every push to `main`)

## Round-up (main mode)

An open Irish meadow with little groups of sheep grazing all over it. Sweep
them into one flock (every group you reach joins, "+6"), then bring everyone
home to the pen before the sun goes down. Walls have gaps, rivers have one
bridge, and the pen's gate can face any way. Arrows at the screen edge point to
the pen and to the nearest sheep still out grazing. Pen every sheep early for
a sunset bonus.

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
src/render/    Canvas renderer and procedurally drawn sprites
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
