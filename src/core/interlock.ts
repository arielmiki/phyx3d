// Interlocking parts: do two printed parts fit, go together, stay together, and only one way?
// Every interlock type is one of five motions — slide/push, twist, screw, snap, friction — so the
// checks are built on motion: a path the part travels, swept against the other parts.
// Parts are meshes in ASSEMBLED position.
import { BufferGeometry, BufferAttribute, Box3, Matrix4, Vector3, Ray, DoubleSide, Line3 } from "three";
import { MeshBVH, type HitPointInfo } from "three-mesh-bvh";
import { type Mesh, type Vec3, bbox, mergeMeshes, triCount } from "./mesh.js";
import { type CheckResult, type Finding, type Status, r2, r3, worst } from "./report.js";
import { renderPNG, type Marker, type Polyline, type RGB } from "./render.js";
import { partMesh, type MechPart } from "./mechanism.js";

// ----------------------------------------------------------------------------- spec

export type InterlockFamily = "slide" | "twist" | "screw" | "snap" | "friction" | "custom";

/** one motion of the moving part, in assembly coordinates */
export type Step =
  | { move: Vec3 }
  | { rotate: number; axis: Vec3; about?: Vec3 }
  /** rotate and advance together: a thread. `rotate` in degrees, advancing `pitch` mm per turn along `axis` */
  | { screw: number; pitch: number; axis: Vec3; about?: Vec3 };

interface Preset { family: InterlockFamily; hold: "lock" | "detent" | "none"; clearance: [number, number]; angle?: number }

const SLIDE: Preset = { family: "slide", hold: "none", clearance: [0.1, 0.4] };
const TWIST: Preset = { family: "twist", hold: "detent", clearance: [0.1, 0.5] };
const SNAP_DETENT: Preset = { family: "snap", hold: "detent", clearance: [0.1, 0.5] };
const SNAP_LOCK: Preset = { family: "snap", hold: "lock", clearance: [0.1, 0.5] };
const FRICTION: Preset = { family: "friction", hold: "none", clearance: [-0.25, -0.02] };

/** Interlock types and the motion family each one is checked as. Names are case/dash/space-insensitive. */
export const INTERLOCK_TYPES: Record<string, Preset> = {
  // sliding / keyed
  dovetail: SLIDE, "t-slot": SLIDE, tslot: SLIDE, "t-track": SLIDE, "t-key": SLIDE, "trapezoidal-slide": SLIDE,
  "l-key": SLIDE, "l-slot": SLIDE, "v-groove": SLIDE, "v-key": SLIDE, spline: SLIDE, "tongue-and-groove": SLIDE,
  "finger-slide": SLIDE, "keyed-slide": SLIDE, "puzzle-lock": SLIDE, slide: SLIDE,
  // structural (push together along one direction)
  "mortise-and-tenon": SLIDE, "finger-joint": SLIDE, "box-joint": SLIDE, "scarf-joint": SLIDE, "lap-joint": SLIDE,
  "half-lap": SLIDE, "bridle-joint": SLIDE, "cross-lap": SLIDE, "comb-joint": SLIDE, "key-and-slot": SLIDE, key: SLIDE, trap: SLIDE,
  // puzzle / decorative
  "jigsaw": SLIDE, "star-interlock": SLIDE, "cross-interlock": SLIDE, "z-lock": SLIDE, "s-lock": SLIDE, "dovetail-puzzle": SLIDE,
  // couplings and pins
  "pin-and-hole": SLIDE, "clevis-and-pin": SLIDE, "spline-coupling": SLIDE, "gear-coupling": SLIDE, "dog-clutch": SLIDE, "hirth": SLIDE,
  // twist / rotational
  bayonet: TWIST, "quarter-turn": { ...TWIST, angle: 90 }, "quarter-turn-tab": { ...TWIST, angle: 90 }, "twist-lock": TWIST,
  "cam-lock": TWIST, "rotary-dovetail": TWIST, "mousetrap-lock": TWIST, keyhole: { ...TWIST, family: "slide" },
  // screw
  thread: { family: "screw", hold: "none", clearance: [0.1, 0.4] }, helical: { family: "screw", hold: "none", clearance: [0.1, 0.4] },
  // snap / clip
  detent: SNAP_DETENT, "ball-snap": SNAP_DETENT, "spring-tab": SNAP_DETENT, "annular-snap": SNAP_LOCK, "cantilever-snap": SNAP_LOCK,
  "torsional-snap": SNAP_LOCK, "u-clip": SNAP_LOCK, "hook-and-latch": SNAP_LOCK, "barbed-snap": SNAP_LOCK, snap: SNAP_LOCK,
  "ball-and-socket": SNAP_LOCK,
  // friction
  "press-fit": FRICTION, "friction-lock": FRICTION, "wedge-lock": FRICTION, collet: FRICTION, "self-locking-polygon": FRICTION,
  custom: { family: "custom", hold: "none", clearance: [0.1, 0.5] },
};

/** extra spellings (the names people actually use) → a type above */
const ALIASES: Record<string, string> = {
  "t-track-t-key": "t-track", "finger-joint-box": "box-joint", "cross-shaped": "cross-interlock", "l-key-l-slot": "l-key", "v-groove-v-key": "v-groove", "finger-keyed-slide": "finger-slide",
  "finger-box": "box-joint", "box": "box-joint", "finger": "finger-joint", "3d-puzzle": "puzzle-lock", puzzle: "puzzle-lock",
  "interlocking-comb": "comb-joint", comb: "comb-joint", "interlocking-ring": "twist-lock", ring: "twist-lock",
  "geometric-friction": "friction-lock", "geometric-friction-lock": "friction-lock", "wedge-lock-coupling": "wedge-lock", wedge: "wedge-lock",
  "helical-threaded": "thread", threaded: "thread", screw: "thread", "mousetrap": "mousetrap-lock", "mousetrap-style-rotating": "mousetrap-lock",
  "hirth-style-serration": "hirth", "hirth-serration": "hirth", serration: "hirth", "u-shaped-snap-clip": "u-clip", "u-snap-clip": "u-clip",
  clip: "u-clip", "hook-latch": "hook-and-latch", latch: "hook-and-latch", barb: "barbed-snap", "spring": "spring-tab",
  "self-locking-polygon-joint": "self-locking-polygon", pin: "pin-and-hole", clevis: "clevis-and-pin", tenon: "mortise-and-tenon",
  "mortise-tenon": "mortise-and-tenon", "tongue-groove": "tongue-and-groove", "key-slot": "key-and-slot", "pressfit": "press-fit",
  "interference-fit": "press-fit", friction: "friction-lock", twist: "twist-lock", "turn-lock": "twist-lock", "ball-socket": "ball-and-socket",
};

