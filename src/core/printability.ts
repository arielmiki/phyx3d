// Geometry checks: mesh health, bed fit, overhangs, unsupported islands, thin walls, estimates.
import { BufferGeometry, BufferAttribute, Ray, DoubleSide } from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { Part } from "./context.js";
import { findIslands, vIndex, type VoxelGrid } from "./voxel.js";
import { type CheckResult, type Finding, r1, r2, r3 } from "./report.js";
import { triCount } from "./mesh.js";

export function checkMeshHealth(part: Part): CheckResult {
  const h = part.health;
  const findings: Finding[] = [];
  const fixes: string[] = [];
  if (h.openEdges) {
    findings.push({ status: "fail", message: `${h.openEdges} open edges — the mesh has holes, so the slicer has to guess what is inside.` });
    fixes.push("Export a closed solid from your CAD tool (in build123d/CadQuery export the Solid, not faces); or repair in Bambu Studio (right-click → Fix model).");
  }
  if (h.nonManifoldEdges) {
    findings.push({ status: "warn", message: `${h.nonManifoldEdges} non-manifold edges (edges shared by 3+ faces), usually two bodies touching along an edge.` });
    fixes.push("Union overlapping/touching bodies into one solid before export, or separate them by ≥0.2 mm.");
  }
  if (h.flippedEdges) findings.push({ status: "warn", message: `${h.flippedEdges} edges where neighbouring faces have opposite normals.` });
  if (h.inverted) findings.push({ status: "info", message: "Mesh was inside-out (all normals inverted); phyx3d flipped it for analysis." });
  if (h.shells > 1) findings.push({ status: "info", message: `${h.shells} separate bodies in the file (printed together on one plate).` });
  const status = h.openEdges ? "fail" : h.nonManifoldEdges || h.flippedEdges ? "warn" : "pass";
  return {
    id: "mesh",
    title: "Mesh health",
    status,
    summary: status === "pass" ? `Watertight solid, ${h.triangles} triangles, ${h.shells} bod${h.shells === 1 ? "y" : "ies"}.` : findings[0].message,
    accuracy: "exact",
    findings,
    fixes,
    data: { ...h },
  };
}

export function checkBedFit(part: Part): CheckResult {
  const s = part.bbox.size;
  const v = part.printer.volume;
  const over = [0, 1, 2].filter((i) => s[i] > v[i]);
  const tight = [0, 1].filter((i) => s[i] > v[i] - 10);
  const axes = ["X", "Y", "Z"];
  const status = over.length ? "fail" : tight.length ? "warn" : "pass";
  return {
    id: "bed-fit",
    title: `Fits ${part.printer.name}`,
    status,
    summary: over.length
      ? `Too big: ${over.map((i) => `${axes[i]} ${r1(s[i])} mm > ${v[i]} mm`).join(", ")}.`
      : `Size ${r1(s[0])} × ${r1(s[1])} × ${r1(s[2])} mm fits the ${v[0]}×${v[1]}×${v[2]} mm build volume${tight.length ? " (very close to the edge — no room for a brim)" : ""}.`,
    accuracy: "exact",
    findings: [],
    fixes: over.length ? ["Rotate the part diagonally on the plate, scale it down, or split it into pieces with pins/dovetails."] : [],
    data: { size: r3(s), buildVolume: v },
  };
}

export interface OverhangCluster {
  area: number;
  /** worst angle from vertical, degrees (90 = flat ceiling) */
  maxAngle: number;
  center: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  /** a flat ceiling spanning between two walls — Bambu can usually bridge ≤ ~15 mm */
  bridgeLike: boolean;
  needsSupport: boolean;
}

/**
 * Overhangs: downward faces steeper than the threshold, measured from vertical.
 * Bambu Studio's default support threshold is 30° from horizontal = 60° from vertical.
 */
