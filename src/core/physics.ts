// Rigid-body physics with Rapier. Units: mm, grams, seconds (force unit g·mm/s² = 1e-6 N).
// The part becomes a compound of boxes built from its voxels, so concave shapes behave correctly.
import RAPIER from "@dimforge/rapier3d-compat";
import type { Part } from "./context.js";
import { voxelize, greedyBoxes, type VoxelGrid } from "./voxel.js";
import { type CheckResult, type Finding, type Status, r1, r2, r3, worst } from "./report.js";
import { checkStrength, scaleFea, type StrengthData } from "./fea.js";

let ready: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  return (ready ??= RAPIER.init());
}

type Quat = { x: number; y: number; z: number; w: number };
type V3 = { x: number; y: number; z: number };

const G = 9810; // mm/s²
const TO_N = 1e-6;

export type FloorType = "concrete" | "tile" | "wood" | "carpet";
/** impact contact duration (s) for a rigid plastic part — softer floors stretch the impact and lower the peak force */
const CONTACT_TIME: Record<FloorType, number> = { concrete: 0.0008, tile: 0.001, wood: 0.002, carpet: 0.006 };
/** stiffness (MPa) the contact times above are for: rigid printed plastics */
const RIGID_E = 2500;
/** below this stiffness (MPa) a part bends instead of breaking — TPU, TPE */
const FLEXIBLE_E = 200;

/**
 * An impact lasts about as long as the part takes to squash and spring back, ∝ √(m/k): a part much
 * softer than rigid plastic stretches the impact (TPU ~10×) and the peak deceleration drops as much.
 */
function contactTime(floor: FloorType, E: number): number {
  return CONTACT_TIME[floor] * Math.max(1, Math.sqrt(RIGID_E / E));
}

export interface Frame { t: number; p: [number, number, number]; q: [number, number, number, number] }

export interface PhysicsBody {
  /** boxes in part coordinates relative to the centre of mass: [cx,cy,cz,hx,hy,hz] */
  boxes: number[][];
  com: [number, number, number];
  massGrams: number;
  grid: VoxelGrid;
}

/** Build a box-compound collider from the part (≤ ~maxBoxes boxes). */
export function buildBody(part: Part, maxBoxes = 400): PhysicsBody {
  let size = Math.max(0.5, Math.cbrt(part.mass.volume / 6000));
  let grid: VoxelGrid, raw: ReturnType<typeof greedyBoxes>;
  for (;;) {
    grid = voxelize(part.mesh, size);
    raw = greedyBoxes(grid);
    if (raw.length <= maxBoxes || size > 20) break;
    size *= 1.35;
  }
  const com = part.mass.centerOfMass;
  // voxel rounding makes the compound slightly bigger/smaller than the part; rescale each axis
  // so the colliders span exactly the part's bounding box (matters for tip angles)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of raw) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[k]); hi[k] = Math.max(hi[k], b[k + 3]); }
  const bb = part.bbox;
  const map = (k: number, v: number) => bb.min[k] + ((v - lo[k]) / Math.max(hi[k] - lo[k], 1)) * bb.size[k];
  const boxes = raw.map((b) => {
    const out: number[] = [];
    for (let k = 0; k < 3; k++) out.push((map(k, b[k]) + map(k, b[k + 3])) / 2 - com[k]);
    for (let k = 0; k < 3; k++) out.push((map(k, b[k + 3]) - map(k, b[k])) / 2);
    return out;
  });
  return { boxes, com: [com[0], com[1], com[2]], massGrams: part.estimateGrams().grams, grid: grid! };
}

interface Sim {
  world: RAPIER.World;
  bodies: RAPIER.RigidBody[];
  floor: RAPIER.Collider;
}

function makeWorld(): Sim {
  const world = new RAPIER.World({ x: 0, y: 0, z: -G });
  world.lengthUnit = 1000;
  world.timestep = 1 / 600;
  world.numSolverIterations = 8;
  const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -50));
  const floor = world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 5000, 50).setFriction(0.5).setRestitution(0.3), floorBody);
  return { world, bodies: [], floor };
}