/** Normalise a type name: case, spaces, "/", "-style", trailing "joint" / "fit" / "lock" / "interlock" / "coupling" are forgiven. */
export function interlockPreset(type: string | undefined): { name: string; preset: Preset } {
  const key = (type ?? "custom").toLowerCase().trim().replace(/[\s_/]+/g, "-").replace(/-+/g, "-");
  const stripped = key.replace(/-(joint|fit|interlock|style)$/, "");
  const cands = [key, stripped, `${key}-joint`, `${stripped}-lock`, `${stripped}-joint`, stripped.replace(/-lock$/, ""), stripped.replace(/-(lock|coupling)$/, "")];
  for (const k of cands) {
    if (INTERLOCK_TYPES[k]) return { name: k, preset: INTERLOCK_TYPES[k] };
    if (ALIASES[k]) return { name: ALIASES[k], preset: INTERLOCK_TYPES[ALIASES[k]] };
  }
  throw new Error(`Unknown interlock type "${type}". Known: ${Object.keys(INTERLOCK_TYPES).join(", ")} — or use "custom" with an \`insert\` path.`);
}

export interface InterlockSpec {
  name?: string;
  /** one of INTERLOCK_TYPES (dovetail, t-slot, bayonet, quarter-turn, thread, detent, press-fit, …) or "custom" */
  type?: string;
  /** part that moves when assembling */
  moving: string;
  /** parts it must fit against (default: all others) */
  against?: string[];
  /**
   * How the part goes IN, from outside to its assembled position, as steps.
   * Presets fill this in from `axis`/`travel`/`depth`/`angle`/`drop`/`slide` when omitted.
   */
  insert?: Step[];
  /** slide / push direction for slide, snap and friction types; push-then-twist axis for twist types; screw axis */
  axis?: Vec3;
  /** slide length in mm (default: part length along the axis + 2 mm) */
  travel?: number;
  /** twist types: push depth before the twist (mm) */
  depth?: number;
  /** twist types: twist in degrees (right-hand rule about `axis`); quarter-turn defaults to 90 */
  angle?: number;
  /** twist / screw centre (default: the moving part's centre) */
  center?: Vec3;
  /** screw: thread pitch in mm per turn, and turns to screw home */
  pitch?: number;
  turns?: number;
  /** keyhole: drop vector, then slide vector */
  drop?: Vec3;
  slide?: Vec3;
  /** what should stop it coming apart: "lock" (≥ 0.6 mm engagement), "detent" (≥ 0.2 mm after play), "none" */
  hold?: "lock" | "detent" | "none";
  /** designed clearance range in mm, e.g. [0.1, 0.4]; press-fit expects interference */
  clearance?: [number, number];
  /** try assembling it flipped / turned: every wrong way should jam (default true when there is a path) */
  wrongWays?: boolean;
}

export interface InterlockOptions {
  /** path sampling step in mm (default 0.1) and degrees (default 1) */
  step?: number;
  angleStep?: number;
  /** layer height for engagement advice (default 0.2) */
  layerHeight?: number;
}

// ----------------------------------------------------------------------------- collision world

/** Surfaces closer than this count as touching, not overlapping (resting contact is not a collision). */
const CONTACT = 0.02;
/** nudge used to tell touching from overlapping */
const NUDGE = 0.03;
/** finer nudge for locating a stop once found (reported distances are good to about this) */
const FINE = 0.005;

class Body {
  readonly geom: BufferGeometry;
  readonly bvh: MeshBVH;
  /** the same solid shrunk inward by CONTACT — used when this body is the one that moves */
  readonly coll: BufferGeometry;
  readonly collBvh: MeshBVH;
  readonly probe: Vector3;
  readonly box: Box3;
  constructor(readonly id: string, readonly mesh: Mesh) {
    this.box = boxOf(mesh);
    this.geom = geometry(mesh.positions, mesh.indices);
    this.bvh = new MeshBVH(this.geom);
    (this.geom as unknown as { boundsTree: MeshBVH }).boundsTree = this.bvh;
    this.coll = this.geom;
    this.collBvh = this.bvh;
    this.probe = interiorPoint(mesh);
  }
  /**
   * Is point p (in this body's frame) inside the solid? Ray parity, voted over three skew rays:
   * one ray grazing an edge or vertex counts that crossing twice and flips the answer.
   */
  contains(p: Vector3): boolean {
    let inside = 0;
    for (const d of RAYS) if (this.bvh.raycast(new Ray(p.clone(), d), DoubleSide).length % 2 === 1) inside++;
    return inside >= 2;
  }
}

const RAYS = [new Vector3(0.5773, 0.5774, 0.5773), new Vector3(-0.2673, 0.5345, 0.8018), new Vector3(0.8729, -0.2182, 0.4364)].map((v) => v.normalize());

function boxOf(mesh: Mesh, m?: Matrix4) {
  const b = bbox(mesh);
  const box = new Box3(new Vector3(...b.min), new Vector3(...b.max));
  return m ? box.applyMatrix4(m) : box;
}

/** does `mover` (posed by matrix m) overlap `fixed`? surface crossing or one inside the other */
function overlaps(fixed: Body, mover: Body, m: Matrix4, nudge = NUDGE): boolean {
  const bm = boxOf(mover.mesh, m), bf = fixed.box;
  if (!bm.intersectsBox(bf)) return false;
  if (crosses(fixed, mover, m)) {
    // Touching (a face resting on a face, an edge on a face) also crosses at zero depth. It is
    // only an overlap if nudging the part away by a hair in EVERY direction still leaves it crossing.
    for (const [, d] of AXES) {
      const nudged = new Matrix4().makeTranslation(d[0] * nudge, d[1] * nudge, d[2] * nudge).multiply(m);
      if (!crosses(fixed, mover, nudged)) return false;
    }
    return true;
  }
  // no surfaces cross: they overlap only if one is entirely inside the other, which needs
  // one bounding box inside the other — skip the (slower, edge-sensitive) point test otherwise
  if (bf.containsBox(bm) && fixed.contains(mover.probe.clone().applyMatrix4(m))) return true;
  if (bm.containsBox(bf) && mover.contains(fixed.probe.clone().applyMatrix4(m.clone().invert()))) return true;
  return false;
}

