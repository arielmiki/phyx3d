// Node-side helpers shared by the CLI and the MCP server.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve, dirname, isAbsolute } from "node:path";
import { loadFile, writeBinarySTL, simulateMechanism, renderMechanism, type LoadedFile, type Report, type CheckResult, type Mesh, type MechSpec, type MechOutput } from "../core/index.js";

export function loadPath(path: string): LoadedFile {
  const p = resolve(path);
  if (!existsSync(p)) throw new Error(`File not found: ${p}`);
  return loadFile(basename(p), new Uint8Array(readFileSync(p)));
}

export function requireMesh(f: LoadedFile): Mesh {
  if (!f.mesh) throw new Error(`${f.name} has no 3D shape (only G-code). Use the G-code check, or pass the STL/3MF.`);
  return f.mesh;
}

/** Drop bulky per-face / per-layer arrays so reports stay small for agents. */
export function compactCheck(c: CheckResult): CheckResult {
  const data = { ...(c.data as Record<string, unknown>) };
  for (const k of ["faceAngles", "profile", "frames"]) delete data[k];
  if (Array.isArray(data.clusters)) data.clusters = (data.clusters as unknown[]).slice(0, 10);
  if (Array.isArray(data.islands)) data.islands = (data.islands as unknown[]).slice(0, 10);
  if (Array.isArray(data.spots)) data.spots = (data.spots as unknown[]).slice(0, 10);
  if (Array.isArray(data.trials)) data.trials = (data.trials as { frames?: unknown }[]).map(({ frames: _f, ...t }) => t);
  if (Array.isArray(data.supportPolygon) && (data.supportPolygon as unknown[]).length > 24) data.supportPolygon = `${(data.supportPolygon as unknown[]).length} points`;
  return { ...c, findings: c.findings.slice(0, 12), data };
}

export function compactReport(r: Report): Report {
  return { ...r, checks: r.checks.map(compactCheck) };
}

// ---------- run history (lets the web app show what the agent tested) ----------

export const PHYX_HOME = process.env.PHYX3D_HOME ?? join(homedir(), ".phyx3d");

export interface RunRecord {
  id: string;
  name: string;
  time: string;
  kind: string;
  verdict?: string;
  score?: number;
  headline?: string;
}

export function saveRun(kind: string, name: string, mesh: Mesh | undefined, payload: unknown, images: Record<string, Uint8Array> = {}, extra: Record<string, string | Uint8Array> = {}): string {
  const time = new Date();
  const id = `${time.toISOString().replace(/[:.]/g, "-")}-${kind}-${name.replace(/[^\w.-]+/g, "_")}`.slice(0, 120);
  const dir = join(PHYX_HOME, "runs", id);
  mkdirSync(dir, { recursive: true });
  if (mesh) writeFileSync(join(dir, "model.stl"), writeBinarySTL(mesh));
  writeFileSync(join(dir, "result.json"), JSON.stringify(payload, null, 1));
  for (const [k, v] of Object.entries(images)) writeFileSync(join(dir, `${k}.png`), v);
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(dir, k), v);
  const r = payload as { verdict?: string; score?: number; headline?: string; summary?: string; status?: string };
  const rec: RunRecord = { id, name, time: time.toISOString(), kind, verdict: r.verdict ?? r.status, score: r.score, headline: r.headline ?? r.summary };
  writeFileSync(join(dir, "run.json"), JSON.stringify(rec));
  return dir;
}

export function parseVec(s: string | undefined): [number, number, number] | undefined {
  if (!s) return undefined;
  const v = s.split(/[ ,]+/).filter(Boolean).map(Number);
  if (v.length !== 3 || v.some((x) => isNaN(x))) throw new Error(`Expected three numbers like "0,0,-20", got "${s}"`);
  return v as [number, number, number];
}

// ---------- mechanisms ----------

export async function runMechanismFile(path: string, opts: { duration?: number; spec?: MechSpec; baseDir?: string } = {}): Promise<{ out: MechOutput; png: Uint8Array; spec: MechSpec }> {
  const spec: MechSpec = opts.spec ?? JSON.parse(readFileSync(resolve(path), "utf8"));
  const base = opts.baseDir ?? dirname(resolve(path));
  const out = await simulateMechanism(spec, (f) => new Uint8Array(readFileSync(isAbsolute(f) ? f : join(base, f))), { record: true, duration: opts.duration });
  return { out, png: renderMechanism(out), spec };
}

/** Save a mechanism run so the web app can replay it: posed part STLs + resolved spec + frames. */
export function saveMechanismRun(name: string, spec: MechSpec, out: MechOutput, png: Uint8Array): string {
  const lift = out.lift ?? 0;
  const resolved: MechSpec = {
    ...spec,
    joints: (spec.joints ?? []).map((j) => ({ ...j, anchor: [j.anchor[0], j.anchor[1], j.anchor[2] + lift] as [number, number, number] })),
    environment: { ...spec.environment, settle: false },
    parts: spec.parts.map((p) => {
      const { shape: _s, position: _p, rotation: _r, file: _f, ...rest } = p;
      return { ...rest, file: `part-${p.id}.stl` };
    }),
  };
  const extra: Record<string, string | Uint8Array> = {
    "mechanism.json": JSON.stringify(resolved, null, 1),
    "frames.json": JSON.stringify(out.frames ?? {}),
  };
  for (const p of out.parts) extra[`part-${p.id}.stl`] = writeBinarySTL(p.mesh);
  return saveRun("mechanism", name, undefined, compactCheck(out.check), { film: png }, extra);
}
