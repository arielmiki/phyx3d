# phyx3d — pre-print simulation for Bambu Lab P1S/P1P/P2S

Goal: test a 3D design *before* printing — by a human (web app) and by an AI agent
(Claude Code via MCP, or any agent via CLI). One analysis engine, three front-ends.

## Architecture

```
packages/
  core/     TypeScript analysis engine — pure functions, runs in browser AND Node
  cli/      `phyx3d check|drop|stress|slice ...` → JSON report (+ human text)
  mcp/      MCP server exposing the same checks as tools for Claude Code
  web/      Vite + React + three.js viewer (you)
cad/        build123d / OpenSCAD examples + export helpers for the agent
```

Every check returns a typed JSON report with `pass/warn/fail`, numbers, and
concrete fix hints (e.g. "base footprint 12 mm; widen to ≥ 20 mm to stop tip-over").

## Inputs
- STL, 3MF (shape) — parsed in core
- Bambu `.gcode.3mf` (zip → `Metadata/plate_N.gcode` + `slice_info.config`)
- plain `.gcode`

## Checks (core modules)

| # | Module | What it does | Method |
|---|--------|--------------|--------|
| 1 | `mesh` | load, repair check (watertight, normals), volume, bbox, fits P1S bed 256×256×256 | triangle mesh math |
| 2 | `printability` | overhang faces > 45° (area + locations), bridges, thin walls < 0.8 mm, small features | face normals, ray casting |
| 3 | `stability` | bed contact area, center of mass, tip-over angle, *during-print* stability (partial part per layer + nozzle side force) | layer-sliced mass properties |
| 4 | `physics` | rigid-body playground: drop, stack, push, tilt table; report settle pose/falls over | Rapier3D (WASM) with convex decomposition |
| 5 | `strength` | apply force/fixture → stress map, weakest spot, safety factor | voxel hexahedral FEA (linear elastic), Z-layer weakness factor (anisotropic), PLA/PETG/ABS/ASA/TPU presets |
| 6 | `warp` | warp-risk score | heuristic: material, footprint size, first-layer area, sharp corners, height |
| 7 | `gcode` | parse toolpath, layer replay, time/filament, unsupported extrusion (in mid-air) detection | streaming parser in Web Worker |
| 8 | `slice` (CLI/MCP only) | slice with real Bambu Studio CLI for exact P1S G-code | shell out to `bambu-studio --slice` (optional, if installed) |

Honesty rule: reports label accuracy — physics/stability = reliable, strength = rough
guidance (FDM is anisotropic, infill approximated), warp = heuristic.

## MCP tools (for Claude Code)
`analyze_model`, `check_printability`, `check_stability`, `simulate_drop`,
`stress_test`, `warp_risk`, `slice_bambu`, `render_view` (PNG snapshot so the agent can "see").

## Agent design loop
1. Agent writes build123d/OpenSCAD script → exports STL
2. Calls `analyze_model` → JSON with failures + fix hints
3. Edits design, repeats until pass
4. Optional `slice_bambu` → real time/filament
5. Human opens result in web app → prints

## Build order (milestones)
1. Monorepo + core mesh loading + printability + stability + CLI JSON  ← agent usable early
2. MCP server + CAD examples + Claude Code config
3. Web app: viewer, overhang heatmap, center-of-mass, reports
4. G-code / `.gcode.3mf` parser + layer replay
5. Physics playground (Rapier)
6. Strength FEA (voxel) + warp heuristic
7. Bambu Studio CLI slicing integration

Tests: vitest with known geometries (cube, tall thin pillar that must tip,
T-shape with 90° overhang, cantilever with analytic beam-bending stress).

## Environment
- Node 18 found but **npm missing** → need Node 22 LTS (via nvm) + pnpm
- OpenSCAD 2021.01 installed; build123d not installed (pip install)
- Bambu Studio not installed → slicing step optional (AppImage/flatpak later)