/**
 * Do the surfaces cross? Triangle pairs that are parallel and within CONTACT of each other are
 * faces resting on each other (a lid on a wall top), not an overlap — skip them.
 */
function crosses(fixed: Body, mover: Body, m: Matrix4): boolean {
  const n1 = new Vector3(), n2 = new Vector3();
  return fixed.bvh.bvhcast(mover.collBvh, m, {
    intersectsTriangles(t1, t2) {
      if (!t1.intersectsTriangle(t2)) return false;
      t1.getNormal(n1); t2.getNormal(n2);
      if (Math.abs(n1.dot(n2)) > 0.9995 && Math.abs(n1.dot(t2.a) - n1.dot(t1.a)) < CONTACT) return false;
      return true;
    },
  });
}

function geometry(positions: Float32Array, indices: Uint32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(new Uint32Array(indices), 1)); // the BVH reorders the index
  return g;
}

/** a point just inside the solid: a face centre stepped 0.05 mm against its outward normal */
function interiorPoint(m: Mesh): Vector3 {
  const p = m.positions, i = m.indices;
  let best = 0, bi = 0;
  for (let t = 0; t < i.length; t += 3) {
    const a = i[t] * 3, b = i[t + 1] * 3, c = i[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area > best) { best = area; bi = t; }            // largest face: its centre is far from edges
  }
  const a = i[bi] * 3, b = i[bi + 1] * 3, c = i[bi + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  const n = new Vector3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
  return new Vector3((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3).addScaledVector(n, -0.05);
}

/** does either solid really sink into the other by more than CONTACT? (vertex depth probe) */
/** How deep the two solids overlap in place, mm: deepest vertex of either one inside the other. */
function interferenceDepth(fixed: Body, mover: Body): number {
  const deep = (host: Body, guest: Body) => {
    let max = 0;
    const p = guest.mesh.positions, n = p.length / 3, stride = Math.max(1, Math.floor(n / 20000));
    const v = new Vector3(), t = { point: new Vector3(), distance: 0 } as HitPointInfo;
    for (let i = 0; i < n; i += stride) {
      v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      if (!host.box.containsPoint(v)) continue;
      const h = host.bvh.closestPointToPoint(v, t, 0, 100);
      if (h && h.distance > max && host.contains(v)) max = h.distance;
    }
    return max;
  };
  return Math.max(deep(fixed, mover), deep(mover, fixed));
}

function sinksIn(fixed: Body, mover: Body): boolean {
  const deep = (host: Body, guest: Body, toHost: Matrix4) => {
    const p = guest.mesh.positions, n = p.length / 3, stride = Math.max(1, Math.floor(n / 4000));
    const v = new Vector3(), t = { point: new Vector3(), distance: 0 } as HitPointInfo;
    for (let i = 0; i < n; i += stride) {
      v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).applyMatrix4(toHost);
      if (!host.box.containsPoint(v)) continue;
      const h = host.bvh.closestPointToPoint(v, t, 0, 100);
      if (h && h.distance > CONTACT && host.contains(v)) return true;
    }
    return false;
  };
  const idm = new Matrix4();
  return deep(fixed, mover, idm) || deep(mover, fixed, idm);
}

/** smallest gap between the two surfaces (0 when touching or overlapping) with where it is */
/**
 * Where the surfaces cross with the mover posed by `m`: a real point on the contact, not an average
 * of several. Crossings already there at `before` (resting contact) are ignored.
 */
function contactPoint(fixed: Body, mover: Body, m: Matrix4, before?: Matrix4): Vec3 | null {
  const n1 = new Vector3(), n2 = new Vector3(), seg = new Line3(), mid = new Vector3();
  const collect = (pose: Matrix4, keep: (a: number, b: number) => boolean, max: number) => {
    const out: { key: string; p: Vector3 }[] = [];
    fixed.bvh.bvhcast(mover.collBvh, pose, {
      intersectsTriangles(t1, t2, i1, i2) {
        if (!keep(i1, i2)) return false;
        // parallel pairs are resting faces (or apart); asking three-mesh-bvh for their edge only warns
        t1.getNormal(n1); t2.getNormal(n2);
        if (Math.abs(n1.dot(n2)) > 0.9995 || !t1.intersectsTriangle(t2, seg)) return false;
        out.push({ key: `${i1}:${i2}`, p: seg.getCenter(mid).clone() });
        return out.length >= max;
      },
    });
    return out;
  };
  const old = before ? new Set(collect(before, () => true, 100000).map((c) => c.key)) : new Set<string>();
  let pts = collect(m, (a, b) => !old.has(`${a}:${b}`), 300).map((c) => c.p);
  if (!pts.length) pts = collect(m, () => true, 300).map((c) => c.p);
  if (!pts.length) return null;
  // the crossing point nearest the mean: stays on one contact patch when there are several
  const mean = pts.reduce((a, b) => a.clone().add(b), new Vector3()).divideScalar(pts.length);
  const best = pts.reduce((a, b) => (b.distanceToSquared(mean) < a.distanceToSquared(mean) ? b : a));
  return [best.x, best.y, best.z];
}

function gap(fixed: Body, mover: Body, m: Matrix4, maxDist = 20): { d: number; pFixed: Vec3 } | null {
  const t1 = { point: new Vector3(), distance: Infinity } as HitPointInfo, t2 = { point: new Vector3(), distance: Infinity } as HitPointInfo;
  const hit = fixed.bvh.closestPointToGeometry(mover.geom, m, t1, t2, 0, maxDist);
  if (!hit) return null;
  if (t1.distance > 1e-4) return { d: t1.distance, pFixed: [t1.point.x, t1.point.y, t1.point.z] };
  // touching / overlapping: the query stops without a point, so locate the contact from the
  // mover's vertices that sit on (or inside) the fixed surface
  const p = mover.mesh.positions, n = p.length / 3, stride = Math.max(1, Math.floor(n / 3000));
  const v = new Vector3(), t = { point: new Vector3(), distance: 0 } as HitPointInfo;
  let sx = 0, sy = 0, sz = 0, c = 0;
  for (let i = 0; i < n; i += stride) {
    v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).applyMatrix4(m);
    const h = fixed.bvh.closestPointToPoint(v, t, 0, 0.05);
    if (h) { sx += v.x; sy += v.y; sz += v.z; c++; }
  }
  return { d: 0, pFixed: c ? [sx / c, sy / c, sz / c] : [NaN, NaN, NaN] };
}

