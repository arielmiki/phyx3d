// One-call analysis, visual reports and orientation search.
import { Part, type PartOptions } from "./context.js";
import type { Mesh, Vec3 } from "./mesh.js";
import { triCount, faceNormals } from "./mesh.js";
import { checkMeshHealth, checkBedFit, checkOverhangs, checkIslands, checkThinWalls, estimatePrint } from "./printability.js";
import { checkStability } from "./stability.js";
import { checkWarp } from "./warp.js";
import { checkStrength, type LoadCase, type FeaResult } from "./fea.js";
import { type CheckResult, type Status, worst, r1 } from "./report.js";
import { renderPNG, safetyColor, type Marker, type Polyline, type RGB, type ViewName, BASE_COLOR } from "./render.js";
import { vIndex } from "./voxel.js";

export const ALL_CHECKS = ["mesh", "bed-fit", "overhangs", "islands", "thin-walls", "stability", "warp", "estimate"] as const;
export type CheckId = (typeof ALL_CHECKS)[number] | "strength";

export interface AnalyzeOptions extends PartOptions {
  checks?: CheckId[];
  /** add a strength check with this load case */
  load?: LoadCase;
  requiredSafety?: number;
}

export interface Report {
  verdict: "ready" | "printable-with-care" | "needs-changes";
  /** 0–100, higher is better */
  score: number;
  headline: string;
  part: {
    material: string;
    printer: string;
    size: Vec3;
    volumeMm3: number;
    triangles: number;
    rotation?: [number, number, number];
  };
  checks: CheckResult[];
  /** every fix suggestion, most important first, de-duplicated */
  todo: string[];
}

export function analyze(mesh: Mesh, opts: AnalyzeOptions = {}): { report: Report; part: Part; fea?: FeaResult } {
  const part = new Part(mesh, opts);
  const want = new Set<string>(opts.checks ?? ALL_CHECKS);
  const checks: CheckResult[] = [];
  const run = (id: string, f: () => CheckResult) => {
    if (!want.has(id)) return;
    try { checks.push(f()); } catch (e) {
      checks.push({ id, title: id, status: "info", summary: `Check failed to run: ${(e as Error).message}`, accuracy: "estimate", findings: [], fixes: [], data: {} });
    }
  };
  run("mesh", () => checkMeshHealth(part));
  run("bed-fit", () => checkBedFit(part));
  run("overhangs", () => checkOverhangs(part));
  run("islands", () => checkIslands(part));
  run("thin-walls", () => checkThinWalls(part));
  run("stability", () => checkStability(part));
  run("warp", () => checkWarp(part));
  let fea: FeaResult | undefined;
  if (opts.load) {
    const s = checkStrength(part, opts.load, { requiredSafety: opts.requiredSafety });
    fea = s.fea;
    const { fea: _drop, ...plain } = s;
    checks.push(plain);
  }
  run("estimate", () => estimatePrint(part));
  return { report: buildReport(part, checks, opts.rotate), part, fea };
}

const WEIGHT: Record<string, number> = { mesh: 25, "bed-fit": 40, overhangs: 15, islands: 25, "thin-walls": 12, stability: 20, warp: 10, strength: 25, drop: 15, tilt: 10, push: 8, stack: 8, gcode: 15 };

