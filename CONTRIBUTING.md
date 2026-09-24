# Contributing to phyx3d

Thanks for helping! phyx3d is most useful when its numbers match real prints, so contributions of every size help:
a bug report, a corrected material value, a new printer or motor preset, a validation case, or code.

## Ways to help

- **Report a wrong result.** Attach the model (or a minimal one), the command or tool call, what phyx3d said and what
  actually happened when you printed it. Real-world comparisons are the most valuable input the project gets.
- **Add presets.** Printers (`src/core/materials.ts` → `PRINTERS`), materials (`MATERIALS`) and motors
  (`src/core/mechanism.ts` → `MOTOR_PRESETS`). Please cite the datasheet or measurement you used.
- **Add validation tests.** Cases with a known answer (hand calculation, textbook formula, measured print) go in
  `test/`. The existing ones compare FEA with beam theory and physics with statics.
- **Improve the web app, CLI or MCP tools.**

## Development

Requires Node.js 20+. Either npm or pnpm works (the repo includes a `pnpm-lock.yaml`).

```bash
git clone https://github.com/arielmiki/phyx3d.git
cd phyx3d
npm install          # installs and builds dist/ (cli.js, mcp.js, web/)
npm link             # optional: use your local build as the `phyx3d` command
npm test             # vitest
npm run typecheck
npm run build        # rebuild after changes
```

Web app with hot reload: run `phyx3d serve` (API on :5217) and `npm run dev` (Vite on :5173, proxies
`/api`). The engine lives in `src/core` and must stay free of Node-only APIs so it keeps running in the browser;
Node-specific code goes in `src/node`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Diagrams live in `docs/diagrams/`. System diagrams are drawn in [Excalidraw](https://excalidraw.com) and
committed as the exported PNG. Sequence, activity and class diagrams are PlantUML: after editing a `.puml`,
regenerate with `plantuml -tsvg -failfast2 docs/diagrams/*.puml` (don't pipe it — a failed render still writes
an SVG, and the exit code is the only warning), open the result, and commit the `.puml` and `.svg` together.

To try your MCP changes in Claude Code, point it at your build
(`claude mcp add phyx3d-dev -- node /path/to/phyx3d/dist/cli.js mcp`), rebuild with `npm run build` and restart
the client.

## Pull requests

1. Open an issue first for larger changes so we can agree on the approach.
2. Keep changes focused; match the style of the surrounding code.
3. Add or update tests. Physics and solver changes need a test with a known answer.
4. Make sure `npm run typecheck`, `npm test` and `npm run build` pass — CI runs the same.
5. Describe what you changed and how you verified it. Screenshots help for UI changes.

## Accuracy and honesty

Every check reports how far it can be trusted (`exact`, `simulated`, `estimate`, `rough-guide`). Please keep that
honest: if a change makes a result less certain, say so in the output, not just in the code.

By contributing you agree that your contributions are licensed under the MIT License.