// ----------------------------------------------------------------------------- motion

const v3 = (a: Vec3) => new Vector3(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function stepMatrix(s: Step, f: number, center: Vec3): Matrix4 {
  if ("move" in s) return new Matrix4().makeTranslation(s.move[0] * f, s.move[1] * f, s.move[2] * f);
  const c = s.about ?? center;
  const deg = "rotate" in s ? s.rotate : s.screw;
  const a = unit(s.axis);
  const r = new Matrix4().makeRotationAxis(v3(a), (deg * f * Math.PI) / 180);
  const m = new Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(r).multiply(new Matrix4().makeTranslation(-c[0], -c[1], -c[2]));
  if ("screw" in s) {
    // right-hand thread: advancing along +axis while turning positive
    const adv = ((deg * f) / 360) * s.pitch;
    return new Matrix4().makeTranslation(a[0] * adv, a[1] * adv, a[2] * adv).multiply(m);
  }
  return m;
}

/** removal = insertion reversed and inverted */
function removalOf(insert: Step[]): Step[] {
  return [...insert].reverse().map((s): Step => ("move" in s ? { move: [-s.move[0], -s.move[1], -s.move[2]] } : "rotate" in s ? { ...s, rotate: -s.rotate } : { ...s, screw: -s.screw }));
}

const stepSize = (s: Step) => ("move" in s ? Math.hypot(...s.move) : Math.abs("rotate" in s ? s.rotate : s.screw));
const stepUnit = (s: Step) => ("move" in s ? "mm" : "°");

interface Sweep {
  /** index of the removal step where contact happened, -1 = clear all the way */
  step: number;
  /** distance (mm or °) travelled in that step before contact */
  at: number;
  by?: string;
  where?: Vec3;
  /** total removal distance travelled before contact, summed over steps (mm + ° mixed only for display) */
}

/** Move `mover` from `start` along `steps`; report the first contact with any fixed body. */
function sweep(fixed: Body[], mover: Body, start: Matrix4, steps: Step[], center: Vec3, o: Required<InterlockOptions>, skipStart = true): Sweep {
  let pose = start.clone();
  for (let si = 0; si < steps.length; si++) {
    const s = steps[si];
    const size = stepSize(s);
    const inc = "move" in s ? o.step : o.angleStep;
    const n = Math.max(1, Math.ceil(size / inc));
    let lastFree = 0;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const m = stepMatrix(s, f, center).multiply(pose);
      const hit = fixed.find((b) => overlaps(b, mover, m));
      if (hit) {
        // refine between the last free sample and this one
        let lo = lastFree, hi = f;
        for (let it = 0; it < 8; it++) {
          const mid = (lo + hi) / 2;
          if (fixed.some((b) => overlaps(b, mover, stepMatrix(s, mid, center).multiply(pose)))) hi = mid; else lo = mid;
        }
        // `overlaps` only fires once the part has sunk in by about NUDGE (robust to faceting);
        // re-find the stop within the last sample with a much finer nudge
        const a0 = Math.max(0, lo - 1.5 / n);
        const pAt = (f2: number) => stepMatrix(s, f2, center).multiply(pose);
        if (!overlaps(hit, mover, pAt(a0), FINE)) {
          let a = a0, b = hi;
          for (let it = 0; it < 10; it++) {
            const mid = (a + b) / 2;
            if (overlaps(hit, mover, pAt(mid), FINE)) b = mid; else a = mid;
          }
          lo = Math.min(lo, a);
        }
        const cp = contactPoint(hit, mover, pAt(hi), pAt(Math.max(0, lo - 0.5 / n)));
        const g = cp ? null : gap(hit, mover, pAt(hi), 5);
        const where = cp ?? (g && isFinite(g.pFixed[0]) ? g.pFixed : undefined);
        return { step: si, at: r2(lo * size), by: hit.id, where: where ? r3(where) : undefined };
      }
      lastFree = f;
    }
    pose = stepMatrix(s, 1, center).multiply(pose);
  }
  return { step: -1, at: 0 };
}

// ----------------------------------------------------------------------------- the check

export type InterlockData = {
  interlock: string;
  type: string;
  family: InterlockFamily;
  moving: string;
  /** gap in mm; for press fits `interference` = how deep they overlap per side, mm */
  fit: { against: string; status: "interfering" | "clamped" | "touching" | "apart"; gap: number; interference?: number; at?: Vec3 }[];
  insertion?: { clear: boolean; firstContact?: { step: number; at: number; unit: string; by?: string; where?: Vec3 } };
  escapes: { direction: string; blockedAfter: number | null; by?: string }[];
  engagement?: { direction: string; lift: string; needed: number; freePlay: number; net: number; target: number };
  wrongWays: { variant: string; result: "jams" | "assembles" | "same-as-correct"; at?: string }[];
};

const AXES: [string, Vec3][] = [["+X", [1, 0, 0]], ["-X", [-1, 0, 0]], ["+Y", [0, 1, 0]], ["-Y", [0, -1, 0]], ["+Z", [0, 0, 1]], ["-Z", [0, 0, -1]]];

