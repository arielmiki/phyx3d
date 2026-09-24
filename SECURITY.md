# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately via
[GitHub security advisories](https://github.com/arielmiki/phyx3d/security/advisories/new).

Include what you found, how to reproduce it, and the impact you expect. You should get a response within a week.

## Scope notes

- `phyx3d serve` binds to `127.0.0.1` only and is meant for local use. It serves the web app and the run history
  in `~/.phyx3d/runs`; do not expose it to a network without adding authentication.
- The MCP server reads the files an agent points it at and writes run history to `~/.phyx3d/runs`.
  `slice_bambu` starts the locally installed Bambu Studio. No tool sends data over the network or starts a print.
- Motion-program expressions in `.mech.json` files are evaluated by a small parser (no `eval`) that can only call
  a fixed list of math functions.