export function checkOverhangs(part: Part, opts: { warnAngle?: number; supportAngle?: number } = {}): CheckResult<{ clusters: OverhangCluster[]; faceAngles: number[]; overhangArea: number; supportArea: number }> {
  const warnAngle = opts.warnAngle ?? 45;
  const supportAngle = opts.supportAngle ?? 60;
  const { normals, areas } = part.normals;
  const m = part.mesh;
  const n = triCount(m);
  const zBed = part.bbox.min[2] + 0.05;
  const faceAngle = new Float32Array(n); // 0 = not an overhang
  const p = m.positions, idx = m.indices;
  for (let t = 0; t < n; t++) {
    const nz = normals[t * 3 + 2];
    if (nz >= 0) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    if (Math.max(p[a + 2], p[b + 2], p[c + 2]) <= zBed) continue; // sits on the bed
    const ang = (Math.asin(Math.min(1, -nz)) * 180) / Math.PI;
    if (ang > warnAngle) faceAngle[t] = ang;
  }
  // cluster overhang faces that share an edge
  const edgeOwner = new Map<string, number>();
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < n; t++) {
    if (!faceAngle[t]) continue;
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k], v = idx[t * 3 + ((k + 1) % 3)];
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      const o = edgeOwner.get(key);
      if (o === undefined) edgeOwner.set(key, t);
      else parent[find(t)] = find(o);
    }
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < n; t++) if (faceAngle[t]) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t);
  }
  const clusters: OverhangCluster[] = [];
  let overhangArea = 0, supportArea = 0;
  for (const faces of groups.values()) {
    let area = 0, maxA = 0, cx = 0, cy = 0, cz = 0;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    let sArea = 0;
    for (const t of faces) {
      const A = areas[t];
      area += A;
      if (faceAngle[t] > supportAngle) sArea += A;
      maxA = Math.max(maxA, faceAngle[t]);
      for (let k = 0; k < 3; k++) {
        const vi = idx[t * 3 + k] * 3;
        for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], p[vi + j]); mx[j] = Math.max(mx[j], p[vi + j]); }
        cx += (p[vi] * A) / 3; cy += (p[vi + 1] * A) / 3; cz += (p[vi + 2] * A) / 3;
      }
    }
    if (area < 1) continue; // ignore specks (tessellation noise)
    overhangArea += area;
    supportArea += sArea;
    const span = Math.min(mx[0] - mn[0], mx[1] - mn[1]);
    // a bridge needs material holding it up at BOTH ends of its short span; one end = cantilever
    let bridgeLike = false;
    if (maxA > 80 && span <= 15) {
      const g = part.voxels();
      const ax = mx[0] - mn[0] <= mx[1] - mn[1] ? 0 : 1;
      const other = 1 - ax;
      const mid = (mn[other] + mx[other]) / 2;
      const z = mn[2] - g.size;
      const at = (s: number): [number, number, number] => (ax === 0 ? [s, mid, z] : [mid, s, z]);
      bridgeLike = solidAt(g, at(mn[ax] - g.size)) && solidAt(g, at(mx[ax] + g.size));
    }
    clusters.push({
      area: r1(area),
      maxAngle: r1(maxA),
      center: r3([cx / area, cy / area, cz / area]),
      min: r3(mn),
      max: r3(mx),
      bridgeLike,
      needsSupport: sArea >= 1 && !bridgeLike,
    });
  }
  clusters.sort((a, b) => Number(b.needsSupport) - Number(a.needsSupport) || b.area - a.area);
  const needing = clusters.filter((c) => c.needsSupport);
  const bridges = clusters.filter((c) => c.bridgeLike);
  const findings: Finding[] = clusters.slice(0, 12).map((c) => ({
    status: c.needsSupport ? "fail" : "warn",
    message: c.bridgeLike
      ? `Bridge-like flat ceiling ${r1(c.area)} mm² (span ≤15 mm) at z=${c.min[2]} — usually prints without support, may sag slightly.`
      : `${c.needsSupport ? "Needs support" : "Steep overhang (rough surface)"}: ${r1(c.area)} mm² up to ${c.maxAngle}° from vertical at z=${c.min[2]}–${c.max[2]} mm.`,
    at: c.center,
  }));
  const fixes: string[] = [];
  if (needing.length) {
    fixes.push("Add 45° chamfers under overhanging edges instead of flat ledges (chamfers print cleanly; fillets on the underside don't).");
    fixes.push("Try another orientation (phyx3d `orient` tool compares them) so large flat faces sit on the bed.");
    fixes.push("For holes in vertical walls use a teardrop or diamond top.");
    fixes.push("Or accept supports: in Bambu Studio enable Support → tree(auto).");
  }
  const status = needing.length ? "fail" : clusters.length - bridges.length > 0 ? "warn" : "pass";
  return {
    id: "overhangs",
    title: "Overhangs & supports",
    status,
    summary: needing.length
      ? `${needing.length} area(s) need support (${r1(supportArea)} mm² steeper than ${supportAngle}°).`
      : clusters.length
        ? `No supports needed; ${clusters.length} steep/bridge area(s) may print a bit rough.`
        : "No overhangs beyond 45° — prints without supports.",
    accuracy: "exact",
    findings,
    fixes,
    data: { clusters, faceAngles: Array.from(faceAngle, (a) => Math.round(a)), overhangArea: r1(overhangArea), supportArea: r1(supportArea) },
  };
}