export function checkInterlock(parts: { id: string; mesh: Mesh }[], spec: InterlockSpec, opts: InterlockOptions = {}): CheckResult<InterlockData> & { picture: Uint8Array } {
  const o: Required<InterlockOptions> = { step: opts.step ?? 0.1, angleStep: opts.angleStep ?? 1, layerHeight: opts.layerHeight ?? 0.2 };
  const { name: type, preset } = interlockPreset(spec.type);
  const family = preset.family;
  const sliding = family !== "friction";
  const hold = spec.hold ?? preset.hold;
  const [cMin, cMax] = spec.clearance ?? preset.clearance;
  const movingPart = parts.find((p) => p.id === spec.moving);
  if (!movingPart) throw new Error(`Interlock "${spec.name ?? type}": moving part "${spec.moving}" not found`);
  const againstIds = spec.against ?? parts.filter((p) => p.id !== spec.moving).map((p) => p.id);
  const fixed = againstIds.map((id) => {
    const p = parts.find((q) => q.id === id);
    if (!p) throw new Error(`Interlock "${spec.name ?? type}": part "${id}" not found`);
    return new Body(id, p.mesh);
  });
  const mover = new Body(movingPart.id, movingPart.mesh);
  const mb = bbox(movingPart.mesh);
  const center: Vec3 = [(mb.min[0] + mb.max[0]) / 2, (mb.min[1] + mb.max[1]) / 2, (mb.min[2] + mb.max[2]) / 2];
  const reach = Math.max(...mb.size) + 5;
  const insert = spec.insert ?? presetPath(family, preset, spec, mb.size, center);
  const removal = insert ? removalOf(insert) : undefined;
  const id = new Matrix4();
  const findings: Finding[] = [];
  const statuses: Status[] = [];
  const fixes: string[] = [];
  const add = (s: Status, message: string, at?: Vec3) => { statuses.push(s); findings.push({ status: s, message, at }); };
  const name = spec.name ?? `${type} (${spec.moving})`;

  // 1 — fit in the assembled position
  const fit: InterlockData["fit"] = fixed.map((b) => {
    let inter = overlaps(b, mover, id);
    let clamped = false;
    if (inter && !sinksIn(b, mover)) { inter = false; clamped = true; }
    const g = gap(b, mover, id, 10);
    const d = g ? g.d : 10;
    const status: InterlockData["fit"][number]["status"] = inter ? "interfering" : clamped ? "clamped" : d < CONTACT ? "touching" : "apart";
    return { against: b.id, status, gap: inter ? 0 : r2(d), at: g && isFinite(g.pFixed[0]) ? r3(g.pFixed) : undefined } as InterlockData["fit"][number];
  });
  for (const f of fit) {
    if (family === "friction") {
      const [iMin, iMax] = [r2(-cMax), r2(-cMin)];
      if (f.status !== "interfering") { add("fail", `Press fit with ${f.against} doesn't grip: ${f.gap} mm gap (needs ${iMin}–${iMax} mm interference per side).`, f.at); fixes.push(`Make ${spec.moving} ${iMin}–${iMax} mm bigger per side than the hole in ${f.against} (FDM holes print ~0.1 mm small, so test-print a gauge first).`); continue; }
      const depth = r2(interferenceDepth(fixed.find((b) => b.id === f.against)!, mover));
      f.interference = depth;
      if (depth > iMax) { add("fail", `Press fit with ${f.against} is too tight: ${depth} mm interference per side (aim ${iMin}–${iMax}) — it won't go in, or it splits the part along its layers.`, f.at); fixes.push(`Reduce the interference between ${spec.moving} and ${f.against} to ${iMin}–${iMax} mm per side.`); }
      else if (depth < iMin) add("warn", `Press fit with ${f.against} is barely tight: ${depth} mm interference per side (aim ${iMin}–${iMax}); FDM tolerance may make it loose.`, f.at);
      else add("pass", `Press fit with ${f.against}: ${depth} mm interference per side (aim ${iMin}–${iMax}). Check the wall around it with \`phyx3d stress --move\` at that interference.`, f.at);
      continue;
    }
    if (f.status === "interfering") { add("fail", `${spec.moving} overlaps ${f.against} in the assembled position — they can't both exist there.`, f.at); fixes.push(`Leave ${cMin}–${cMax} mm clearance between ${spec.moving} and ${f.against}.`); }
    else if (f.status === "clamped") { add("fail", `${spec.moving} is clamped by ${f.against}: surfaces touch on opposite sides with zero clearance near (${f.at?.join(", ")}) — it will bind (or fuse). Leave ${cMin}–${cMax} mm on at least one side.`, f.at); fixes.push(`Open up the zero-gap faces between ${spec.moving} and ${f.against} to ${cMin}–${cMax} mm.`); }
    else if (f.status === "touching") { add("info", `${spec.moving} rests on ${f.against} (surfaces touch, no gap) near (${f.at?.join(", ")}) — fine for a bearing face on separately printed parts; print them apart or they fuse.`, f.at); }
    else if (f.gap > cMax && f.gap < 5 && sliding) add("info", `Smallest gap to ${f.against} is ${f.gap} mm (designed ${cMin}–${cMax}); check the joint isn't loose.`, f.at);
    else add("pass", `Fit with ${f.against}: ${f.gap} mm gap.`, f.at);
  }

  // 2 — the assembly path, swept (collision anywhere along it = jams)
  let insertion: InterlockData["insertion"];
  if (removal && sliding) {
    const sw = sweep(fixed, mover, id, removal, center, o);
    if (sw.step < 0) {
      insertion = { clear: true };
      if (hold === "none") add("pass", `Goes together along its path with no contact (${describePath(insert!)}).`);
      else add("warn", `Nothing stops ${spec.moving} coming back out along its path — the ${hold} doesn't engage.`);
    } else {
      const fromHome = r2(sw.at);
      insertion = { clear: false, firstContact: { step: sw.step, at: fromHome, unit: stepUnit(removal[sw.step]), by: sw.by, where: sw.where } };
      if (hold === "none") {
        add("fail", `Jams: contact with ${sw.by} ${sw.at === 0 && sw.step === 0 ? "right at the assembled position" : `${fromHome} ${stepUnit(removal[sw.step])} before home`}${insert!.length > 1 ? ` on step ${insert!.length - sw.step} of ${insert!.length}` : ""} (near ${sw.where?.join(", ")}).`, sw.where);
        fixes.push("Clear the path: every point along the slide/twist needs the same clearance as the final position (check chamfers and lead-ins).");
      } else {
        add("pass", `Held by the ${hold}: removing it touches ${sw.by} after ${fromHome} ${stepUnit(removal[sw.step])} (near ${sw.where?.join(", ")}).`, sw.where);
      }
    }
  }

  // 3 — escape tests in every direction from the assembled position
  const escapes: InterlockData["escapes"] = [];
  if (sliding) for (const [label, dir] of AXES) {
    const sw = sweep(fixed, mover, id, [{ move: [dir[0] * reach, dir[1] * reach, dir[2] * reach] }], center, o);
    escapes.push({ direction: label, blockedAfter: sw.step < 0 ? null : sw.at, by: sw.by });
  }
  if (sliding && removal && removal[0] && !("move" in removal[0])) {
    const s0 = removal[0] as Extract<Step, { axis: Vec3 }>;
    for (const sign of [1, -1]) {
      const sw = sweep(fixed, mover, id, [{ rotate: 360 * sign, axis: s0.axis, about: s0.about }], center, o);
      escapes.push({ direction: `${sign > 0 ? "+" : "-"}twist`, blockedAfter: sw.step < 0 ? null : sw.at, by: sw.by });
    }
  }
  const expectedOut = removal ? firstDirection(removal[0]) : null;
  const free = escapes.filter((e) => e.blockedAfter === null);
  const unexpected = free.filter((e) => e.direction !== expectedOut);
  const playText = escapes.filter((e) => e.blockedAfter !== null).map((e) => `${e.direction} ${e.blockedAfter}${e.direction.includes("twist") ? "°" : " mm"}`).join(", ");
  if (escapes.length && free.length === escapes.length) { add("fail", `${spec.moving} isn't held in any direction — it can simply fall/lift out.`); }
  else if (unexpected.length) {
    add(hold === "none" && !removal ? "info" : "warn", `${spec.moving} can come off towards ${unexpected.map((e) => e.direction).join(", ")} with nothing stopping it${removal ? " (not its assembly direction)" : ""}.`);
    if (removal) fixes.push(`Add an end stop, lip or cap so ${spec.moving} can't leave towards ${unexpected.map((e) => e.direction).join(", ")} — or ignore this if something else in the assembly blocks it.`);
  }
  if (playText) findings.push({ status: "info", message: `Free play before contact: ${playText}.` });

  // 4 — engagement of the catch that holds it (detent / lock): how far must something flex?
  let engagement: InterlockData["engagement"];
  if (removal && hold !== "none" && insertion && !insertion.clear) {
    const s = removal[insertion.firstContact!.step];
    // The catch escapes by flexing locally, not by the whole part lifting against its guides:
    // test the lift against only the geometry that blocks removal (the ridge, lip or barb).
    const { fixedCatch, moverCatch } = catchBodies(fixed, mover, s, insertion.firstContact!.at, center);
    const lifts = liftDirections(s);
    let best: InterlockData["engagement"] | undefined;
    for (const [lname, u] of lifts) {
      const needed = moverCatch ? liftOverCatch(fixedCatch, moverCatch, s, u, center) : null;
      if (needed === null) continue;
      const play = playAlong(fixed, mover, u, o);
      const net = r2(needed - play);
      if (!best || net < best.net) best = { direction: firstDirection(s) ?? "out", lift: lname, needed: r2(needed), freePlay: r2(play), net, target: hold === "lock" ? 0.6 : 0.2 };
    }
    if (best) {
      engagement = best;
      const ok = best.net >= best.target;
      const layers = best.needed / o.layerHeight;   // the catch height is what gets printed in layers
      add(ok ? "pass" : "fail", `${hold === "lock" ? "Lock" : "Detent"} engagement ${best.net} mm after ${best.freePlay} mm free play (the catch is ${best.needed} mm tall along ${best.lift}; needs ≥ ${best.target} mm left after play)${Math.abs(layers - Math.round(layers)) > 0.15 ? ` — ${best.needed} mm is not a whole number of ${o.layerHeight} mm layers if it is built along Z, so it may print as ${r2(Math.floor(layers) * o.layerHeight)} or ${r2(Math.ceil(layers) * o.layerHeight)} mm` : ""}.`);
      if (!ok) fixes.push(`Make the catch taller: free play (${best.freePlay} mm) + ${best.target} mm, rounded up to whole ${o.layerHeight} mm layers = ${r2(Math.ceil((best.freePlay + best.target) / o.layerHeight) * o.layerHeight)} mm.`);
    }
  }

  // 5 — wrong ways: flipped / turned copies should jam along the same path
  const wrongWays: InterlockData["wrongWays"] = [];
  if (insert && sliding && spec.wrongWays !== false) {
    for (const [label, axis] of [["flipped about X", [1, 0, 0]], ["flipped about Y", [0, 1, 0]], ["turned about Z", [0, 0, 1]]] as [string, Vec3][]) {
      const flip = new Matrix4().makeTranslation(...center).multiply(new Matrix4().makeRotationAxis(v3(axis), Math.PI)).multiply(new Matrix4().makeTranslation(-center[0], -center[1], -center[2]));
      if (sameShape(mover, flip)) { wrongWays.push({ variant: label, result: "same-as-correct" }); continue; }
      const jamsHome = fixed.some((b) => overlaps(b, mover, flip));
      const sw = jamsHome ? { step: 0, at: 0 } : sweep(fixed, mover, flip, removalOf(insert), center, o);
      if (jamsHome || sw.step >= 0) wrongWays.push({ variant: label, result: "jams", at: jamsHome ? "in place" : `${sw.at} ${stepUnit(removalOf(insert)[sw.step])} from home` });
      else wrongWays.push({ variant: label, result: "assembles" });
    }
    const bad = wrongWays.filter((w) => w.result === "assembles");
    if (bad.length) { add("warn", `Can be assembled the wrong way: ${bad.map((w) => w.variant).join(", ")}.`); fixes.push("Make it one way only: an off-centre key, a pin, or an asymmetric profile that jams when flipped."); }
    else if (wrongWays.some((w) => w.result === "jams")) add("pass", `One way only: ${wrongWays.filter((w) => w.result === "jams").map((w) => w.variant).join(", ")} jam${wrongWays.some((w) => w.result === "same-as-correct") ? " (symmetric flips are the same part and don't matter)" : ""}.`);
  }

  const status = worst(statuses.length ? statuses : ["info"]);
  const data: InterlockData = { interlock: name, type, family, moving: spec.moving, fit, insertion, escapes, engagement, wrongWays };
  const picture = renderInterlock(parts.filter((p) => p.id === spec.moving || againstIds.includes(p.id)), spec, name, insertion?.firstContact?.where, insert, center);
  const summary = status === "pass" && family === "friction" ? `Grips: ${fit.map((f) => f.interference).filter((x) => x !== undefined).join(" / ")} mm interference per side.`
    : status === "pass" ? `Fits, goes together${hold !== "none" ? `, holds (${engagement?.net ?? "?"} mm engagement)` : ""}${wrongWays.some((w) => w.result === "jams") ? ", one way only" : ""}.`
    : findings.filter((f) => f.status === status).map((f) => f.message).slice(0, 2).join(" ");
  return { id: "interlock", title: `Interlock: ${name}`, status, summary, accuracy: "exact", findings, fixes, data, picture };
}

