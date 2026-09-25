# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.2.2] - 2026-09-25

### Fixed
- **Strength solver on thin-walled parts:**
  - Walls thinner than an element no longer vanish: the grid refines until the model holds the part's volume.
  - Voxels touching only at an edge or corner are no longer treated as joined. They made the solve singular
    (deflections of 10¹⁰ mm).
  - Results that can't be trusted are flagged as unreliable in the status and summary instead of passing or
    failing the part: unconverged, under-resolved, or bending more than 10 % of the part's size.
- **Drop test:**
  - Impact stress on thin-walled parts is now resolved properly.
  - Soft materials stretch the impact; TPU no longer scores worse than PLA.
  - Flexible parts are credited with softening their own impact.
  - Flexible materials such as TPU are not judged against tensile strength.
- **Wall thickness:**
  - No more false "too thin" readings beside corners, window cut-outs and chamfered edges: rays that graze the
    far face are ignored.
  - Identical curved walls now report the same thickness.

### Changed
- The strength solver uses a geometric-multigrid preconditioner. It converges in about 20–600 iterations instead
  of 400–10 000, and the same answers come several times faster.
- New `--element-size` (CLI) and `element_size` (MCP `stress_test`) options fix the element size, so builds of a
  design are compared at the same resolution. At sharp inside corners the peak stress depends on element size.

## [0.2.1] - 2026-09-24

### Fixed
- Web app on Retina / HiDPI screens (e.g. MacBook): the 3D view drew at twice its size, covering the right-hand
  panel and pushing the model off-centre. The canvas now stays inside its column at any screen scaling.

## [0.2.0] - 2026-09-24

### Added
- **Interlocking parts** (`phyx3d interlock`, MCP `check_interlock`, `.interlock.json`): an optional check for
  dovetails, T-slots, bayonets, snap-fits, detents, threads, press fits and 56 named types in six motion families.
  It reports:
  - fit in place (gap / touching / clamped / overlapping);
  - whether the assembly path is clear, and where it jams;
  - escape directions and free play;
  - detent/lock engagement after play, in whole layers;
  - press-fit interference;
  - wrong-way assembly.

  Example pairs are in `examples/interlocks/`; docs are in `docs/INTERLOCKS.md`.
- Displacement loads for the strength test (`stress --move region=dx,dy,dz`, MCP `stress_test.displacements`):
  push a region a set distance and get the safety factor at that travel and the force it takes. This is the right
  way to test snap arms and clips.

### Changed
- Strength solver iteration limit raised from 4000 to 10000 for large meshes.

## [0.1.1] - 2026-09-24

### Fixed
- Web app on laptop screens (e.g. MacBook Air, 1280×720 – 1470×900): side panels scale with the window, the viewport
  toolbars wrap instead of overlapping, compact spacing, and print settings collapse on short screens so the verdict
  stays visible.

## [0.1.0] - 2026-09-24

First public release.

### Added
- Printability checks: mesh health, bed fit, overhangs (bridges vs. cantilevers), floating islands, thin walls,
  filament/time estimate.
- Stability checks: centre of mass, tip angle, bed adhesion, wobble while printing; warp-risk heuristic.
- Strength test: voxel finite-element solver with along-layer / across-layer strength, validated against beam theory.
- Physics tests with Rapier: drop (with impact stress), tilt, push, stack.
- Mechanism simulation (`.mech.json`): joints, real servo/motor presets, motion expressions with sensor feedback,
  motor load, collisions and travel metrics.
- Print-orientation search.
- G-code and Bambu `.gcode.3mf` loading, layer replay and over-air extrusion check; optional Bambu Studio slicing.
- Software renderer producing annotated PNG reports and mechanism filmstrips.
- Interfaces: web app (three.js), CLI, MCP server, and the `print-design` skill for Claude Code.
- `phyx3d mcp` runs the MCP server, so MCP clients can use `npx -y phyx3d mcp` without a path.
- `phyx3d install-skill` copies the print-design skill into `~/.claude/skills`.
- Package builds itself when run from GitHub (`npx -y github:arielmiki/phyx3d`) and before publishing.
- Release workflow: pushing a `v*` tag publishes to npm via trusted publishing (OIDC), with provenance.

[Unreleased]: https://github.com/arielmiki/phyx3d/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/arielmiki/phyx3d/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/arielmiki/phyx3d/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/arielmiki/phyx3d/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/arielmiki/phyx3d/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/arielmiki/phyx3d/releases/tag/v0.1.0