function solidAt(g: VoxelGrid, p: [number, number, number]): boolean {
  const x = Math.floor((p[0] - g.origin[0]) / g.size), y = Math.floor((p[1] - g.origin[1]) / g.size), z = Math.floor((p[2] - g.origin[2]) / g.size);
  if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return false;
  return g.data[vIndex(g, x, y, z)] === 1;
}

export function checkIslands(part: Part): CheckResult {
  const g = part.voxels();
  const islands = findIslands(g).filter((i) => i.area >= g.size * g.size * 2);
  const findings: Finding[] = islands.slice(0, 10).map((i) => ({
    status: "fail",
    message: `Starts in mid-air at z=${i.z} mm (${i.area} mm², x ${i.min[0]}–${i.max[0]}, y ${i.min[1]}–${i.max[1]}) — nothing below to print on.`,
    at: i.center,
  }));
  return {
    id: "islands",
    title: "Floating islands",
    status: islands.length ? "fail" : "pass",
    summary: islands.length
      ? `${islands.length} region(s) begin in mid-air and will fail without support.`
      : "Every layer rests on the layer below.",
    accuracy: "estimate",
    findings,
    fixes: islands.length
      ? ["Connect the floating part to the body with a 45° slope or rib, rotate the part, or enable supports."]
      : [],
    data: { islands, voxelSize: g.size },
  };
}

/**
 * Wall thickness by casting a ray inward from sampled surface points.
 * < nozzle width: won't print at all; < 2 lines: fragile/fills poorly.
 */