// ----------------------------------------------------------------------------- helpers

function presetPath(family: InterlockFamily, preset: Preset, s: InterlockSpec, size: Vec3, center: Vec3): Step[] | undefined {
  const ax = s.axis ? unit(s.axis) : undefined;
  const alongLen = (a: Vec3) => Math.abs(a[0]) * size[0] + Math.abs(a[1]) * size[1] + Math.abs(a[2]) * size[2];
  if (s.drop && s.slide) return [{ move: s.drop }, { move: s.slide }];      // keyhole-style: drop, then slide
  if (!ax) return undefined;
  switch (family) {
    case "slide": case "snap": case "friction": {
      const L = s.travel ?? alongLen(ax) + 2;
      return [{ move: [ax[0] * L, ax[1] * L, ax[2] * L] }];
    }
    case "twist": {
      const angle = s.angle ?? preset.angle;
      if (angle === undefined) throw new Error("twist interlocks need `angle` (twist in degrees, right-hand rule about `axis`)");
      const d = s.depth ?? 5;
      return [{ move: [ax[0] * d, ax[1] * d, ax[2] * d] }, { rotate: angle, axis: ax, about: s.center ?? center }];
    }
    case "screw": {
      if (!s.pitch) throw new Error("thread interlocks need `pitch` (mm per turn) and `turns`");
      return [{ screw: 360 * (s.turns ?? 3), pitch: s.pitch, axis: ax, about: s.center ?? center }];
    }
    default:
      return undefined;
  }
}

