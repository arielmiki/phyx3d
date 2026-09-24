# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

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

[Unreleased]: https://github.com/arielmiki/phyx3d/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/arielmiki/phyx3d/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/arielmiki/phyx3d/releases/tag/v0.1.0
