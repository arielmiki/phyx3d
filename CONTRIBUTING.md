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
npm install
npm run build        # dist/cli.js, dist/mcp.js, dist/web
npm test             # vitest
npm run typecheck
```

Web app with hot reload: run `node dist/cli.js serve` (API on :5217) and `npm run dev` (Vite on :5173, proxies
`/api`). The engine lives in `src/core` and must stay free of Node-only APIs so it keeps running in the browser;
Node-specific code goes in `src/node`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Diagrams are PlantUML files in `docs/diagrams/`. After editing one, regenerate the SVGs with
`plantuml -tsvg docs/diagrams/*.puml` and commit both.

To try your MCP changes in Claude Code, rebuild (`npm run build`) and restart the client — the server runs from
`dist/mcp.js`.

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