export function buildReport(part: Part, checks: CheckResult[], rotation?: [number, number, number]): Report {
  const statuses = checks.map((c) => c.status);
  let score = 100;
  for (const c of checks) {
    const w = WEIGHT[c.id] ?? 10;
    if (c.status === "fail") score -= w;
    else if (c.status === "warn") score -= w * 0.35;
  }
  score = Math.max(0, Math.round(score));
  const w: Status = worst(statuses);
  const verdict: Report["verdict"] = w === "fail" ? "needs-changes" : w === "warn" ? "printable-with-care" : "ready";
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  const headline =
    verdict === "ready" ? "Ready to print — no problems found."
      : verdict === "needs-changes" ? `Needs changes: ${fails.map((c) => c.title.toLowerCase()).join(", ")}.`
        : `Printable with care: ${warns.map((c) => c.title.toLowerCase()).join(", ")}.`;
  const todo: string[] = [];
  for (const c of [...fails, ...warns]) for (const f of c.fixes) if (!todo.includes(f)) todo.push(f);
  return {
    verdict,
    score,
    headline,
    part: {
      material: part.material.name,
      printer: part.printer.name,
      size: part.bbox.size.map(r1) as Vec3,
      volumeMm3: r1(part.mass.volume),
      triangles: triCount(part.mesh),
      ...(rotation ? { rotation } : {}),
    },
    checks,
    todo,
  };
}

// ---------------------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------------------

export type VisualMode = "overview" | "overhangs" | "stability" | "stress" | "thin-walls" | "plain";

export function renderReport(part: Part, report: Report, mode: VisualMode = "overview", fea?: FeaResult, opts: { views?: ViewName[]; width?: number; height?: number } = {}) {
  const nT = triCount(part.mesh);
  const colors = new Uint8Array(nT * 3);
  for (let t = 0; t < nT; t++) colors.set(BASE_COLOR, t * 3);
  const markers: Marker[] = [];
  const lines: Polyline[] = [];
  const legend: { color: RGB; label: string }[] = [];
  const get = (id: string) => report.checks.find((c) => c.id === id);

  const paintOverhangs = () => {
    const oh = get("overhangs")?.data as { faceAngles?: number[] } | undefined;
    if (!oh?.faceAngles) return;
    oh.faceAngles.forEach((a, t) => {
      if (a > 60) colors.set([225, 45, 45], t * 3);
      else if (a > 45) colors.set([245, 170, 40], t * 3);
    });
    legend.push({ color: [245, 170, 40], label: "overhang 45-60°" }, { color: [225, 45, 45], label: "needs support >60°" });
  };
  const addStability = () => {
    const st = get("stability")?.data as { centerOfMass?: Vec3; supportPolygon?: [number, number][] } | undefined;
    if (!st?.centerOfMass) return;
    const z0 = part.bbox.min[2];
    if (st.supportPolygon && st.supportPolygon.length > 1) lines.push({ points: st.supportPolygon.map(([x, y]) => [x, y, z0] as Vec3), color: [40, 120, 220], closed: true, width: 3 });
    markers.push({ at: st.centerOfMass, color: [255, 255, 255], label: "COM", size: 7 });
    markers.push({ at: [st.centerOfMass[0], st.centerOfMass[1], z0], color: [40, 120, 220], size: 4 });
    legend.push({ color: [40, 120, 220], label: "footprint" }, { color: [255, 255, 255], label: "centre of mass" });
  };
  const addIslands = () => {
    const is = get("islands")?.data as { islands?: { center: Vec3 }[] } | undefined;
    for (const i of (is?.islands ?? []).slice(0, 6)) markers.push({ at: i.center, color: [200, 30, 200], label: "ISLAND", size: 6 });
    if (is?.islands?.length) legend.push({ color: [200, 30, 200], label: "floating island" });
  };
  const addThin = () => {
    const tw = get("thin-walls")?.data as { spots?: { at: Vec3; thickness: number }[] } | undefined;
    for (const s of (tw?.spots ?? []).slice(0, 6)) markers.push({ at: s.at, color: [250, 120, 0], label: `${s.thickness}MM`, size: 5 });
    if (tw?.spots?.length) legend.push({ color: [250, 120, 0], label: "thin wall" });
  };

  if (mode === "overview" || mode === "overhangs") paintOverhangs();
  if (mode === "overview" || mode === "stability") addStability();
  if (mode === "overview" || mode === "overhangs") addIslands();
  if (mode === "overview" || mode === "thin-walls") addThin();
  let pointColor: ((x: number, y: number, z: number, face: number) => RGB) | undefined;
  let mesh = part.mesh;
  if (mode === "stress" && fea) {
    mesh = part.designMesh; // FEA results live in design coordinates
    // colour each surface pixel by the element just inside it
    const g = fea.grid;
    const sfByVoxel = new Float32Array(g.nx * g.ny * g.nz).fill(-1);
    fea.elements.forEach((v, e) => (sfByVoxel[v] = fea.safety[e]));
    const { normals } = faceNormals(mesh);
    pointColor = (px, py, pz, t) => {
      for (const depth of [0.3, 0.9, 1.6, 2.5]) {
        const x = Math.floor((px - normals[t * 3] * g.size * depth - g.origin[0]) / g.size);
        const y = Math.floor((py - normals[t * 3 + 1] * g.size * depth - g.origin[1]) / g.size);
        const z = Math.floor((pz - normals[t * 3 + 2] * g.size * depth - g.origin[2]) / g.size);
        if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) continue;
        const sf = sfByVoxel[vIndex(g, x, y, z)];
        if (sf >= 0) return safetyColor(sf);
      }
      return [190, 190, 190];
    };
    const sd = get("strength")?.data as { hotspots?: { at: Vec3; safety: number }[] } | undefined;
    for (const h of (sd?.hotspots ?? []).slice(0, 3)) markers.push({ at: h.at, color: safetyColor(h.safety), label: `SF ${h.safety}`, size: 6 });
    legend.push(
      { color: safetyColor(0.8), label: "SF<1 breaks" },
      { color: safetyColor(1.4), label: "SF 1-2 weak" },
      { color: safetyColor(2.5), label: "SF 2-3 ok" },
      { color: safetyColor(8), label: "SF>3 low stress" },
    );
  }
  let title = `${report.verdict.toUpperCase()} (${report.score}/100) ${mode === "overview" ? "" : "- " + mode.toUpperCase()}`;
  if (mode === "stress" && part.rotation.some((a) => a)) title += ` - design pose, printed rotated ${part.rotation.join(",")}`;
  return renderPNG(mesh, { faceColors: mode === "stress" ? undefined : colors, pointColor, markers, lines, legend, title, views: opts.views, width: opts.width, height: opts.height });
}

