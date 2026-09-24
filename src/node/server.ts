// Tiny HTTP server: serves the built web app + the run history the agent writes to ~/.phyx3d/runs.
import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, watch } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHYX_HOME } from "./shared.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".stl": "model/stl", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".ico": "image/x-icon",
};

function webRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "web"), join(here, "../web"), join(here, "../../dist/web")]) if (existsSync(join(c, "index.html"))) return c;
  return null;
}

export async function startServer(port: number): Promise<void> {
  const root = webRoot();
  const runsDir = join(PHYX_HOME, "runs");
  mkdirSync(runsDir, { recursive: true });
  const clients = new Set<ServerResponse>();
  try {
    watch(runsDir, (_e, name) => {
      if (!name) return;
      setTimeout(() => { for (const c of clients) c.write(`data: ${JSON.stringify({ run: name })}\n\n`); }, 300);
    });
  } catch { /* fs.watch unsupported: web app falls back to polling */ }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: string | Buffer, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(body);
    };
    try {
      if (url.pathname === "/api/runs") {
        const runs = readdirSync(runsDir)
          .filter((d) => existsSync(join(runsDir, d, "run.json")))
          .sort()
          .reverse()
          .slice(0, 100)
          .map((d) => JSON.parse(readFileSync(join(runsDir, d, "run.json"), "utf8")));
        return send(200, JSON.stringify(runs));
      }
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": hello\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const m = /^\/api\/runs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const file = join(runsDir, m[1], m[2]);
        if (!normalize(file).startsWith(runsDir) || !existsSync(file)) return send(404, "{}");
        return send(200, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream");
      }
      if (!root) return send(500, "Web app not built. Run: pnpm build", "text/plain");
      let p = normalize(join(root, decodeURIComponent(url.pathname)));
      if (!p.startsWith(root)) return send(403, "no", "text/plain");
      if (!existsSync(p) || statSync(p).isDirectory()) p = join(root, "index.html");
      return send(200, readFileSync(p), TYPES[extname(p)] ?? "application/octet-stream");
    } catch (e) {
      return send(500, JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  console.log(`phyx3d web app: http://localhost:${port}  (agent runs from ${runsDir})`);
}