function describePath(steps: Step[]): string {
  return steps.map((s) => ("move" in s ? `move ${s.move.map((v) => r2(v)).join(", ")} mm` : "rotate" in s ? `twist ${s.rotate}°` : `screw ${s.screw / 360} turns at ${s.pitch} mm pitch`)).join(", then ");
}

function firstDirection(s: Step | undefined): string | null {
  if (!s) return null;
  if ("rotate" in s) return s.rotate > 0 ? "+twist" : "-twist";
  if ("screw" in s) return s.screw > 0 ? "+screw" : "-screw";
  const u = unit(s.move);
  const i = [0, 1, 2].reduce((a, b) => (Math.abs(u[b]) > Math.abs(u[a]) ? b : a), 0);
  return `${u[i] > 0 ? "+" : "-"}${"XYZ"[i]}`;
}

/** directions a catch can be escaped by flexing, for a blocked removal step */
function liftDirections(s: Step): [string, Vec3][] {
  if (!("move" in s)) { const a = unit(s.axis); return [["along +axis", a], ["along -axis", [-a[0], -a[1], -a[2]]]]; }
  const u = unit(s.move);
  return AXES.filter(([, d]) => Math.abs(d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) < 0.3);
}

/**
 * The parts of `fixed` that block the removal step: the triangles the motion newly runs into just
 * past the first contact. Returned as small bodies (surface patches).
 */
function catchBodies(fixed: Body[], mover: Body, s: Step, at: number, center: Vec3): { fixedCatch: Body[]; moverCatch: Body | null } {
  const size = stepSize(s);
  const f = Math.min(1, (at + ("move" in s ? 0.3 : 3)) / size);
  const m = stepMatrix(s, f, center);
  const out: Body[] = [];
  const n1 = new Vector3(), c1 = new Vector3();
  // direction the moving part travels at point p during the step (removal direction)
  const travel = (p: Vector3): Vector3 => {
    if ("move" in s) return v3(unit(s.move));
    const a = v3(unit(s.axis)), o0 = v3(s.about ?? center);
    const deg = "rotate" in s ? s.rotate : s.screw;
    return a.clone().cross(p.clone().sub(o0)).multiplyScalar(Math.sign(deg)).normalize();
  };
  // A catch is a face the moving part runs INTO: its outward normal points against the travel.
  // Faces parallel to the motion (the rail top a plate slides on) are guides, not catches.
  const n2 = new Vector3(), c2 = new Vector3();
  const moverHit = new Set<number>();
  const crossing = (b: Body, mm: Matrix4, collectMover: boolean) => {
    const set = new Set<number>();
    b.bvh.bvhcast(mover.bvh, mm, {
      intersectsTriangles(t1, t2, i1, i2) {
        if (!t1.intersectsTriangle(t2)) return false;
        t1.getNormal(n1); t1.getMidpoint(c1);
        if (n1.dot(travel(c1)) < -0.2) set.add(i1);
        // t2 arrives in the fixed frame; its leading faces (normal along the travel) are the mover's catch
        t2.getNormal(n2); t2.getMidpoint(c2);
        if (collectMover && n2.dot(travel(c2)) > 0.2) moverHit.add(i2);
        return false;
      },
    });
    return set;
  };
  for (const b of fixed) {
    const atRest = crossing(b, new Matrix4(), false);
    const hit = new Set([...crossing(b, m, true)].filter((t) => !atRest.has(t)));   // only what the motion runs into
    if (!hit.size) continue;
    // exactly the faces the motion runs into (the ridge / lip / barb face) — padding the region
    // pulls in neighbouring guide faces that a rigid lift then collides with
    const pos = b.geom.getAttribute("position").array as Float32Array, idx = b.geom.index!.array as Uint32Array;
    const tri: number[] = [];
    for (const t of hit) for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k] * 3; tri.push(pos[v], pos[v + 1], pos[v + 2]); }
    if (tri.length) out.push(patch(`${b.id} (catch)`, tri));
  }
  // the mover's own catch face(s), in the mover's frame (the collision tests pose it)
  const mpos = mover.geom.getAttribute("position").array as Float32Array, midx = mover.geom.index!.array as Uint32Array;
  const mtri: number[] = [];
  for (const t of moverHit) for (let k = 0; k < 3; k++) { const v = midx[t * 3 + k] * 3; mtri.push(mpos[v], mpos[v + 1], mpos[v + 2]); }
  return { fixedCatch: out, moverCatch: mtri.length ? patch(`${mover.id} (catch)`, mtri) : null };
}

const patch = (id: string, tri: number[]) => new Body(id, { positions: new Float32Array(tri), indices: Uint32Array.from({ length: tri.length / 3 }, (_, i) => i) });

/**
 * How far the moving catch face must rise along u to pass over the fixed catch face:
 * the fixed catch's top along u minus the moving catch's bottom along u. Only counts when the
 * two faces overlap sideways (along w = travel × u), otherwise they never meet.
 */
