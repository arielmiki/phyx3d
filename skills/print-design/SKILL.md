---
name: print-design
description: Design a 3D-printable part or moving mechanism and prove it will print, hold up and work before the user prints it. Use when the user asks to design, model, make, or fix something for their 3D printer (Bambu Lab P1S/P1P/P2S etc.) — including robots, vehicles, arms, grippers, linkages with servos or motors — or asks whether a model will print, is strong enough, will tip over, needs supports, or whether a robot/mechanism will walk, drive or move. Uses the build123d MCP (CAD) and the phyx3d MCP (printability, stability, physics, strength, mechanism simulation).
---

# Design → test → fix, before printing

The user prints on a **Bambu Lab printer** (default P1S, 256 mm cube, 0.4 mm nozzle, PLA unless they say otherwise).
Never hand over a design that phyx3d says `needs-changes` without telling them exactly why.

## 1. Understand the job

Before modelling, pin down (ask only if you can't infer a sensible default):
- what the part does, how it is **held** (screwed to a wall, sits on a desk, clamped…) and what **load** it takes (e.g. "2 kg shelf" ≈ 20 N; add ×2 for safety),
- key dimensions / what it must fit,
- material (default PLA; PETG for outdoor/impact/heat > 50 °C; TPU for flexible).

## 2. Model it (build123d MCP)

- Design with the build123d tools in small steps and look at their previews.
- Millimetres, Z up. Put the intended print face at z = 0 when you can.
- Printable-by-design rules: walls ≥ 1.2 mm (≥ 2 mm under load); 45° chamfers (not fillets) on downward edges; teardrop holes in vertical walls; fillet r ≥ 2 mm at inside corners that take load; avoid floating parts.
- Export an **STL** to an absolute path (e.g. `./out/<name>.stl`).

## 3. Test it (phyx3d MCP) — always in this order

1. `analyze_model {path, material}` → read `verdict`, `checks[].findings`, and `todo`. Look at the returned image.
2. If anything about orientation is off (supports, stability, warp): `suggest_orientation {path}` and re-run `analyze_model` with the best `rotate`.
3. If the part carries load: `stress_test` with realistic `fixed` + `loads` in the **design's own axes**.
   `rel` regions are the easiest: `{rel:{min:[0.85,0,0],max:[1,1,1]}}` = the far 15 % along +X.
   Pass the chosen print `rotate` too — layer direction changes the strength. Aim for safety factor ≥ 2 (≥ 3 for impact/repeated loads).
4. If it must stand, stack, or survive knocks: `simulate_physics` with `tilt`, `push`, `stack` or `drop`.
5. Optional, if Bambu Studio is installed: `slice_bambu` for exact time and filament.

## 3b. Things that move — robots, vehicles, arms, grippers, linkages

Use `simulate_mechanism` whenever parts move relative to each other.

1. Model each moving part as its **own STL in assembly position** (all parts share one coordinate system, Z up, floor at z = 0). Leave ≥ 0.3 mm clearance between separate parts.
2. Write a `<name>.mech.json` next to the STLs:
   - `parts`: `{id, file}` (or `shape` box/cylinder/sphere for quick tests), `fixed: true` for a base screwed down, `payloads: [{mass, at}]` for batteries/objects carried, `friction: 0.9` for TPU tyres/feet.
   - `joints`: `{id, type: revolute|prismatic|fixed|ball, parent (id or "world"), child, anchor [x,y,z], axis, limits}` — anchor = the pin/shaft centre.
   - `motor`: pick a real part via `preset` (SG90, MG90S, MG996R, DS3218, STS3215 servos in degrees; TT, N20, JGA25, NEMA17 motors in rpm; LINEAR in mm) and a `target`: number, keyframes, or expression of `t` (e.g. `"20*sin(2*pi*1.2*t + pi)"`). Expressions may read `yaw, pitch, roll, x, y, z, speed` of the tracked part for simple feedback (e.g. steer a walker with `(22 + 0.1*yaw)`).
3. Run it and read: distance/speed/heading drift/fell (mobile robots), joint ranges (machines), each motor's `p95` and `peak` vs `rated` torque, `saturated` share, tracking error, collisions between parts, overlap at start. Look at the filmstrip.
4. Fix: a motor `saturated` or `p95 > 0.7 × rated` → stronger preset, shorter lever, lighter part, slower motion. Falls over → wider stance, lower body, slower gait. Veers → symmetric design or feedback. Parts collide → clearance or phase change. Then **also** run `stress_test` on the most loaded part using the motor's peak torque as the load.
5. A walking gait that works as a starting point: trot, diagonal legs in phase, hip `A*sin(ωt+φ)`, knee `B*max(0,-cos(ωt+φ))` (lifts the foot while the leg swings forward).

## 4. Fix and repeat

Apply the `todo` fixes in the CAD, re-export, re-test. Iterate until the verdict is `ready`, or `printable-with-care` with every remaining warning explained. Usually 2–4 rounds.

## 5. Report to the user

Keep it short and concrete:
- final STL path and how to print it: **orientation (rotation values), supports yes/no, material, walls/infill** you tested with,
- the numbers that matter: safety factor under their load, tip angle, filament/time estimate,
- anything you could not verify (strength is a rough guide; warp is a heuristic),
- tip: they can open `phyx3d serve` (http://localhost:5217) to see every check you ran, live, in 3D.