export function checkThinWalls(part: Part, samples = 6000): CheckResult {
  const m = part.mesh;
  const geom = new BufferGeometry();
  geom.setAttribute("position", new BufferAttribute(m.positions, 3));
  geom.setIndex(new BufferAttribute(new Uint32Array(m.indices), 1)); // BVH reorders the index
  const bvh = new MeshBVH(geom);
  const { normals, areas } = part.normals;
  const n = triCount(m);
  const minLine = part.printer.nozzle;
  const twoLines = part.settings.lineWidth * 2;

  // area-weighted deterministic sampling
  let total = 0;
  for (let t = 0; t < n; t++) total += areas[t];
  const step = total / samples;
  let acc = step / 2;
  const hits: { at: [number, number, number]; thickness: number; area: number }[] = [];
  const ray = new Ray();
  const p = m.positions, idx = m.indices;
  let tested = 0;
  for (let t = 0; t < n; t++) {
    acc += areas[t];
    if (acc < step) continue;
    const reps = Math.min(4, Math.floor(acc / step));
    acc -= reps * step;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    for (let r = 0; r < reps; r++) {
      // spread samples inside the triangle
      let u = ((r * 0.618 + 0.31) % 1), v = ((r * 0.414 + 0.27) % 1);
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const x = p[a] + u * (p[b] - p[a]) + v * (p[c] - p[a]);
      const y = p[a + 1] + u * (p[b + 1] - p[a + 1]) + v * (p[c + 1] - p[a + 1]);
      const z = p[a + 2] + u * (p[b + 2] - p[a + 2]) + v * (p[c + 2] - p[a + 2]);
      ray.origin.set(x - nx * 1e-3, y - ny * 1e-3, z - nz * 1e-3);
      ray.direction.set(-nx, -ny, -nz);
      const hit = bvh.raycastFirst(ray, DoubleSide, 0, twoLines * 1.01);
      tested++;
      // A wall is two roughly parallel faces (within 30°). A ray that meets the far face at a steeper
      // angle started beside a corner (a duct wall meeting an arm) or near a chamfered edge, which
      // tapers to nothing at its tip without being a thin wall: skip it.
      if (hit && hit.distance < twoLines && hit.face && -(nx * hit.face.normal.x + ny * hit.face.normal.y + nz * hit.face.normal.z) > 0.87)
        hits.push({ at: [x, y, z], thickness: hit.distance + 1e-3, area: areas[t] / reps });
    }
  }
  // bucket hits into 5 mm cells so the agent gets locations, not thousands of points
  const cells = new Map<string, { t: number[]; sx: number; sy: number; sz: number; area: number }>();
  for (const h of hits) {
    const key = h.at.map((v) => Math.floor(v / 5)).join(",");
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { t: [], sx: 0, sy: 0, sz: 0, area: 0 }));
    c.t.push(h.thickness); c.sx += h.at[0]; c.sy += h.at[1]; c.sz += h.at[2]; c.area += h.area;
  }
  const raw = [...cells.values()].map((c) => ({ t: c.t, at: [c.sx / c.t.length, c.sy / c.t.length, c.sz / c.t.length] as [number, number, number], area: c.area, low: Math.min(...c.t) }));
  // merge neighbouring cells into one region per thin feature
  const regions: { t: number[]; sx: number; sy: number; sz: number; area: number; min: number[]; max: number[] }[] = [];
  for (const c of raw.sort((a, b) => a.low - b.low)) {
    const n = c.t.length;
    const r = regions.find((g) => c.at.every((v, k) => v >= g.min[k] - 7.5 && v <= g.max[k] + 7.5));
    if (r) {
      r.t.push(...c.t); r.sx += c.at[0] * n; r.sy += c.at[1] * n; r.sz += c.at[2] * n; r.area += c.area;
      for (let k = 0; k < 3; k++) { r.min[k] = Math.min(r.min[k], c.at[k]); r.max[k] = Math.max(r.max[k], c.at[k]); }
    } else regions.push({ t: [...c.t], sx: c.at[0] * n, sy: c.at[1] * n, sz: c.at[2] * n, area: c.area, min: [...c.at], max: [...c.at] });
  }
  // A region's thickness is a low percentile of its samples, not its single thinnest ray: on a faceted
  // curved wall a few rays always land where facets meet, and one of them must not decide the verdict.
  // Faceting also reads a curved wall a few hundredths thin (both faces sag between facet edges),
  // hence the tolerance.
  const TOL = 0.05;
  const spots = regions
    .map((g) => {
      const t = [...g.t].sort((a, b) => a - b);
      const typical = t[Math.min(t.length - 1, Math.floor(t.length * 0.2))];
      return { thickness: r2(typical), thinnest: r2(t[0]), samples: t.length, at: r3([g.sx / t.length, g.sy / t.length, g.sz / t.length]), area: r1(g.area), min: r3(g.min), max: r3(g.max) };
    })
    .filter((s) => s.thickness < twoLines - TOL && (s.area >= 1 || s.samples >= 3))   // not specks (tessellation noise)
    .sort((a, b) => a.thickness - b.thickness);
  // too few samples to be sure it is a wall and not a corner: at most a warning
  const tooThin = spots.filter((s) => s.thickness < minLine && s.samples >= 3);
  const fragile = spots.filter((s) => !tooThin.includes(s));
  const findings: Finding[] = spots.slice(0, 10).map((s) => ({
    status: tooThin.includes(s) ? "fail" : "warn",
    message: `${tooThin.includes(s) ? "Too thin to print" : "Thin wall"}: ${s.thickness} mm around (${s.at.join(", ")}), spanning z ${s.min[2]}–${s.max[2]} mm.`,
    at: s.at,
  }));
  const status = tooThin.length ? "fail" : fragile.length ? "warn" : "pass";
  return {
    id: "thin-walls",
    title: "Wall thickness",
    status,
    summary: tooThin.length
      ? `${tooThin.length} area(s) thinner than the ${minLine} mm nozzle — they will be missing in the print.`
      : fragile.length
        ? `${fragile.length} area(s) thinner than ${r2(twoLines)} mm (2 lines) — will print but weak.`
        : `All walls ≥ ${r2(twoLines)} mm.`,
    accuracy: "estimate",
    findings,
    fixes: status === "pass" ? [] : [`Make walls at least ${r2(twoLines)} mm (2 × ${part.settings.lineWidth} mm lines); ${r2(part.settings.lineWidth * 4)} mm for parts that take load.`],
    data: { spots: spots.slice(0, 50), samplesTested: tested, minPrintable: minLine, recommended: r2(twoLines) },
  };
}

export function estimatePrint(part: Part): CheckResult {
  const { grams, solidFraction } = part.estimateGrams();
  const volPrinted = (grams / part.material.density) * 1000; // mm³
  const meters = volPrinted / (Math.PI * 0.875 ** 2) / 1000;
  // Effective flow is far below max flow because of walls, accel, travel. ~35% is typical on P1S.
  const seconds = volPrinted / (part.printer.maxFlow * 0.35) + 180 + part.bbox.size[2] / part.settings.layerHeight * 1.5;
  return {
    id: "estimate",
    title: "Filament & time estimate",
    status: "info",
    summary: `≈ ${r1(grams)} g ${part.material.name} (${r2(meters)} m), ≈ ${formatDuration(seconds)} at ${Math.round(part.settings.infill * 100)}% infill. Slice in Bambu Studio for exact numbers.`,
    accuracy: "rough-guide",
    findings: [],
    fixes: [],
    data: {
      grams: r1(grams),
      meters: r2(meters),
      seconds: Math.round(seconds),
      solidVolumeMm3: r1(part.mass.volume),
      printedFraction: r2(solidFraction),
      infill: part.settings.infill,
    },
  };
}

export function formatDuration(s: number): string {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