// ---------------------------------------------------------------------------
// Orientation search
// ---------------------------------------------------------------------------

export interface OrientationCandidate {
  rotation: [number, number, number];
  label: string;
  supportArea: number;
  islands: number;
  tipAngle: number;
  contactArea: number;
  height: number;
  warpScore: number;
  status: Status;
  score: number;
}

/** Try laying the part on each of its largest flat faces (and the 6 axis directions); rank them. */
export function suggestOrientations(mesh: Mesh, opts: PartOptions = {}, max = 10): OrientationCandidate[] {
  const base = new Part(mesh, opts);
  const { normals, areas } = base.normals;
  // group face normals into directions (rounded) weighted by area
  const dirs = new Map<string, { n: Vec3; area: number }>();
  for (let t = 0; t < triCount(base.mesh); t++) {
    const n: Vec3 = [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]];
    const key = n.map((v) => Math.round(v * 20)).join(",");
    const d = dirs.get(key);
    if (d) d.area += areas[t]; else dirs.set(key, { n, area: areas[t] });
  }
  const axis: Vec3[] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const cands: Vec3[] = [...axis];
  for (const d of [...dirs.values()].sort((a, b) => b.area - a.area).slice(0, max)) {
    if (!cands.some((c) => c[0] * d.n[0] + c[1] * d.n[1] + c[2] * d.n[2] > 0.995)) cands.push(d.n);
  }
  const results: OrientationCandidate[] = [];
  for (const n of cands) {
    const rot = eulerToFaceDown(n);
    const combined = combine(opts.rotate, rot);
    const part = new Part(mesh, { ...opts, rotate: combined });
    const oh = checkOverhangs(part);
    const is = checkIslands(part);
    const st = checkStability(part);
    const wp = checkWarp(part);
    const supportArea = oh.data.supportArea;
    const islands = (is.data.islands as unknown[]).length;
    const score = 100 - Math.min(40, supportArea / 20) - islands * 10 - (st.status === "fail" ? 25 : st.status === "warn" ? 8 : 0) - (wp.status === "fail" ? 10 : wp.status === "warn" ? 4 : 0) - Math.min(10, part.bbox.size[2] / 25);
    results.push({
      rotation: combined.map((v) => Math.round(v * 10) / 10) as [number, number, number],
      label: describe(n),
      supportArea,
      islands,
      tipAngle: st.data.tipAngle,
      contactArea: st.data.contactArea,
      height: r1(part.bbox.size[2]),
      warpScore: (wp.data.score as number) ?? 0,
      status: worst([oh.status, is.status, st.status]),
      score: Math.round(score),
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

function describe(n: Vec3): string {
  const names: [Vec3, string][] = [[[0, 0, -1], "as designed (bottom down)"], [[0, 0, 1], "upside down (top face down)"], [[1, 0, 0], "+X face down"], [[-1, 0, 0], "-X face down"], [[0, 1, 0], "+Y face down"], [[0, -1, 0], "-Y face down"]];
  for (const [v, s] of names) if (v[0] * n[0] + v[1] * n[1] + v[2] * n[2] > 0.995) return s;
  return `face (${n.map((v) => v.toFixed(2)).join(", ")}) down`;
}

/** Euler XYZ (deg) that turns direction n to point straight down (-Z). */
export function eulerToFaceDown(n: Vec3): [number, number, number] {
  const target: Vec3 = [0, 0, -1];
  const c = n[0] * target[0] + n[1] * target[1] + n[2] * target[2];
  let R: number[][];
  if (c > 0.9999) R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  else if (c < -0.9999) R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]; // 180° about X
  else {
    const ax: Vec3 = [n[1] * target[2] - n[2] * target[1], n[2] * target[0] - n[0] * target[2], n[0] * target[1] - n[1] * target[0]];
    const s = Math.hypot(...ax);
    const k = ax.map((v) => v / s);
    const a = Math.atan2(s, c);
    const ca = Math.cos(a), sa = Math.sin(a), t = 1 - ca;
    R = [
      [ca + k[0] * k[0] * t, k[0] * k[1] * t - k[2] * sa, k[0] * k[2] * t + k[1] * sa],
      [k[1] * k[0] * t + k[2] * sa, ca + k[1] * k[1] * t, k[1] * k[2] * t - k[0] * sa],
      [k[2] * k[0] * t - k[1] * sa, k[2] * k[1] * t + k[0] * sa, ca + k[2] * k[2] * t],
    ];
  }
  return matToEuler(R);
}

function eulerToMat([x, y, z]: [number, number, number]): number[][] {
  const [a, b, c] = [x, y, z].map((d) => (d * Math.PI) / 180);
  const Rx = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Rz = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  return mm(Rz, mm(Ry, Rx));
}
function mm(A: number[][], B: number[][]): number[][] {
  return A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
}
function matToEuler(R: number[][]): [number, number, number] {
  // R = Rz·Ry·Rx
  const sy = -R[2][0];
  const y = Math.asin(Math.max(-1, Math.min(1, sy)));
  let x: number, z: number;
  if (Math.abs(sy) < 0.9999) { x = Math.atan2(R[2][1], R[2][2]); z = Math.atan2(R[1][0], R[0][0]); }
  else { x = Math.atan2(-R[1][2], R[1][1]); z = 0; }
  return [x, y, z].map((v) => (v * 180) / Math.PI) as [number, number, number];
}
/** rotation `first` then `second`, as one Euler triple */
function combine(first: [number, number, number] | undefined, second: [number, number, number]): [number, number, number] {
  if (!first) return second;
  return matToEuler(mm(eulerToMat(second), eulerToMat(first)));
}
