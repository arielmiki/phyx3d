// Stability: does it stand up, does it stick to the bed, does it wobble while printing.
import type { Part } from "./context.js";
import { layerStats, vIndex, voxelCenter } from "./voxel.js";
import { type P2, convexHull, signedDistanceToHull, minWidth } from "./geom2d.js";
import { type CheckResult, type Finding, type Status, r1, r2, r3, worst } from "./report.js";
import { triCount } from "./mesh.js";

export type StabilityData = {
  centerOfMass: [number, number, number];
  contactArea: number;
  supportPolygon: P2[];
  /** distance from COM (projected) to the nearest footprint edge; negative = outside */
  comMargin: number;
  /** how far the part can be tilted before it tips over, degrees */
  tipAngle: number;
  baseMinWidth: number;
  heightToBase: number;
  /** worst (height above a layer) / (that layer's width) — high = wobbles while printing */
  maxSlenderness: number;
  slenderAt: number;
  /** z where "printed so far" COM leaves the footprint (null = never) */
  leanOutAt: number | null;
  profile: { z: number; area: number; width: number; comX: number; comY: number }[];
};

export function checkStability(part: Part): CheckResult<StabilityData> {
  const m = part.mesh;
  const { normals, areas } = part.normals;
  const zMin = part.bbox.min[2];
  const height = part.bbox.size[2];
  const p = m.positions, idx = m.indices;

  // --- footprint from faces lying on the bed
  let contactArea = 0;
  const pts: P2[] = [];
  for (let t = 0; t < triCount(m); t++) {
    if (normals[t * 3 + 2] > -0.95) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    if (Math.max(p[a + 2], p[b + 2], p[c + 2]) > zMin + 0.05) continue;
    contactArea += areas[t];
    pts.push([p[a], p[a + 1]], [p[b], p[b + 1]], [p[c], p[c + 1]]);
  }
  const g = part.voxels();
  // curved bottoms (spheres, cylinders on their side) touch in a line/point: use the first
  // printed layer (≈ what actually sticks) instead
  if (contactArea < g.size * g.size * 4) {
    const firstLayerPts: P2[] = [];
    let cells = 0;
    for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
      if (!g.data[vIndex(g, x, y, 0)]) continue;
      cells++;
      const [cx, cy] = voxelCenter(g, x, y, 0);
      const h = g.size / 2;
      firstLayerPts.push([cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]);
    }
    if (firstLayerPts.length) {
      pts.length = 0;
      pts.push(...firstLayerPts);
      contactArea = cells * g.size * g.size;
    }
  }
  const hull = convexHull(pts);
  const com = part.mass.centerOfMass;
  const comH = com[2] - zMin;
  const sd = signedDistanceToHull([com[0], com[1]], hull);
  const tipAngle = (Math.atan2(Math.max(sd.distance, 0), Math.max(comH, 1e-6)) * 180) / Math.PI;
  const baseWidth = minWidth(hull);

  // --- layer by layer: slenderness and "printed so far" lean
  const stats = layerStats(g);
  let maxSlender = 0, slenderAt = 0;
  let leanOutAt: number | null = null;
  const profile: StabilityData["profile"] = [];
  const every = Math.max(1, Math.floor(stats.length / 60));
  for (let z = 0; z < g.nz; z++) {
    const layerPts: P2[] = [];
    for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
      if (!g.data[vIndex(g, x, y, z)]) continue;
      const [cx, cy] = voxelCenter(g, x, y, z);
      const h = g.size / 2;
      layerPts.push([cx - h, cy - h], [cx + h, cy + h], [cx - h, cy + h], [cx + h, cy - h]);
    }
    const lh = convexHull(layerPts);
    const w = minWidth(lh);
    const above = height - z * g.size;
    if (w > 0 && above > 5) {
      const s = above / w;
      if (s > maxSlender) { maxSlender = s; slenderAt = z * g.size; }
    }
    const st = stats[z];
    if (leanOutAt === null && z > 2 && hull.length >= 3 && signedDistanceToHull([st.cumCom[0], st.cumCom[1]], hull).distance < 0) {
      leanOutAt = r1(st.zTop);
    }
    if (z % every === 0 || z === g.nz - 1) profile.push({ z: r1(st.zTop), area: r1(st.area), width: r1(w), comX: r1(st.cumCom[0]), comY: r1(st.cumCom[1]) });
  }

  const findings: Finding[] = [];
  const fixes: string[] = [];
  const statuses: Status[] = [];
  const heightToBase = baseWidth > 0 ? height / baseWidth : Infinity;

  // standing on its own (after removal from the plate, in this orientation)
  if (sd.distance <= 0) {
    statuses.push("fail");
    findings.push({ status: "fail", message: `Centre of mass (${r3(com).join(", ")}) is ${r1(-sd.distance)} mm outside the footprint — it cannot stand in this orientation and pulls on the bed while printing.`, at: r3(com) });
    fixes.push("Widen the base or add a foot/outrigger on the side the part leans towards, or print it in a different orientation.");
  } else if (tipAngle < 10) {
    statuses.push("warn");
    findings.push({ status: "warn", message: `Tips over if tilted only ${r1(tipAngle)}° (COM ${r1(comH)} mm high, ${r1(sd.distance)} mm from the edge).`, at: r3(com) });
    fixes.push(`Lower the centre of mass or widen the base: every extra mm of margin adds ~${r1((Math.atan2(1, comH) * 180) / Math.PI)}° of tip resistance.`);
  } else {
    statuses.push("pass");
    findings.push({ status: "pass", message: `Stands on its own; tips only when tilted more than ${r1(tipAngle)}°.` });
  }

  // bed adhesion
  if (contactArea < 20) {
    statuses.push("fail");
    findings.push({ status: "fail", message: `Only ${r1(contactArea)} mm² touches the bed — very likely to detach.` });
    fixes.push("Add a flat face to sit on the bed (cut a flat on round bottoms), or use a brim (Bambu Studio → Others → Brim).");
  } else if (heightToBase > 8) {
    statuses.push("fail");
    findings.push({ status: "fail", message: `Tall and narrow: ${r1(height)} mm high on a ${r1(baseWidth)} mm wide base (ratio ${r1(heightToBase)}:1) — likely to be knocked off by the nozzle.` });
    fixes.push(`Use a brim of ~${Math.ceil(height / 10)} mm, add a sacrificial wider base/mouse ears, or print lying down.`);
  } else if (heightToBase > 4) {
    statuses.push("warn");
    findings.push({ status: "warn", message: `Height-to-base ratio ${r1(heightToBase)}:1 — add a brim to be safe.` });
    fixes.push("Enable a 5–8 mm brim.");
  } else {
    statuses.push("pass");
  }

  // wobble of thin sections during printing
  if (maxSlender > 20) {
    statuses.push("fail");
    findings.push({ status: "fail", message: `Section at z=${r1(slenderAt)} mm is very slender (${r1(maxSlender)}:1). It will sway under the nozzle — expect ringing, layer shifts or snapping.` });
    fixes.push("Thicken the slender section, add ribs/gussets, or print it lying down. Printing several copies at once gives each layer time to cool and reduces wobble.");
  } else if (maxSlender > 10) {
    statuses.push("warn");
    findings.push({ status: "warn", message: `Slender section at z=${r1(slenderAt)} mm (${r1(maxSlender)}:1) may wobble — slow outer walls help.` });
  }

  if (leanOutAt !== null) {
    statuses.push("warn");
    findings.push({ status: "warn", message: `From z≈${leanOutAt} mm the printed-so-far part leans past its footprint; the bed alone holds it — keep the plate clean and consider a brim.` });
  }

  const status = worst(statuses);
  return {
    id: "stability",
    title: "Stability & bed adhesion",
    status,
    summary: findings.filter((f) => f.status === status)[0]?.message ?? findings[0]?.message ?? "",
    accuracy: "estimate",
    findings,
    fixes,
    data: {
      centerOfMass: r3(com),
      contactArea: r1(contactArea),
      supportPolygon: hull.map(([x, y]) => [r2(x), r2(y)] as P2),
      comMargin: r2(sd.distance),
      tipAngle: r1(tipAngle),
      baseMinWidth: r1(baseWidth),
      heightToBase: isFinite(heightToBase) ? r1(heightToBase) : 999,
      maxSlenderness: r1(maxSlender),
      slenderAt: r1(slenderAt),
      leanOutAt,
      profile,
    },
  };
}

