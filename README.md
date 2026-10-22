# Flock Rescue (sheep-herding)

A one-finger herding game for phones. You steer a border collie; the sheep run
from him. Drive the flock over clover patches (×2, ×3), past thistles and bogs,
and into the pen at the top of the field. Wool from penned sheep buys dog
upgrades (speed, agility, presence, bark) so you can handle bigger fields.

**Play:** https://ngb0004.github.io/sheep-herding/ (deploys on every push to `main`)

## How it plays

- **Drag** anywhere: the dog runs toward your finger, with momentum. Agility upgrades reduce the lag.
- **Sheep** flock, bunch up when frightened, follow the movers and trot uphill while driven. Left alone they graze and fall behind.
- **Patches only affect the sheep that cross them.** Get the whole flock onto the ×3.
- **Bark** (button or Space) pushes nearby sheep away from the dog.
- The camera keeps moving. Sheep that drop off the bottom of the screen are lost.
- Stars per field are based on a strong but realistic run; 1 star opens the next field.
- Fields 1–3 are hand-made; after that, fields are generated and keep getting wider and longer.

Desktop: mouse to steer, Space to bark, Esc to pause.

## Code

```
src/game/      Pure simulation (no DOM): world, flocking, dog, patches, levels, autopilot
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

`?level=N` jumps to a field; `?auto=good` or `?auto=bad` lets the autopilot herd,
which is how ad clips will be recorded (`bad` makes the classic wrong choices).
