# phyx3d — test 3D prints before you print them

Pre-print simulation for Bambu Lab printers (P1S / P1P / P2S / X1 / A1 / H2D), usable **three ways**:

| Who | How | What for |
|---|---|---|
| You | **Web app** (`phyx3d serve` → http://localhost:5217) | 3D view with problem areas, strength test, physics playback, G-code layer replay, live view of the agent's runs |
| Claude Code | **MCP server** (`phyx3d-mcp`) + the `print-design` skill | design → test → fix loop with build123d |
| Scripts / any agent | **CLI** (`phyx3d check part.stl --json`) | JSON reports, PNG pictures, exit code 2 when a part needs changes |

## What it checks

| Check | Method | Trust level |
|---|---|---|
| Mesh health (holes, flipped faces, bodies) | edge topology | exact |
| Fits the build plate | bounding box | exact |
| Overhangs / supports (Bambu's 30° threshold), bridges vs cantilevers | face normals + voxel support test | exact |
| Floating islands (parts that start in mid-air) | layer-by-layer voxels | estimate |
| Thin walls (< nozzle = missing, < 2 lines = weak) | ray casting (BVH) | estimate |
| Stability: centre of mass, tip angle, bed contact, wobble while printing | mass properties + support polygon | estimate |
| Warp risk | heuristic from material, footprint, corners, enclosure | rough guide |
| Strength under load, **with FDM layer weakness** | voxel finite-element solver (8-node hexahedra, PCG) — verified against beam theory (1 % deflection, 6 % stress) | rough guide |
| Drop / tilt / push / stack | Rapier rigid-body physics with printed mass & friction; drop impacts feed the strength solver | simulated |
| **Mechanisms**: robots walk / drive, arms lift, linkages move — joints + real servo/motor torque & speed limits (SG90 … NEMA17), motion programs with sensor feedback | Rapier multi-body physics with explicit, measured motor torques and gearbox inertia — verified: rover speed vs rpm, crank-slider stroke, servo holding torque = m·g·r | simulated |
| Best print orientation | ranks flat faces by supports, islands, stability, warp, height | estimate |
| Sliced G-code / Bambu `.gcode.3mf`: time, filament, **extrusion printed over air** | toolpath parser | exact (time from slicer) |
| Slice with real Bambu Studio | Bambu Studio CLI (optional, if installed) | exact |

Strength and warp numbers are **guides, not certified engineering** — every result says how far to trust it.

## Install

Needs Node ≥ 20 (installed here via nvm: Node 22).

```bash
cd ~/workspace/phyx3d
pnpm install
pnpm build          # → dist/cli.js, dist/mcp.js, dist/web
pnpm test           # 32 tests incl. physics, FEA and mechanism validation
```

Optional: `pnpm link --global` to get `phyx3d` / `phyx3d-mcp` on your PATH.

## Use it

```bash
node dist/cli.js serve                                   # web app on :5217 (shows agent runs live)
node dist/cli.js check part.stl -m PETG --png report.png # all printability checks
node dist/cli.js orient part.stl                         # best print orientations
node dist/cli.js stress bracket.stl --fixed -x --force "rel:0.8,0,0:1,1,1=0,0,-50"
node dist/cli.js drop part.stl --height 750 --floor wood
node dist/cli.js tilt part.stl        # also: push, stack
node dist/cli.js mech examples/mechanisms/walker.mech.json --png walk.png   # robots & mechanisms
node dist/cli.js gcode plate_1.gcode.3mf
node dist/cli.js slice part.stl       # needs Bambu Studio + profiles, see below
```

Regions for `--fixed` / `--force`: `bottom|top|-x|+x|-y|+y`, `box:x0,y0,z0:x1,y1,z1`,
`sphere:x,y,z:r`, or `rel:fx0,fy0,fz0:fx1,fy1,fz1` (fractions of the part's size — easiest).

**Coordinates:** for an unrotated model that sits on z = 0, every position phyx3d reports is in
your CAD coordinates. Strength tests always use the design's axes, even when you test a rotated
print orientation (the rotation only changes which way the layers run).

## Mechanisms (robots, vehicles, arms, linkages)

A `.mech.json` describes parts, joints and motors; see `examples/mechanisms/` (rover, quadruped walker,
2-DOF arm from build123d STLs, crank-slider). Minimal example:

```json
{
  "name": "pendulum arm", "duration": 3,
  "parts": [
    { "id": "base", "file": "base.stl", "fixed": true },
    { "id": "arm", "file": "arm.stl", "payloads": [{ "mass": 100, "at": [120, 0, 60] }] }
  ],
  "joints": [
    { "id": "shoulder", "type": "revolute", "parent": "base", "child": "arm",
      "anchor": [0, 0, 60], "axis": [0, -1, 0], "limits": [-10, 120],
      "motor": { "preset": "MG996R", "target": "45*sin(2*pi*0.5*t)" } }
  ]
}
```

- Parts: STL `file` (modelled in assembly position) or `shape` (`box`, `cylinder`, `sphere`); `fixed`, `mass`, `extraMass`, `payloads`, `friction`, `color`.
- Joints: `revolute` / `prismatic` / `fixed` / `ball`; `parent` can be `"world"`; `limits` in ° or mm.
- Motors: presets `SG90 MG90S MG996R DS3218 STS3215` (servo, target in °), `TT N20 JGA25 NEMA17` (motor, target in rpm), `LINEAR` (mm).
  Targets: number, `{keyframes:[[t,v],…], loop, smooth}`, or an expression of `t` — which may also read the tracked part's
  `yaw pitch roll x y z speed` for feedback control.
- Results: distance/speed/heading drift/falls over, each motor's typical (p95) and peak torque vs rating, % time at its limit,
  tracking error, parts colliding, parts overlapping at start, joint ranges; filmstrip PNG; 3D replay in the web app (Mechanism tab).
- Motors are modelled as torque-limited controllers with the gearbox's reflected inertia; motor torques are measured exactly, but
  friction in gears/bearings and servo electronics are not modelled — keep ~30 % torque margin.

## Claude Code setup (already done on this machine)

```bash
claude mcp add --scope user phyx3d -- ~/.nvm/versions/node/v22.23.2/bin/node ~/workspace/phyx3d/dist/mcp.js
claude mcp add --scope user build123d -- ~/.local/bin/uv tool run --python 3.12 build123d-mcp@latest
ln -sfn ~/workspace/phyx3d/skills/print-design ~/.claude/skills/print-design
```

Then just ask Claude Code, e.g. *"Design a wall hook for 1 kg bags, PLA, and make sure it prints on my P1S."*
It models the part with build123d, runs `analyze_model`, `suggest_orientation`, `stress_test`, `simulate_physics`,
fixes what fails, and reports the orientation/material/settings to print with. Keep `phyx3d serve` open to watch.

MCP tools: `analyze_model`, `stress_test`, `simulate_physics`, `simulate_mechanism`, `suggest_orientation`, `render_view`,
`check_gcode`, `slice_bambu`, `list_materials`.

Undo: `claude mcp remove --scope user phyx3d`, `claude mcp remove --scope user build123d`, `rm ~/.claude/skills/print-design`.

## Slicing with Bambu Studio (optional)

1. Install Bambu Studio for Linux (AppImage from github.com/bambulab/BambuStudio/releases or flatpak `com.bambulab.BambuStudio`).
   phyx3d finds it on PATH, in `~/Applications`, `~/Downloads`, flatpak, or via `PHYX3D_BAMBU_STUDIO=/path/to/app`.
2. In Bambu Studio export your printer, process and filament presets and save them as
   `~/.phyx3d/profiles/machine.json`, `process.json`, `filament.json` — or slice a `.3mf` project saved from Bambu Studio (it carries its own settings).
3. `phyx3d slice part.stl` → `part.gcode.3mf` + exact time/filament + over-air check. It never starts a print.

## Layout

```
src/core/     engine (runs in Node and the browser): loaders, mesh, voxels, printability,
              stability, warp, fea, physics, gcode, render (software → PNG), analyze
src/node/     cli.ts, mcp.ts, server.ts (web app + run history), slice.ts (Bambu Studio)
web/          Vite + three.js app; analysis runs in a Web Worker
skills/       print-design skill for Claude Code
examples/     build123d script + example STLs
test/         vitest: geometry, printability, stability, FEA vs beam theory, physics vs statics, loaders
```

Run history (what the agent tested) lives in `~/.phyx3d/runs/` (override with `PHYX3D_HOME`).
