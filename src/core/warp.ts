// Warp / corner-lifting risk. This is a heuristic score from well-known risk factors, not a
// thermal simulation (that needs hours of CPU and exact slicer paths).
import type { Part } from "./context.js";
import { vIndex, voxelCenter } from "./voxel.js";
import { type P2, convexHull } from "./geom2d.js";
import { type CheckResult, type Finding, r1, r2 } from "./report.js";

export function checkWarp(part: Part): CheckResult {
  const mat = part.material;
  const g = part.voxels();
  // first-layer footprint
  const pts: P2[] = [];
  let cells = 0;
  for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    if (!g.data[vIndex(g, x, y, 0)]) continue;
    cells++;
    const [cx, cy] = voxelCenter(g, x, y, 0);
    pts.push([cx, cy]);
  }
  const hull = convexHull(pts);
  let span = 0;
  for (const a of hull) for (const b of hull) span = Math.max(span, Math.hypot(a[0] - b[0], a[1] - b[1]));
  const firstLayerArea = cells * g.size * g.size;
  // sharp convex corners of the footprint concentrate shrink stress
  let sharp = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[(i + hull.length - 1) % hull.length], b = hull[i], c = hull[(i + 1) % hull.length];
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
    if (l1 < 2 || l2 < 2) continue;
    const ang = (Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))) * 180) / Math.PI;
    if (ang < 100) sharp++;
  }
  // large solid cross-sections higher up pull harder as they cool
  const vol = part.mass.volume;
  const bulk = Math.min(1, vol / Math.max(firstLayerArea * 20, 1));

  const sizeF = Math.min(1, Math.max(0, (span - 30) / 150));
  const cornerF = Math.min(1, sharp / 4);
  let score = mat.warpTendency * (0.35 + 0.65 * sizeF) * (1 + 0.35 * cornerF) * (0.8 + 0.4 * bulk);
  const findings: Finding[] = [];
  const fixes: string[] = [];
  if (mat.needsEnclosure && !part.printer.enclosed) {
    score = Math.max(score, 0.75);
    findings.push({ status: "fail", message: `${mat.name} needs an enclosed printer; the ${part.printer.name} is open — expect cracking between layers and lifted corners.` });
    fixes.push(`Print in PLA/PETG instead, or build/buy an enclosure for the ${part.printer.name}.`);
  } else if (mat.needsEnclosure) {
    score *= 0.75;
    findings.push({ status: "info", message: `Keep the ${part.printer.name} door and top closed while printing ${mat.name}.` });
  }
  score = Math.min(1, score);
  const level = score < 0.2 ? "low" : score < 0.45 ? "medium" : "high";
  if (level !== "low") {
    fixes.push("Round the footprint corners (r ≥ 3 mm) or add 'mouse ear' discs at the corners.");
    fixes.push("Enable a brim (Bambu Studio → Others → Brim type: Outer brim, 5–8 mm).");
    fixes.push("Clean the plate with dish soap; use Textured PEI or glue stick for PETG/ABS.");
    if (span > 120) fixes.push("For long flat parts, split them or add relief slots to cut the continuous shrink length.");
  }
  if (sharp) findings.push({ status: level === "low" ? "info" : "warn", message: `${sharp} sharp corner(s) on the footprint — corners lift first.` });
  findings.unshift({ status: level === "high" ? "fail" : level === "medium" ? "warn" : "pass", message: `Warp risk ${level} (score ${r2(score)}): ${mat.name}, footprint span ${r1(span)} mm, first layer ${r1(firstLayerArea)} mm².` });
  return {
    id: "warp",
    title: "Warping risk",
    status: level === "high" ? "fail" : level === "medium" ? "warn" : "pass",
    summary: findings[0].message,
    accuracy: "rough-guide",
    findings,
    fixes,
    data: { score: r2(score), level, footprintSpan: r1(span), firstLayerArea: r1(firstLayerArea), sharpCorners: sharp },
  };
}