function addPart(sim: Sim, part: Part, body: PhysicsBody, pos: V3, rot: Quat, ccd = false): RAPIER.RigidBody {
  const rb = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(rot).setCcdEnabled(ccd).setCanSleep(true),
  );
  let volume = 0;
  for (const b of body.boxes) volume += 8 * b[3] * b[4] * b[5];
  const density = body.massGrams / volume; // g/mm³ that reproduces the printed mass
  for (const b of body.boxes) {
    sim.world.createCollider(
      RAPIER.ColliderDesc.cuboid(b[3], b[4], b[5])
        .setTranslation(b[0], b[1], b[2])
        .setDensity(density)
        .setFriction(part.material.friction)
        .setRestitution(part.material.restitution)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Average),
      rb,
    );
  }
  sim.bodies.push(rb);
  return rb;
}

// ---------- quaternion helpers ----------
export function rotate(q: Quat, v: [number, number, number]): [number, number, number] {
  const { x, y, z, w } = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
export const conj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const IDENT: Quat = { x: 0, y: 0, z: 0, w: 1 };
function angleBetween(a: Quat, b: Quat): number {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomQuat(rnd: () => number): Quat {
  const u1 = rnd(), u2 = rnd() * Math.PI * 2, u3 = rnd() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return { x: a * Math.sin(u2), y: a * Math.cos(u2), z: b * Math.sin(u3), w: b * Math.cos(u3) };
}
export function quatFromEulerDeg(rx: number, ry: number, rz: number): Quat {
  // X then Y then Z (matches mesh.rotateDeg)
  const q = (ax: [number, number, number], deg: number): Quat => {
    const h = (deg * Math.PI) / 360, s = Math.sin(h);
    return { x: ax[0] * s, y: ax[1] * s, z: ax[2] * s, w: Math.cos(h) };
  };
  return qmul(q([0, 0, 1], rz), qmul(q([0, 1, 0], ry), q([1, 0, 0], rx)));
}
function qmul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** lowest z of the part's boxes for a pose, plus the local point that is lowest */
function lowest(body: PhysicsBody, pos: V3, q: Quat): { z: number; local: [number, number, number] } {
  let best = Infinity, local: [number, number, number] = [0, 0, 0];
  for (const b of body.boxes) {
    for (let c = 0; c < 8; c++) {
      const p: [number, number, number] = [b[0] + (c & 1 ? b[3] : -b[3]), b[1] + (c & 2 ? b[4] : -b[4]), b[2] + (c & 4 ? b[5] : -b[5])];
      const w = rotate(q, p);
      if (w[2] + pos.z < best) { best = w[2] + pos.z; local = p; }
    }
  }
  return { z: best, local };
}

/** Which side of the part faces down, described in the part's print coordinates. */
function restingFace(q: Quat): string {
  const down = rotate(conj(q), [0, 0, -1]);
  const axes: [string, number][] = [["bottom (as printed)", -down[2]], ["top", down[2]], ["-X side", -down[0]], ["+X side", down[0]], ["-Y side", -down[1]], ["+Y side", down[1]]];
  axes.sort((a, b) => b[1] - a[1]);
  const [name, v] = axes[0];
  return v > 0.97 ? name : `${name} (tilted ${r1((Math.acos(Math.min(1, v)) * 180) / Math.PI)}°)`;
}

// =====================================================================
// DROP TEST
// =====================================================================

export interface DropOptions {
  /** drop height in mm (bottom of part to floor), default 1000 (desk ≈ 750) */
  height?: number;
  /** number of random orientations to try (default 8); ignored when `orientation` is given */
  trials?: number;
  /** fixed starting orientation, Euler degrees */
  orientation?: [number, number, number];
  floor?: FloorType;
  seed?: number;
  /** run an impact stress check on the worst trial (default true) */
  stress?: boolean;
  /** record a trajectory for animation (frames every 1/60 s) */
  record?: boolean;
}

export interface DropTrial {
  start: [number, number, number, number];
  impactSpeed: number; // m/s
  peakG: number;
  impactPoint: [number, number, number]; // part coords
  bounces: number;
  restsOn: string;
  settleTime: number;
  frames?: Frame[];
}

export async function dropTest(part: Part, opts: DropOptions = {}): Promise<CheckResult<{ trials: DropTrial[]; worst: DropTrial; impactStress?: StrengthData; massGrams: number }>> {
  await initPhysics();
  const body = buildBody(part);
  const height = opts.height ?? 1000;
  const floor = opts.floor ?? "tile";
  const rnd = mulberry32(opts.seed ?? 42);
  const starts: Quat[] = opts.orientation ? [quatFromEulerDeg(...opts.orientation)] : Array.from({ length: opts.trials ?? 8 }, () => randomQuat(rnd));
  const trials: DropTrial[] = [];
  for (const q0 of starts) {
    const sim = makeWorld();
    const lo = lowest(body, { x: 0, y: 0, z: 0 }, q0);
    const rb = addPart(sim, part, body, { x: 0, y: 0, z: height - lo.z }, q0, true);
    let prevV = rb.linvel(), prevW = rb.angvel(), prevQ = rb.rotation(), prevP = rb.translation();
    let impact: { speed: number; dv: number; point: [number, number, number] } | null = null;
    let contacts = 0, inContact = false, t = 0, settle = 0;
    const frames: Frame[] = [];
    const dt = sim.world.timestep;
    for (let step = 0; step < 600 * 6; step++) {
      sim.world.step();
      t += dt;
      const v = rb.linvel(), q = rb.rotation(), p = rb.translation();
      const lz = lowest(body, p, q).z;
      const touching = lz < 1.0;
      if (touching && !inContact) contacts++;
      inContact = touching;
      if (!impact && v.z - prevV.z > 0.3 * Math.abs(prevV.z) && prevV.z < -100) {
        // velocity of the lowest point just before impact
        const low = lowest(body, prevP, prevQ);
        const r = rotate(prevQ, low.local);
        const vp = prevV.z + (prevW.x * r[1] - prevW.y * r[0]);
        const dv = Math.hypot(v.x - prevV.x, v.y - prevV.y, v.z - prevV.z);
        impact = { speed: Math.abs(vp) / 1000, dv: dv / 1000, point: [low.local[0] + body.com[0], low.local[1] + body.com[1], low.local[2] + body.com[2]] };
      }
      if (opts.record && step % 10 === 0) frames.push({ t: r2(t), p: [r1(p.x), r1(p.y), r1(p.z)], q: [q.x, q.y, q.z, q.w] });
      prevV = v; prevW = rb.angvel(); prevQ = q; prevP = p;
      if (impact && rb.isSleeping()) { settle = t; break; }
      settle = t;
    }
    const e = part.material.restitution;
    const speed = impact?.speed ?? Math.sqrt(2 * 9.81 * (height / 1000));
    // peak deceleration of the body ≈ velocity change / contact time
    const dvBody = Math.max(impact?.dv ?? 0, speed * (1 + e) * 0.5);
    const peakG = dvBody / contactTime(floor, part.material.youngsModulus) / 9.81;
    trials.push({
      start: [q0.x, q0.y, q0.z, q0.w].map((x) => +x.toFixed(4)) as DropTrial["start"],
      impactSpeed: r2(speed),
      peakG: Math.round(peakG),
      impactPoint: r3(impact?.point ?? body.com),
      bounces: Math.max(0, contacts - 1),
      restsOn: restingFace(rb.rotation()),
      settleTime: r2(settle),
      ...(opts.record ? { frames } : {}),
    });
    sim.world.free();
  }
  const worstTrial = trials.reduce((a, b) => (b.peakG > a.peakG ? b : a));
  const findings: Finding[] = [];
  const statuses: Status[] = [];
  let impactStress: StrengthData | undefined;
  const flexible = part.material.youngsModulus < FLEXIBLE_E;
  if (opts.stress !== false && flexible) {
    // A linear stress check against tensile strength says nothing about a rubbery part: TPU stretches
    // several times its length before tearing, so a drop that snaps PLA just bends it.
    statuses.push("pass");
    findings.push({ status: "pass", message: `${part.material.name} is flexible: it absorbs the impact by bending (~${worstTrial.peakG} g) rather than cracking — drops don't break flexible parts. Check instead that it doesn't deform too much in use.` });
  } else if (opts.stress !== false) {
    // quasi-static impact: the floor holds the contact point, the rest of the part keeps moving
    const dir = [
      body.com[0] - worstTrial.impactPoint[0],
      body.com[1] - worstTrial.impactPoint[1],
      body.com[2] - worstTrial.impactPoint[2],
    ];
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    // inertial load pushes the body towards the contact point
    const accel: [number, number, number] = [(-dir[0] / len) * worstTrial.peakG, (-dir[1] / len) * worstTrial.peakG, (-dir[2] / len) * worstTrial.peakG];
    try {
      // contact patch: a few mm — a point contact would make the solve singular and slow
      const radius = Math.max(4, Math.max(part.bbox.size[0], part.bbox.size[1], part.bbox.size[2]) * 0.06);
      // FEA works in design coordinates. Coarse for speed on chunky parts; thin-walled parts refine
      // (up to 60k elements) until the walls are in the model.
      let flexNote: Finding | undefined;
      const fixedPatch = [{ sphere: { center: part.toDesign(worstTrial.impactPoint), radius } }];
      const opts = { elements: 6000, maxElements: 60000, tolerance: 1e-4, maxIterations: 3000, requiredSafety: 1.2 };
      let s = checkStrength(part, { fixed: fixedPatch, loads: [], acceleration: part.dirToDesign(accel) }, opts);
      // The rigid-body estimate assumes the whole part stops as fast as the contact point. A flexible part
      // (a thin frame, a long arm) bends and stops more slowly. Treat it as a spring of the stiffness this
      // solve measured: ½mv² = ½kδ² gives a peak force v·√(k·m), i.e. a peak acceleration v·√(a/δ), where
      // δ is how far its centre of mass moved under acceleration a. Use that when it is lower.
      const aVec = part.dirToDesign(accel);
      const aLen = Math.hypot(...aVec) || 1;
      const md = s.fea.meanDisplacement;
      const deltaCom = Math.abs((md[0] * aVec[0] + md[1] * aVec[1] + md[2] * aVec[2]) / aLen) / 1000;   // m
      const gFlex = deltaCom > 0 ? (worstTrial.impactSpeed * Math.sqrt((worstTrial.peakG * 9.81) / deltaCom)) / 9.81 : Infinity;
      if (s.data.residual < 1e-3 && gFlex < worstTrial.peakG * 0.9) {
        const f = gFlex / worstTrial.peakG;
        flexNote = ({ status: "info", message: `The part flexes enough to soften the impact: it stops over ~${r1(deltaCom * 1000 * worstTrial.peakG / gFlex)} mm, so it feels ~${Math.round(gFlex)} g instead of the ${worstTrial.peakG} g a rigid part would.` });
        worstTrial.peakG = Math.round(gFlex);
        s = checkStrength(part, { fixed: fixedPatch, loads: [], acceleration: [aVec[0] * f, aVec[1] * f, aVec[2] * f] }, { ...opts, result: scaleFea(s.fea, f) });
      }
      impactStress = s.data;
      if (!s.data.reliable) {
        statuses.push("warn");
        findings.push({ status: "warn", message: `Impact stress unreliable, so no verdict on breaking: ${s.data.unreliable.join("; ")}. Worst impact ${worstTrial.peakG} g landing on (${worstTrial.impactPoint.join(", ")}).`, at: worstTrial.impactPoint });
      } else {
        const st: Status = s.data.minSafetyFactor < 1 ? "fail" : s.data.minSafetyFactor < 1.5 ? "warn" : "pass";
        statuses.push(st);
        findings.push({
          status: st,
          message: st === "fail"
            ? `Likely to break when landing on (${worstTrial.impactPoint.join(", ")}): safety factor ${s.data.minSafetyFactor}, weakest near (${s.data.weakestAt.join(", ")}).`
            : `Survives the worst impact (${worstTrial.peakG} g) with safety factor ${s.data.minSafetyFactor}.`,
          at: st === "fail" ? s.data.weakestAt : worstTrial.impactPoint,
        });
      }
      if (flexNote) findings.push(flexNote);
    } catch (err) {
      findings.push({ status: "info", message: `Impact stress not computed: ${(err as Error).message}` });
    }
  }
  const restCounts = new Map<string, number>();
  for (const t of trials) restCounts.set(t.restsOn.replace(/ \(tilted.*$/, ""), (restCounts.get(t.restsOn.replace(/ \(tilted.*$/, "")) ?? 0) + 1);
  const rests = [...restCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ");
  findings.push({ status: "info", message: `Lands on: ${rests}. Worst impact ${worstTrial.impactSpeed} m/s → ~${worstTrial.peakG} g on ${floor}.` });
  const status = worst(statuses.length ? statuses : ["pass"]);
  return {
    id: "drop",
    title: `Drop test (${height} mm onto ${floor})`,
    status,
    summary: findings[0].message,
    accuracy: "simulated",
    findings,
    fixes: status === "pass" ? [] : [
      "Add fillets (r ≥ 2 mm) where thin features meet the body — sharp inside corners crack first.",
      "Use PETG or TPU for parts that get dropped; PLA is brittle.",
      "More walls (4+) help impact strength more than infill.",
    ],
    data: { trials, worst: worstTrial, impactStress, massGrams: r1(body.massGrams) },
  };
}

// =====================================================================
// TILT TEST — slowly tilt the table until the part tips or slides
// =====================================================================

export interface TiltOptions {
  /** number of tilt directions around the part (default 8) */
  directions?: number;
  /** part orientation on the table, Euler degrees (default: as printed) */
  orientation?: [number, number, number];
  maxAngle?: number;
  record?: boolean;
}

export async function tiltTest(part: Part, opts: TiltOptions = {}): Promise<CheckResult> {
  await initPhysics();
  const body = buildBody(part);
  const nDir = opts.directions ?? 8;
  const maxAngle = opts.maxAngle ?? 60;
  const q0 = opts.orientation ? quatFromEulerDeg(...opts.orientation) : IDENT;
  const results: { direction: number; tipsAt: number | null; slidesAt: number | null }[] = [];
  let frames: Frame[] | undefined;
  for (let d = 0; d < nDir; d++) {
    const az = (d / nDir) * Math.PI * 2;
    const sim = makeWorld();
    sim.world.timestep = 1 / 240;
    const lo = lowest(body, { x: 0, y: 0, z: 0 }, q0);
    const rb = addPart(sim, part, body, { x: 0, y: 0, z: -lo.z + 0.01 }, q0);
    rb.setLinearDamping(0.5);
    // settle first
    for (let i = 0; i < 120; i++) sim.world.step();
    const settledQ = rb.rotation(), settledP = rb.translation();
    let tipsAt: number | null = null, slidesAt: number | null = null, startsLifting: number | null = null;
    const rate = 5; // degrees per second — slow enough to be quasi-static
    const rec: Frame[] = [];
    for (let i = 0; i * sim.world.timestep * rate < maxAngle; i++) {
      const ang = i * sim.world.timestep * rate;
      const a = (ang * Math.PI) / 180;
      // tilting the table == rotating gravity the other way
      sim.world.gravity = { x: Math.sin(a) * Math.cos(az) * G, y: Math.sin(a) * Math.sin(az) * G, z: -Math.cos(a) * G };
      rb.wakeUp();
      sim.world.step();
      const q = rb.rotation(), p = rb.translation();
      if (opts.record && d === 0 && i % 4 === 0) rec.push({ t: r2(ang), p: [r1(p.x), r1(p.y), r1(p.z)], q: [q.x, q.y, q.z, q.w] });
      const rot = angleBetween(q, settledQ);
      if (rot > 0.5 && startsLifting === null) startsLifting = ang;
      if (rot < 0.3) startsLifting = null;
      if (tipsAt === null && rot > 2) {
        // confirm it keeps going over rather than rocking back
        for (let k = 0; k < 120; k++) sim.world.step();
        if (angleBetween(rb.rotation(), settledQ) > 10) { tipsAt = r1(startsLifting ?? ang); break; }
      }
      if (slidesAt === null && rot < 2 && Math.hypot(p.x - settledP.x, p.y - settledP.y) > 3) slidesAt = r1(ang);
      if (slidesAt !== null && ang > slidesAt + 4) break;
    }
    if (d === 0) frames = rec;
    results.push({ direction: Math.round((az * 180) / Math.PI), tipsAt, slidesAt });
    sim.world.free();
  }
  const tipAngles = results.map((r) => r.tipsAt).filter((x): x is number => x !== null);
  const minTip = tipAngles.length ? Math.min(...tipAngles) : null;
  const weakDir = results.find((r) => r.tipsAt === minTip)?.direction;
  const slideAngles = results.map((r) => r.slidesAt).filter((x): x is number => x !== null);
  const status: Status = minTip !== null && minTip < 10 ? "fail" : minTip !== null && minTip < 20 ? "warn" : "pass";
  const summary = minTip === null
    ? `Does not tip over up to ${maxAngle}° of table tilt${slideAngles.length ? `; slides at ~${Math.min(...slideAngles)}°` : ""}.`
    : `Tips over at ${minTip}° of tilt (towards ${weakDir}°)${slideAngles.length ? `; slides first at ~${Math.min(...slideAngles)}° in some directions` : ""}.`;
  return {
    id: "tilt",
    title: "Tilt test",
    status,
    summary,
    accuracy: "simulated",
    findings: results.map((r) => ({ status: r.tipsAt !== null && r.tipsAt < 10 ? "fail" : "info", message: `Direction ${r.direction}°: ${r.tipsAt !== null ? `tips at ${r.tipsAt}°` : "no tip"}${r.slidesAt !== null ? `, slides at ${r.slidesAt}°` : ""}` })),
    fixes: status === "pass" ? [] : [`Widen the base towards ${weakDir}° or move mass lower/towards the centre.`, "Add a rubber foot or weight pocket if it must stand on sloped surfaces."],
    data: { results, minTipAngle: minTip, weakDirection: weakDir, ...(opts.record ? { frames } : {}) },
  };
}

// =====================================================================
// PUSH TEST — how hard can you push the top sideways before it tips/slides
// =====================================================================

export interface PushOptions {
  /** push height in mm above the table (default: top of the part) */
  height?: number;
  directions?: number;
  orientation?: [number, number, number];
}

export async function pushTest(part: Part, opts: PushOptions = {}): Promise<CheckResult> {
  await initPhysics();
  const body = buildBody(part);
  const nDir = opts.directions ?? 8;
  const q0 = opts.orientation ? quatFromEulerDeg(...opts.orientation) : IDENT;
  const weightN = (body.massGrams / 1000) * 9.81;
  const results: { direction: number; forceN: number; outcome: "tips" | "slides" | "holds" }[] = [];
  for (let d = 0; d < nDir; d++) {
    const az = (d / nDir) * Math.PI * 2;
    const sim = makeWorld();
    sim.world.timestep = 1 / 480;
    const lo = lowest(body, { x: 0, y: 0, z: 0 }, q0);
    const rb = addPart(sim, part, body, { x: 0, y: 0, z: -lo.z + 0.01 }, q0);
    for (let i = 0; i < 240; i++) sim.world.step();
    const q1 = rb.rotation(), p1 = rb.translation();
    // top of the part in world
    let top = -Infinity;
    for (const b of body.boxes) for (let c = 0; c < 8; c++) {
      const w = rotate(q1, [b[0] + (c & 1 ? b[3] : -b[3]), b[1] + (c & 2 ? b[4] : -b[4]), b[2] + (c & 4 ? b[5] : -b[5])]);
      top = Math.max(top, w[2] + p1.z);
    }
    const hz = Math.min(opts.height ?? top, top);
    const maxF = weightN * 1.5; // push up to 1.5× its own weight
    let outcome: "tips" | "slides" | "holds" = "holds", forceN = maxF, liftF: number | null = null;
    const steps = 480 * 8;
    for (let i = 0; i < steps; i++) {
      const F = (maxF * i) / steps;
      rb.resetForces(true);
      rb.resetTorques(true);
      const pos = rb.translation();
      // push at the given height through the part's current centre line
      rb.addForceAtPoint({ x: (F / TO_N) * Math.cos(az), y: (F / TO_N) * Math.sin(az), z: 0 }, { x: pos.x, y: pos.y, z: hz }, true);
      sim.world.step();
      const q = rb.rotation(), p = rb.translation();
      const rot = angleBetween(q, q1);
      if (rot > 0.5 && liftF === null) liftF = F;
      if (rot < 0.3) liftF = null;
      if (rot > 5) { outcome = "tips"; forceN = liftF ?? F; break; }
      if (Math.hypot(p.x - p1.x, p.y - p1.y) > 3) { outcome = "slides"; forceN = F; break; }
    }
    results.push({ direction: Math.round((az * 180) / Math.PI), forceN: +forceN.toPrecision(3), outcome });
    sim.world.free();
  }
  const tips = results.filter((r) => r.outcome === "tips");
  const weakest = tips.length ? tips.reduce((a, b) => (b.forceN < a.forceN ? b : a)) : null;
  const ratio = weakest ? weakest.forceN / weightN : Infinity;
  const status: Status = ratio < 0.1 ? "fail" : ratio < 0.25 ? "warn" : "pass";
  return {
    id: "push",
    title: "Push test",
    status,
    summary: weakest
      ? `A sideways push of ${weakest.forceN} N (${r1((weakest.forceN / 9.81) * 1000)} gf, ${r2(ratio)}× its weight) at the top tips it over (direction ${weakest.direction}°).`
      : `Slides before it tips — stable against pushes (weight ${r2(weightN)} N).`,
    accuracy: "simulated",
    findings: results.map((r) => ({ status: "info", message: `${r.direction}°: ${r.outcome} at ${r.forceN} N` })),
    fixes: status === "pass" ? [] : ["Lower the centre of mass (thicker base, weight pocket for a steel nut/coins) or widen the footprint."],
    data: { results, weightN: +weightN.toFixed(3), massGrams: r1(body.massGrams), pushHeight: opts.height ?? "top" },
  };
}

// =====================================================================
// STACK TEST — stack N copies and see if the tower stays up
// =====================================================================

export async function stackTest(part: Part, opts: { count?: number; orientation?: [number, number, number]; jitter?: number; record?: boolean } = {}): Promise<CheckResult> {
  await initPhysics();
  const body = buildBody(part);
  const n = opts.count ?? 3;
  const q0 = opts.orientation ? quatFromEulerDeg(...opts.orientation) : IDENT;
  const sim = makeWorld();
  const rnd = mulberry32(7);
  const jitter = opts.jitter ?? 1;
  let lo = Infinity, hi = -Infinity;
  for (const b of body.boxes) for (let c = 0; c < 8; c++) {
    const w = rotate(q0, [b[0] + (c & 1 ? b[3] : -b[3]), b[1] + (c & 2 ? b[4] : -b[4]), b[2] + (c & 4 ? b[5] : -b[5])]);
    lo = Math.min(lo, w[2]); hi = Math.max(hi, w[2]);
  }
  const hgt = hi - lo;
  const rbs: RAPIER.RigidBody[] = [];
  const starts: V3[] = [];
  for (let i = 0; i < n; i++) {
    const p = { x: (rnd() - 0.5) * 2 * jitter, y: (rnd() - 0.5) * 2 * jitter, z: -lo + i * (hgt + 0.2) + 0.05 };
    starts.push(p);
    rbs.push(addPart(sim, part, body, p, q0));
  }
  const frames: Frame[][] = rbs.map(() => []);
  for (let s = 0; s < 600 * 4; s++) {
    sim.world.step();
    if (opts.record && s % 10 === 0) rbs.forEach((rb, i) => {
      const p = rb.translation(), q = rb.rotation();
      frames[i].push({ t: r2(s / 600), p: [r1(p.x), r1(p.y), r1(p.z)], q: [q.x, q.y, q.z, q.w] });
    });
  }
  const res = rbs.map((rb, i) => {
    const p = rb.translation();
    return { index: i, tilt: r1(angleBetween(rb.rotation(), q0)), moved: r1(Math.hypot(p.x - starts[i].x, p.y - starts[i].y)), fell: angleBetween(rb.rotation(), q0) > 20 || p.z < starts[i].z - hgt * 0.5 };
  });
  sim.world.free();
  const fell = res.filter((r) => r.fell);
  const status: Status = fell.length ? "fail" : res.some((r) => r.tilt > 5 || r.moved > 3) ? "warn" : "pass";
  return {
    id: "stack",
    title: `Stack test (${n} copies)`,
    status,
    summary: fell.length ? `${fell.length} of ${n} stacked copies fall off.` : status === "warn" ? `Stack holds but shifts (max tilt ${Math.max(...res.map((r) => r.tilt))}°).` : `${n} copies stack stably.`,
    accuracy: "simulated",
    findings: res.map((r) => ({ status: r.fell ? "fail" : "info", message: `Copy ${r.index + 1}: tilt ${r.tilt}°, slid ${r.moved} mm` })),
    fixes: status === "pass" ? [] : ["Add a locating lip/recess so copies nest, or make top and bottom faces flat and parallel."],
    data: { copies: res, ...(opts.record ? { frames } : {}) },
  };
}