function liftOverCatch(fixedCatch: Body[], moverCatch: Body, s: Step, u: Vec3, center: Vec3): number | null {
  const pts = (b: Body) => { const p = b.mesh.positions, out: Vector3[] = []; for (let i = 0; i < p.length; i += 3) out.push(new Vector3(p[i], p[i + 1], p[i + 2])); return out; };
  const mv = pts(moverCatch);
  const mid = mv.reduce((a, b) => a.add(b), new Vector3()).multiplyScalar(1 / mv.length);
  const t = "move" in s ? v3(unit(s.move)) : v3(unit(s.axis)).cross(mid.clone().sub(v3(s.about ?? center))).multiplyScalar(Math.sign("rotate" in s ? s.rotate : s.screw)).normalize();
  const U = v3(u), W = t.clone().cross(U).normalize();
  const range = (ps: Vector3[], d: Vector3) => { let lo = Infinity, hi = -Infinity; for (const q of ps) { const v = q.dot(d); lo = Math.min(lo, v); hi = Math.max(hi, v); } return [lo, hi]; };
  const [mwLo, mwHi] = range(mv, W), [muLo] = range(mv, U);
  let needed: number | null = null;
  for (const f of fixedCatch) {
    const fp = pts(f);
    const [fwLo, fwHi] = range(fp, W), [, fuHi] = range(fp, U);
    if (Math.min(mwHi, fwHi) - Math.max(mwLo, fwLo) < 0.05) continue;   // side by side, never meet
    const h = fuHi - muLo;
    if (h > 0) needed = Math.max(needed ?? 0, h);
  }
  return needed;
}

/** free movement along u from the assembled position before anything touches (mm, capped at 3) */
function playAlong(fixed: Body[], mover: Body, u: Vec3, o: Required<InterlockOptions>): number {
  const sw = sweep(fixed, mover, new Matrix4(), [{ move: [u[0] * 3, u[1] * 3, u[2] * 3] }], [0, 0, 0], { ...o, step: Math.min(o.step, 0.05) });
  return sw.step < 0 ? 3 : sw.at;
}

/** is the part transformed by m the same shape in the same place (a symmetric flip)? */
function sameShape(b: Body, m: Matrix4): boolean {
  const p = b.mesh.positions, n = p.length / 3;
  const stride = Math.max(1, Math.floor(n / 400));
  const v = new Vector3(), target = {} as HitPointInfo;
  for (let i = 0; i < n; i += stride) {
    v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).applyMatrix4(m);
    const h = b.bvh.closestPointToPoint(v, target, 0, 1);
    if (!h || h.distance > 0.05) return false;
  }
  return true;
}

function renderInterlock(parts: { id: string; mesh: Mesh }[], spec: InterlockSpec, name: string, contact: Vec3 | undefined, insert: Step[] | undefined, center: Vec3): Uint8Array {
  const meshes = parts.map((p) => p.mesh);
  const colors: number[] = [];
  parts.forEach((p) => {
    const c: RGB = p.id === spec.moving ? [124, 140, 255] : [205, 208, 216];
    for (let t = 0; t < triCount(p.mesh); t++) colors.push(...c);
  });
  const markers: Marker[] = contact ? [{ at: contact, color: [255, 92, 92], label: "CONTACT", size: 6 }] : [];
  const lines: Polyline[] = [];
  if (insert) {
    // draw the insertion path of the moving part's centre, arriving at its assembled position
    let pts: Vec3[] = [center];
    let p = new Vector3(...center);
    for (const s of removalOf(insert)) {
      const n = "move" in s ? 1 : 24;
      for (let k = 1; k <= n; k++) {
        const q = p.clone().applyMatrix4(stepMatrix(s, k / n, center));
        pts.push([q.x, q.y, q.z]);
      }
      p = new Vector3(...pts[pts.length - 1]);
    }
    pts = pts.reverse();
    lines.push({ points: pts, color: [245, 176, 65], width: 3 });
  }
  return renderPNG(mergeMeshes(meshes), { faceColors: new Uint8Array(colors), markers, lines, views: ["iso", "front", "top", "right"], bed: false,
    title: `INTERLOCK: ${name.toUpperCase()} - ${spec.moving.toUpperCase()} IN BLUE`,
    legend: [{ color: [124, 140, 255], label: `${spec.moving} (moving)` }, { color: [245, 176, 65], label: "insertion path" }, { color: [255, 92, 92], label: "first contact" }] }).png;
}

// ----------------------------------------------------------------------------- spec file

/** A `.interlock.json` file: the parts in their ASSEMBLED positions, and the interlocks between them. */
export interface InterlockFile {
  name?: string;
  parts: Pick<MechPart, "id" | "file" | "shape" | "position" | "rotation">[];
  interlocks: InterlockSpec[];
  /** printer layer height, mm (default 0.2) — catches thinner than ~2 layers print unreliably */
  layerHeight?: number;
  /** sweep resolution: mm per sample (default 0.1) and degrees per sample (default 1) */
  step?: number;
  angleStep?: number;
}

export interface InterlockRun {
  name: string;
  status: Status;
  summary: string;
  checks: (CheckResult<InterlockData> & { picture: Uint8Array })[];
  parts: { id: string; mesh: Mesh }[];
}

/** Check every interlock in a spec. `resolve` reads a part file named in the spec. */
export function checkInterlockFile(spec: InterlockFile, resolve: (file: string) => Uint8Array): InterlockRun {
  if (!spec.parts?.length) throw new Error("Interlock spec needs \"parts\"");
  if (!spec.interlocks?.length) throw new Error("Interlock spec needs \"interlocks\"");
  const ids = new Set<string>();
  for (const p of spec.parts) {
    if (ids.has(p.id)) throw new Error(`Part id "${p.id}" is used twice`);
    ids.add(p.id);
  }
  const parts = spec.parts.map((p) => ({ id: p.id, mesh: partMesh(p, resolve) }));
  const opts: InterlockOptions = { layerHeight: spec.layerHeight, step: spec.step, angleStep: spec.angleStep };
  const checks = spec.interlocks.map((j) => checkInterlock(parts, j, opts));
  const status = worst(checks.map((c) => c.status));
  const bad = checks.filter((c) => c.status === "fail").length, warn = checks.filter((c) => c.status === "warn").length;
  const summary = `${checks.length} interlock${checks.length > 1 ? "s" : ""}: ${checks.length - bad - warn} ok` + (warn ? `, ${warn} to look at` : "") + (bad ? `, ${bad} failing` : "") + ".";
  return { name: spec.name ?? "interlocks", status, summary, checks, parts };
}
