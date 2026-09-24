# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- `phyx3d mcp` runs the MCP server, so MCP clients can use `npx -y phyx3d mcp` without a path.
- `phyx3d install-skill` copies the print-design skill into `~/.claude/skills`.
- Package builds on install from GitHub (`npm install -g github:arielmiki/phyx3d`) and before publishing.
- Release workflow: pushing a `v*` tag publishes to npm with provenance.

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
