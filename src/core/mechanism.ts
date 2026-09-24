// Mechanism simulation: several printed parts + joints + motors in a real physics world.
// Answers: does the robot walk / the car drive / the gripper close / the linkage jam?
// Units inside the physics world: mm, grams, seconds (torque g·mm²/s² = 1e-9 N·m, force g·mm/s² = 1e-6 N).
import RAPIER from "@dimforge/rapier3d-compat";
import { initPhysics, rotate, quatFromEulerDeg, conj } from "./physics.js";
import { type Mesh, type Vec3, box, cylinder, uvSphere, rotateDeg, translate, bbox, massProps, mergeMeshes, poseMesh, triCount } from "./mesh.js";
import { loadFile } from "./loaders.js";
import { Part } from "./context.js";
import { voxelize, greedyBoxes } from "./voxel.js";
import { compileSignal, type Signal } from "./expr.js";
import { type CheckResult, type Finding, type Status, r1, r2, worst } from "./report.js";
import { renderScenes, type RGB } from "./render.js";

// ----------------------------------------------------------------------------- spec

export type Shape =
  | { box: [number, number, number] }
  | { cylinder: { r: number; h: number; axis?: "x" | "y" | "z" } }
  | { sphere: { r: number } };

export interface MechPart {
  id: string;
  /** STL / 3MF file (relative to the .mech.json) — or use `shape` for quick prototypes */
  file?: string;
  /** primitive centred on `position` */
  shape?: Shape;
  /** move the part (mm) — applied after `rotation` */
  position?: Vec3;
  /** rotate the part, Euler degrees X→Y→Z, about its own file origin / shape centre */
  rotation?: Vec3;
  material?: string;
  /** infill % for mass (default 15) */
  infill?: number;
  /** total mass in grams — overrides the printed-mass estimate */
  mass?: number;
  /** grams added on top, spread over the part (electronics, screws) */
  extraMass?: number;
  /** concentrated masses at exact points (payload in a gripper, battery pack, motor): grams + position in assembly mm */
  payloads?: { mass: number; at: Vec3; label?: string }[];
  /** anchored to the world (a base, a frame screwed to the table) */
  fixed?: boolean;
  /** surface friction (default: material; ~0.9 for TPU tyres) */
  friction?: number;
  color?: string;
}

export interface MechMotor {
  /** SG90, MG90S, MG996R, DS3218, STS3215, TT, N20, JGA25, NEMA17, LINEAR — sets torque, speed, mass */
  preset?: string;
  /** position (servo: target in ° or mm) or velocity (motor: target in rpm or mm/s) */
  mode?: "position" | "velocity";
  /**
   * constant, expression like "30*sin(2*pi*t)", or {keyframes:[[t,v],…], loop}.
   * Expressions can read the tracked part's live state for feedback: t (s), yaw/pitch/roll (°),
   * x/y/z (mm, centre of mass), speed (mm/s).
   */
  target: Signal;
  /** N·m (rotary) or N (linear) — overrides preset */
  maxTorque?: number;
  /** °/s, rpm or mm/s — overrides preset */
  maxSpeed?: number;
  /** which part carries the motor's own mass, placed at the joint (default: parent) */
  massOn?: "parent" | "child" | "none";
}

export interface MechJoint {
  id?: string;
  type: "revolute" | "hinge" | "prismatic" | "slider" | "fixed" | "ball";
  /** part id, or "world" */
  parent: string;
  child: string;
  /** joint point in assembly coordinates (mm) */
  anchor: Vec3;
  /** rotation axis (revolute) or slide direction (prismatic) */
  axis?: Vec3;
  /** degrees (revolute) or mm (prismatic), relative to the assembly pose */
  limits?: [number, number];
  motor?: MechMotor;
  /** let the two connected parts collide with each other (default false) */
  collide?: boolean;
}

export interface MechSpec {
  name?: string;
  /** seconds (default 6) */
  duration?: number;
  material?: string;
  infill?: number;
  parts: MechPart[];
  joints?: MechJoint[];
  environment?: {
    floor?: boolean;
    /** floor friction (default 0.7) */
    friction?: number;
    /** tilt the floor about the Y axis, degrees (hill climbing) */
    slope?: number;
    gravity?: number;
    /** fixed boxes to drive/walk over: {min, max} in mm */
    obstacles?: { min: Vec3; max: Vec3 }[];
    /** lower the assembly onto the floor at start (default: true unless a part is fixed) */
    settle?: boolean;
  };
  /** part whose motion is measured (default: heaviest free part) */
  track?: string;
}

// ----------------------------------------------------------------------------- motor presets

interface Preset { kind: "servo" | "motor" | "linear"; maxTorque: number; maxSpeed: number; mass: number; note: string }

/** Rounded datasheet values at typical voltage. maxTorque N·m (N for linear), maxSpeed °/s | rpm | mm/s, mass g. */
export const MOTOR_PRESETS: Record<string, Preset> = {
  SG90: { kind: "servo", maxTorque: 0.18, maxSpeed: 600, mass: 9, note: "micro servo, 1.8 kg·cm" },
  MG90S: { kind: "servo", maxTorque: 0.22, maxSpeed: 600, mass: 13.4, note: "metal-gear micro servo, 2.2 kg·cm" },
  MG996R: { kind: "servo", maxTorque: 0.94, maxSpeed: 430, mass: 55, note: "standard servo, 9.4 kg·cm" },
  DS3218: { kind: "servo", maxTorque: 1.9, maxSpeed: 430, mass: 60, note: "20 kg·cm digital servo" },
  STS3215: { kind: "servo", maxTorque: 1.9, maxSpeed: 270, mass: 55, note: "Feetech bus servo (robot arms), 19.5 kg·cm @7.4 V" },
  TT: { kind: "motor", maxTorque: 0.08, maxSpeed: 200, mass: 30, note: "yellow TT gearmotor 1:48, 6 V" },
  N20: { kind: "motor", maxTorque: 0.14, maxSpeed: 150, mass: 10, note: "N20 micro gearmotor 1:100, 6 V" },
  JGA25: { kind: "motor", maxTorque: 0.6, maxSpeed: 130, mass: 90, note: "JGA25-370 gearmotor, 12 V" },
  NEMA17: { kind: "motor", maxTorque: 0.4, maxSpeed: 600, mass: 280, note: "NEMA 17 stepper (velocity mode)" },
  LINEAR: { kind: "linear", maxTorque: 20, maxSpeed: 10, mass: 50, note: "mini linear actuator, 20 N, 10 mm/s" },
};

const NM = 1e9; // N·m → g·mm²/s²
const N = 1e6; // N → g·mm/s²

// ----------------------------------------------------------------------------- results

export interface MotorStats {
  joint: string;
  preset?: string;
  mode: "position" | "velocity";
  unit: "N·m" | "N";
  rated: number;
  peak: number;
  /** what the controller asked for before the limit — > rated means the motor is too weak */
  peakDemand: number;
  /** 95th-percentile torque/force — the load it carries most of the time, ignoring brief spikes */
  p95: number;
  /** share of the run the motor was at its limit */
  saturated: number;
  /** position mode: worst lag behind the commanded angle (after 0.3 s) */
  maxTrackingError?: number;
  maxSpeed: number;
  avgPowerW: number;
}

export type MechData = {
  name: string;
  duration: number;
  track: string;
  mobile: boolean;
  displacement: Vec3;
  distance: number;
  pathLength: number;
  speed: number;
  headingChange: number;
  maxTilt: number;
  finalTilt: number;
  fell: boolean;
  motors: MotorStats[];
  collisions: { a: string; b: string; firstAt: number; share: number }[];
  interference: { a: string; b: string; depth: number }[];
  limitHits: { joint: string; share: number }[];
  jointDrift: { joint: string; mm: number }[];
  /** travel of every hinge (°) / slider (mm) during the run */
  jointRanges: { joint: string; min: number; max: number; unit: string }[];
  masses: { id: string; grams: number; collider: string }[];
  path: [number, number, number][];
};

export interface MechFrames {
  times: number[];
  /** per body: [px,py,pz,qx,qy,qz,qw] × frames */
  bodies: { id: string; poses: number[] }[];
  /** per motor joint: [t, coordinate, torque] samples at frame rate */
  joints: { id: string; values: number[] }[];
}

export interface MechOutput {
  check: CheckResult<MechData>;
  /** mm the assembly was lowered/raised to rest on the floor (part meshes include it) */
  lift?: number;
  /** part meshes in assembly coordinates (as placed at t = 0) */
  parts: { id: string; mesh: Mesh; color: RGB; fixed: boolean }[];
  frames?: MechFrames;
}

const PALETTE: RGB[] = [[124, 140, 255], [245, 176, 65], [62, 207, 142], [255, 120, 120], [180, 130, 255], [90, 200, 230], [240, 220, 90], [230, 130, 200], [150, 200, 120], [200, 160, 120]];

function hexColor(s: string | undefined, i: number): RGB {
  const m = s && /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) { const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  return PALETTE[i % PALETTE.length];
}

// ----------------------------------------------------------------------------- build

/** A part's mesh in assembly coordinates: its file or primitive shape, rotated then moved. */
export function partMesh(p: Pick<MechPart, "id" | "file" | "shape" | "position" | "rotation">, resolve: (file: string) => Uint8Array): Mesh {
  let m: Mesh;
  if (p.shape && "box" in p.shape) { const [x, y, z] = p.shape.box; m = box(x, y, z, [-x / 2, -y / 2, -z / 2]); }
  else if (p.shape && "cylinder" in p.shape) {
    const { r, h, axis = "z" } = p.shape.cylinder;
    m = cylinder(r, h, 48, [0, 0, -h / 2]);
    if (axis === "x") m = rotateDeg(m, 0, 90, 0);
    if (axis === "y") m = rotateDeg(m, -90, 0, 0);
  } else if (p.shape && "sphere" in p.shape) m = uvSphere(p.shape.sphere.r, 16, 24);
  else if (p.file) {
    const f = loadFile(p.file, resolve(p.file));
    if (!f.mesh) throw new Error(`Part "${p.id}": ${p.file} has no 3D shape`);
    m = f.mesh;
  } else throw new Error(`Part "${p.id}" needs a "file" or a "shape"`);
  if (p.rotation?.some((a) => a)) m = rotateDeg(m, ...p.rotation);
  if (p.position) m = translate(m, p.position);
  return m;
}

function shapeRotation(p: MechPart): RAPIER.Rotation {
  const base = quatFromEulerDeg(...(p.rotation ?? [0, 0, 0]));
  if (p.shape && "cylinder" in p.shape) {
    // Rapier cylinders run along Y; turn Y onto the requested axis first
    const axis = p.shape.cylinder.axis ?? "z";
    const align = axis === "z" ? quatFromEulerDeg(90, 0, 0) : axis === "x" ? quatFromEulerDeg(0, 0, -90) : quatFromEulerDeg(0, 0, 0);
    return qmul(base, align);
  }
  return base;
}

function qmul(a: RAPIER.Rotation, b: RAPIER.Rotation): RAPIER.Rotation {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** Colliders for a part in assembly coordinates; returns how the shape was approximated. */
function addColliders(world: RAPIER.World, rb: RAPIER.RigidBody, p: MechPart, mesh: Mesh, friction: number): { colliders: RAPIER.Collider[]; kind: string } {
  const fr = (d: RAPIER.ColliderDesc) => d.setFriction(friction).setRestitution(0.15).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
  const pos = p.position ?? [0, 0, 0];
  if (p.shape) {
    let d: RAPIER.ColliderDesc;
    if ("box" in p.shape) d = RAPIER.ColliderDesc.cuboid(p.shape.box[0] / 2, p.shape.box[1] / 2, p.shape.box[2] / 2);
    else if ("cylinder" in p.shape) d = RAPIER.ColliderDesc.cylinder(p.shape.cylinder.h / 2, p.shape.cylinder.r);
    else d = RAPIER.ColliderDesc.ball(p.shape.sphere.r);
    d.setTranslation(pos[0], pos[1], pos[2]).setRotation(shapeRotation(p));
    return { colliders: [world.createCollider(fr(d), rb)], kind: "exact " + Object.keys(p.shape)[0] };
  }
  // meshes: convex hull when the part is (nearly) convex, else convex decomposition, else voxel boxes
  const vol = massProps(mesh).volume;
  const hullDesc = RAPIER.ColliderDesc.convexHull(mesh.positions);
  if (hullDesc) {
    const hull = world.createCollider(fr(hullDesc), rb);
    if (vol / Math.max(hull.volume(), 1e-9) > 0.9) return { colliders: [hull], kind: "convex hull" };
    world.removeCollider(hull, false);
  }
  if (triCount(mesh) <= 60000) {
    try {
      const dec = RAPIER.ColliderDesc.convexDecomposition(mesh.positions, mesh.indices, { resolution: 48, maxConvexHulls: 24, concavity: 0.01 });
      if (dec) return { colliders: [world.createCollider(fr(dec), rb)], kind: "convex decomposition" };
    } catch { /* fall through */ }
  }
  const b = bbox(mesh);
  const size = Math.max(0.8, Math.cbrt((b.size[0] * b.size[1] * b.size[2]) / 40000));
  const g = voxelize(mesh, size);
  const out: RAPIER.Collider[] = [];
  for (const [x0, y0, z0, x1, y1, z1] of greedyBoxes(g).slice(0, 600)) {
    const d = RAPIER.ColliderDesc.cuboid(((x1 - x0) * size) / 2, ((y1 - y0) * size) / 2, ((z1 - z0) * size) / 2)
      .setTranslation(g.origin[0] + ((x0 + x1) / 2) * size, g.origin[1] + ((y0 + y1) / 2) * size, g.origin[2] + ((z0 + z1) / 2) * size);
    out.push(world.createCollider(fr(d), rb));
  }
  return { colliders: out, kind: "voxel boxes" };
}

// ----------------------------------------------------------------------------- simulate

export async function simulateMechanism(spec: MechSpec, resolve: (file: string) => Uint8Array, opts: { record?: boolean; duration?: number } = {}): Promise<MechOutput> {
  await initPhysics();
  validate(spec);
  const duration = opts.duration ?? spec.duration ?? 6;
  const env = spec.environment ?? {};
  const anyFixed = spec.parts.some((p) => p.fixed) || (spec.joints ?? []).some((j) => j.parent === "world");

  // --- meshes + placement
  let meshes = spec.parts.map((p) => partMesh(p, resolve));
  let lift = 0;
  if (env.settle ?? !anyFixed) {
    let zmin = Infinity;
    for (const m of meshes) zmin = Math.min(zmin, bbox(m).min[2]);
    lift = 0.2 - zmin;
    meshes = meshes.map((m) => translate(m, [0, 0, lift]));
  }
  const joints = (spec.joints ?? []).map((j) => ({ ...j, anchor: [j.anchor[0], j.anchor[1], j.anchor[2] + lift] as Vec3 }));
  const partsShifted = spec.parts.map((p) => ({ ...p, position: [(p.position ?? [0, 0, 0])[0], (p.position ?? [0, 0, 0])[1], (p.position ?? [0, 0, 0])[2] + lift] as Vec3 }));

  // --- masses (printed mass + extra + motors)
  const grams = spec.parts.map((p, i) => {
    if (p.mass !== undefined) return p.mass;
    const part = new Part(meshes[i], { material: p.material ?? spec.material, settings: { infill: (p.infill ?? spec.infill ?? 15) / 100 } });
    return part.estimateGrams().grams + (p.extraMass ?? 0);
  });
  const idx = new Map(spec.parts.map((p, i) => [p.id, i]));
  // point masses: payloads + motors (sitting at their joint)
  const points: { part: number; mass: number; at: Vec3 }[] = [];
  spec.parts.forEach((p, i) => { for (const pl of p.payloads ?? []) points.push({ part: i, mass: pl.mass, at: [pl.at[0], pl.at[1], pl.at[2] + lift] }); });
  for (const j of joints) {
    const pr = j.motor?.preset ? MOTOR_PRESETS[j.motor.preset.toUpperCase()] : undefined;
    if (!pr) continue;
    const on = j.motor!.massOn ?? "parent";
    const target = on === "child" ? j.child : on === "parent" ? j.parent : null;
    if (target && target !== "world" && spec.parts[idx.get(target)!].mass === undefined) points.push({ part: idx.get(target)!, mass: pr.mass, at: j.anchor });
  }

  // --- world
  const g = env.gravity ?? 9.81;
  const world = new RAPIER.World({ x: 0, y: 0, z: -g * 1000 });
  world.lengthUnit = 1000;
  world.timestep = 1 / 1200;
  world.numSolverIterations = 8;
  const worldBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  if (env.floor !== false) {
    const slope = ((env.slope ?? 0) * Math.PI) / 180;
    const fb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setRotation({ x: 0, y: Math.sin(slope / 2), z: 0, w: Math.cos(slope / 2) }));
    world.createCollider(RAPIER.ColliderDesc.cuboid(20000, 20000, 50).setTranslation(0, 0, -50).setFriction(env.friction ?? 0.7), fb);
  }
  for (const o of env.obstacles ?? []) {
    const c = [0, 1, 2].map((k) => (o.min[k] + o.max[k]) / 2), h = [0, 1, 2].map((k) => Math.abs(o.max[k] - o.min[k]) / 2);
    world.createCollider(RAPIER.ColliderDesc.cuboid(h[0], h[1], h[2]).setTranslation(c[0], c[1], c[2]).setFriction(env.friction ?? 0.7), worldBody);
  }

  // --- bodies (frame = assembly frame at t = 0, so anchors/axes are the same in both bodies)
  const printedGrams = [...grams]; // before point masses are added
  const bodies: RAPIER.RigidBody[] = [];
  const colliderKinds: string[] = [];
  const colliderOwner = new Map<number, number>();
  partsShifted.forEach((p, i) => {
    const rb = world.createRigidBody((p.fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic()).setCanSleep(false));
    const mat = new Part(meshes[i], { material: p.material ?? spec.material }).material;
    const { colliders, kind } = addColliders(world, rb, p, meshes[i], p.friction ?? mat.friction);
    let vol = 0;
    for (const c of colliders) vol += c.volume();
    for (const c of colliders) { c.setDensity(grams[i] / Math.max(vol, 1e-9)); colliderOwner.set(c.handle, i); }
    for (const pm of points.filter((x) => x.part === i)) {
      // sensor: adds mass at the point but never collides
      world.createCollider(
        RAPIER.ColliderDesc.ball(1).setSensor(true).setTranslation(pm.at[0], pm.at[1], pm.at[2])
          .setMassProperties(pm.mass, { x: 0, y: 0, z: 0 }, { x: pm.mass * 20, y: pm.mass * 20, z: pm.mass * 20 }, { x: 0, y: 0, z: 0, w: 1 }),
        rb,
      );
      grams[i] += pm.mass;
    }
    colliderKinds.push(kind);
    bodies.push(rb);
  });

  // --- joints + motors
  interface Ctl {
    j: MechJoint; name: string; joint: RAPIER.UnitImpulseJoint; parent: RAPIER.RigidBody; child: RAPIER.RigidBody;
    axis: Vec3; rotary: boolean; mode: "position" | "velocity"; sig: (t: number) => number;
    maxT: number; maxV: number; k: number; c: number; vf: number; Ieff: number; dtNeed: number; eff: number; stats: MotorStats; power: number; hist: Uint32Array;
  }
  const ctls: Ctl[] = [];
  const sense: Record<string, number> = { t: 0, yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0, speed: 0 };
  const noCollide = new Set<string>();
  const limitCount = new Map<string, number>();
  const unitJoints: { name: string; joint: RAPIER.UnitImpulseJoint; lo: number; hi: number; rotary: boolean; parent: RAPIER.RigidBody; child: RAPIER.RigidBody; axis: Vec3 }[] = [];
  const allJoints: { name: string; parent: RAPIER.RigidBody; child: RAPIER.RigidBody; anchor: Vec3; slideAxis?: Vec3 }[] = [];
  const ranges = new Map<string, { min: number; max: number; rotary: boolean }>();
  const childrenOf = new Map<string, string[]>();
  for (const j of joints) childrenOf.set(j.parent, [...(childrenOf.get(j.parent) ?? []), j.child]);
  const subtree = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    return [id, ...(childrenOf.get(id) ?? []).flatMap((c) => subtree(c, seen))];
  };

  joints.forEach((j) => {
    const name = j.id ?? `${j.parent}→${j.child}`;
    const parent = j.parent === "world" ? worldBody : bodies[idx.get(j.parent)!];
    const child = bodies[idx.get(j.child)!];
    const a = { x: j.anchor[0], y: j.anchor[1], z: j.anchor[2] };
    const ax0 = j.axis ?? [0, 1, 0];
    const al = Math.hypot(...ax0) || 1;
    const axis: Vec3 = [ax0[0] / al, ax0[1] / al, ax0[2] / al];
    const av = { x: axis[0], y: axis[1], z: axis[2] };
    const type = j.type === "hinge" ? "revolute" : j.type === "slider" ? "prismatic" : j.type;
    const data =
      type === "revolute" ? RAPIER.JointData.revolute(a, a, av)
        : type === "prismatic" ? RAPIER.JointData.prismatic(a, a, av)
          : type === "ball" ? RAPIER.JointData.spherical(a, a)
            : RAPIER.JointData.fixed(a, { x: 0, y: 0, z: 0, w: 1 }, a, { x: 0, y: 0, z: 0, w: 1 });
    const joint = world.createImpulseJoint(data, parent, child, true);
    joint.setContactsEnabled(!!j.collide);
    if (!j.collide) noCollide.add(pairKey(j.parent === "world" ? -1 : idx.get(j.parent)!, idx.get(j.child)!));
    allJoints.push({ name, parent, child, anchor: j.anchor, slideAxis: type === "prismatic" ? axis : undefined });
    if (type !== "revolute" && type !== "prismatic") return;
    const rotary = type === "revolute";
    const uj = joint as RAPIER.UnitImpulseJoint;
    const toInternal = (v: number) => (rotary ? (v * Math.PI) / 180 : v);
    if (j.limits) {
      uj.setLimits(toInternal(j.limits[0]), toInternal(j.limits[1]));
      limitCount.set(name, 0);
    }
    unitJoints.push({ name, joint: uj, lo: j.limits ? toInternal(j.limits[0]) : -Infinity, hi: j.limits ? toInternal(j.limits[1]) : Infinity, rotary, parent, child, axis });
    if (!j.motor) return;
    const m = j.motor;
    const pr = m.preset ? MOTOR_PRESETS[m.preset.toUpperCase()] : undefined;
    if (m.preset && !pr) throw new Error(`Unknown motor preset "${m.preset}". Known: ${Object.keys(MOTOR_PRESETS).join(", ")}`);
    const mode = m.mode ?? (pr?.kind === "motor" ? "velocity" : "position");
    const maxTorque = m.maxTorque ?? pr?.maxTorque ?? (rotary ? 0.5 : 20);
    const maxSpeed = m.maxSpeed ?? pr?.maxSpeed ?? (rotary ? (mode === "velocity" ? 200 : 400) : 20);
    const maxT = maxTorque * (rotary ? NM : N);
    // max speed in internal units: rad/s or mm/s
    const maxV = rotary ? (mode === "velocity" ? (maxSpeed * 2 * Math.PI) / 60 : (maxSpeed * Math.PI) / 180) : maxSpeed;
    // moment of inertia of everything the joint moves, about the joint (g·mm²)
    const inertiaOf = (ids: string[]) => {
      let I = 0;
      for (const id of ids) {
        const i = idx.get(id)!;
        const mb = bbox(meshes[i]);
        const c = massProps(meshes[i]).centerOfMass;
        const r2 = rotary ? distToAxisSq(c, j.anchor, axis) : 0;
        const L2 = mb.size[0] ** 2 + mb.size[1] ** 2 + mb.size[2] ** 2;
        I += printedGrams[i] * (rotary ? r2 + L2 / 12 : 1);
      }
      for (const pm of points) if (ids.includes(spec.parts[pm.part].id)) I += pm.mass * (rotary ? distToAxisSq(pm.at, j.anchor, axis) + 25 : 1);
      return I;
    };
    const Ichild = inertiaOf(subtree(j.child));
    // a motor between two free parts pushes both: what matters is the reduced inertia
    const parentFree = j.parent !== "world" && !spec.parts[idx.get(j.parent)!].fixed;
    const Iparent = parentFree ? inertiaOf([j.parent]) : Infinity;
    // The controller applies explicit torques (so we know exactly what the motor delivers).
    // Servo: full torque at ~4° (2 mm) of error, critically damped. Gains are capped so the
    // explicit integration stays stable for very light links (ωn·dt ≤ 0.5).
    // Gearbox: a geared motor's rotor inertia, seen through the gear ratio, dwarfs a light printed
    // link. Estimate it from the motor's ability to reach full speed in ~30 ms and add it to the
    // child about the joint axis (inertia only — tiny mass, so gravity is unaffected).
    let armature = 0;
    if (rotary) {
      const wMax = mode === "velocity" ? maxV : Math.max(maxV, 1);
      armature = (maxT * 0.03) / wMax;
      const q = arcQuat([1, 0, 0], axis);
      world.createCollider(
        RAPIER.ColliderDesc.ball(0.5).setSensor(true).setTranslation(j.anchor[0], j.anchor[1], j.anchor[2])
          .setMassProperties(0.01, { x: 0, y: 0, z: 0 }, { x: armature, y: armature * 1e-3, z: armature * 1e-3 }, q),
        child,
      );
    }
    const Ieff = Math.max(isFinite(Iparent) ? ((Ichild + armature) * Iparent) / (Ichild + armature + Iparent) : Ichild + armature, 1e-3);
    // ideal gains: servo reaches full torque at ~4° (2 mm) error; DC motor follows its torque–speed line
    const k0 = maxT / (rotary ? (4 * Math.PI) / 180 : 2);
    const vf0 = maxT / maxV;
    // largest stable explicit step for this joint (ωn·dt ≤ 0.5, damping·dt/I ≤ 0.5)
    const dtNeed = mode === "position" ? 0.5 / Math.sqrt(k0 / Ieff) : (0.5 * Ieff) / vf0;
    ctls.push({
      j, name, joint: uj, parent, child, axis, rotary, mode, sig: compileSignal(m.target, sense),
      maxT, maxV, k: k0, c: 0, vf: vf0, Ieff, dtNeed, eff: 0,
      stats: { joint: name, preset: m.preset?.toUpperCase(), mode, unit: rotary ? "N·m" : "N", rated: maxTorque, peak: 0, peakDemand: 0, p95: 0, saturated: 0, maxSpeed: 0, avgPowerW: 0, ...(mode === "position" ? { maxTrackingError: 0 } : {}) },
      power: 0,
      hist: new Uint32Array(51),
    });
  });

  // --- joint coordinate helpers
  const coord = (c: { parent: RAPIER.RigidBody; child: RAPIER.RigidBody; axis: Vec3; rotary: boolean; anchor?: Vec3 }, anchor: Vec3): { pos: number; vel: number } => {
    const qp = c.parent.rotation(), qc = c.child.rotation();
    const aw = rotate(qp, c.axis);
    if (c.rotary) {
      // twist of child relative to parent about the joint axis
      const qr = qmul(conj(qp), qc);
      const ang = 2 * Math.atan2(qr.x * c.axis[0] + qr.y * c.axis[1] + qr.z * c.axis[2], qr.w);
      const wp = c.parent.angvel(), wc = c.child.angvel();
      return { pos: wrap(ang), vel: (wc.x - wp.x) * aw[0] + (wc.y - wp.y) * aw[1] + (wc.z - wp.z) * aw[2] };
    }
    const pa = worldPoint(c.parent, anchor), ca = worldPoint(c.child, anchor);
    const va = pointVel(c.parent, pa), vc = pointVel(c.child, ca);
    return {
      pos: (ca[0] - pa[0]) * aw[0] + (ca[1] - pa[1]) * aw[1] + (ca[2] - pa[2]) * aw[2],
      vel: (vc[0] - va[0]) * aw[0] + (vc[1] - va[1]) * aw[1] + (vc[2] - va[2]) * aw[2],
    };
  };

  const applyDrive = (c: Ctl, torque: number) => {
    const aw = rotate(c.parent.rotation(), c.axis);
    if (c.rotary) {
      c.child.addTorque({ x: aw[0] * torque, y: aw[1] * torque, z: aw[2] * torque }, true);
      if (c.parent.isDynamic()) c.parent.addTorque({ x: -aw[0] * torque, y: -aw[1] * torque, z: -aw[2] * torque }, true);
    } else {
      const pc = worldPoint(c.child, c.j.anchor), pp = worldPoint(c.parent, c.j.anchor);
      c.child.addForceAtPoint({ x: aw[0] * torque, y: aw[1] * torque, z: aw[2] * torque }, { x: pc[0], y: pc[1], z: pc[2] }, true);
      if (c.parent.isDynamic()) c.parent.addForceAtPoint({ x: -aw[0] * torque, y: -aw[1] * torque, z: -aw[2] * torque }, { x: pp[0], y: pp[1], z: pp[2] }, true);
    }
  };

  // --- time step: small enough for the stiffest motor, then final gains for that step
  world.timestep = clamp(Math.min(1 / 1000, ...ctls.map((c) => c.dtNeed)), 1 / 6000, 1 / 1000);
  for (const c of ctls) {
    const h = world.timestep;
    c.k = Math.min(c.k, c.Ieff * (0.5 / h) ** 2);
    c.c = Math.min(2 * Math.sqrt(c.k * c.Ieff), (0.5 * c.Ieff) / h);
    c.vf = Math.min(c.vf, (0.5 * c.Ieff) / h);
  }

  // --- run
  const dt = world.timestep;
  const steps = Math.round(duration / dt);
  const frameEvery = Math.max(1, Math.round(1 / 60 / dt)); // ~60 fps
  const contactEvery = Math.max(1, Math.round(1 / 30 / dt));
  const trackId = spec.track ?? spec.parts.filter((p) => !p.fixed).reduce((a, p) => (grams[idx.get(p.id)!] > grams[idx.get(a.id)!] ? p : a), spec.parts.find((p) => !p.fixed) ?? spec.parts[0]).id;
  const tb = bodies[idx.get(trackId)!];
  const startCom = vec(tb.worldCom());
  const startHeading = heading(tb.rotation());
  const path: [number, number, number][] = [];
  let pathLength = 0, prev = startCom, maxTilt = 0;
  const frames: MechFrames | undefined = opts.record ? { times: [], bodies: spec.parts.map((p) => ({ id: p.id, poses: [] })), joints: ctls.map((c) => ({ id: c.name, values: [] })) } : undefined;
  const collide = new Map<string, { first: number; count: number }>();
  const interference: MechData["interference"] = [];
  let checks = 0, exploded = false;
  const drift = new Map<string, number>();

  for (let s = 0; s <= steps; s++) {
    const t = s * dt;
    for (const b of bodies) { b.resetForces(false); b.resetTorques(false); }
    {
      // live sensor values of the tracked part, for closed-loop motion programs
      const q = tb.rotation(), c = tb.worldCom(), v = tb.linvel();
      const e = eulerZYX(q);
      sense.yaw = angDiff(e[2], startHeading); sense.pitch = e[1]; sense.roll = e[0];
      sense.x = c.x; sense.y = c.y; sense.z = c.z; sense.speed = Math.hypot(v.x, v.y);
    }
    for (const c of ctls) {
      const cur = coord(c, c.j.anchor);
      const raw = c.sig(t);
      let torque: number, demand: number;
      if (c.mode === "position") {
        const want = c.rotary ? (raw * Math.PI) / 180 : raw;
        // real servos slew at a limited speed towards the command
        const stepMax = c.maxV * dt;
        const prevEff = s === 0 ? cur.pos : c.eff;
        c.eff = prevEff + clamp(want - prevEff, -stepMax, stepMax);
        const effVel = s === 0 ? 0 : (c.eff - prevEff) / dt;
        // PD on the error, with the commanded speed fed forward (damps the *error* rate, not all motion)
        demand = c.k * (c.eff - cur.pos) + c.c * (effVel - cur.vel);
        if (t > 0.3) c.stats.maxTrackingError = Math.max(c.stats.maxTrackingError!, Math.abs(want - cur.pos));
      } else {
        const want = clamp(c.rotary ? (raw * 2 * Math.PI) / 60 : raw, -c.maxV, c.maxV);
        demand = c.vf * (want - cur.vel);
      }
      torque = clamp(demand, -c.maxT, c.maxT);
      applyDrive(c, torque);
      c.stats.peak = Math.max(c.stats.peak, Math.abs(torque));
      c.stats.peakDemand = Math.max(c.stats.peakDemand, Math.abs(demand));
      c.hist[Math.min(50, Math.floor((Math.abs(torque) / c.maxT) * 50))]++;
      if (Math.abs(demand) >= c.maxT * 0.98) c.stats.saturated++;
      c.stats.maxSpeed = Math.max(c.stats.maxSpeed, Math.abs(cur.vel));
      c.power += Math.abs(torque * cur.vel);
      if (frames && s % frameEvery === 0) frames.joints[ctls.indexOf(c)].values.push(r2(t), r2(c.rotary ? (cur.pos * 180) / Math.PI : cur.pos), +(torque / c.maxT).toFixed(3));
    }
    world.step();

    const com = vec(tb.worldCom());
    if (!isFinite(com[0]) || Math.hypot(...vec(tb.linvel())) > 50000) { exploded = true; break; }
    const up = rotate(tb.rotation(), [0, 0, 1]);
    maxTilt = Math.max(maxTilt, (Math.acos(clamp(up[2], -1, 1)) * 180) / Math.PI);
    if (s % frameEvery === 0) {
      pathLength += Math.hypot(com[0] - prev[0], com[1] - prev[1]);
      prev = com;
      path.push([r1(com[0]), r1(com[1]), r1(com[2])]);
      if (frames) {
        frames.times.push(r2(t));
        bodies.forEach((b, i) => {
          const p = b.translation(), q = b.rotation();
          frames.bodies[i].poses.push(r2(p.x), r2(p.y), r2(p.z), +q.x.toFixed(5), +q.y.toFixed(5), +q.z.toFixed(5), +q.w.toFixed(5));
        });
      }
      for (const u of unitJoints) {
        const cur = coord(u, joints.find((j) => (j.id ?? `${j.parent}→${j.child}`) === u.name)!.anchor);
        const tol = u.rotary ? (1 * Math.PI) / 180 : 0.5;
        if (limitCount.has(u.name) && (cur.pos <= u.lo + tol || cur.pos >= u.hi - tol)) limitCount.set(u.name, limitCount.get(u.name)! + 1);
        const rg = ranges.get(u.name) ?? { min: Infinity, max: -Infinity, rotary: u.rotary };
        rg.min = Math.min(rg.min, cur.pos); rg.max = Math.max(rg.max, cur.pos);
        ranges.set(u.name, rg);
      }
      for (const jn of allJoints) {
        let d = sub(worldPoint(jn.parent, jn.anchor), worldPoint(jn.child, jn.anchor));
        if (jn.slideAxis) {
          // sliders are meant to move along their axis: only sideways separation is an error
          const a = rotate(jn.parent.rotation(), jn.slideAxis);
          const along = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
          d = [d[0] - along * a[0], d[1] - along * a[1], d[2] - along * a[2]];
        }
        drift.set(jn.name, Math.max(drift.get(jn.name) ?? 0, Math.hypot(...d)));
      }
    }
    // contacts between parts (not the floor) — 30 Hz is enough
    if (s % contactEvery === 1) {
      checks++;
      const seen = new Set<string>();
      world.forEachCollider((c1) => {
        const i1 = colliderOwner.get(c1.handle);
        if (i1 === undefined) return;
        world.contactPairsWith(c1, (c2) => {
          const i2 = colliderOwner.get(c2.handle);
          if (i2 === undefined || i2 === i1) return;
          const key = pairKey(i1, i2);
          if (noCollide.has(key) || seen.has(key)) return;
          let depth = Infinity;
          world.contactPair(c1, c2, (man) => { for (let k = 0; k < man.numContacts(); k++) depth = Math.min(depth, man.contactDist(k)); });
          if (depth > 0.05) return;
          seen.add(key);
          if (s === 1 && depth < -0.3) interference.push({ a: spec.parts[Math.min(i1, i2)].id, b: spec.parts[Math.max(i1, i2)].id, depth: r2(-depth) });
          const e = collide.get(key);
          if (e) e.count++; else collide.set(key, { first: t, count: 1 });
        });
      });
    }
  }
  const ranSteps = exploded ? 1 : steps + 1;
  const endQ = tb.rotation();
  const endHeading = heading(endQ);
  const finalUp = rotate(endQ, [0, 0, 1]);
  world.free();

  // --- metrics
  const endCom = path[path.length - 1] ?? startCom;
  const disp: Vec3 = [endCom[0] - startCom[0], endCom[1] - startCom[1], endCom[2] - startCom[2]];
  const distance = Math.hypot(disp[0], disp[1]);
  const finalTilt = (Math.acos(clamp(finalUp[2], -1, 1)) * 180) / Math.PI;
  const mobile = !anyFixed;
  const fell = mobile && (finalTilt > 45 || maxTilt > 70);
  for (const c of ctls) {
    c.stats.saturated = r2(c.stats.saturated / ranSteps);
    const scale = c.rotary ? NM : N;
    c.stats.peak = r2(c.stats.peak / scale);
    c.stats.peakDemand = r2(c.stats.peakDemand / scale);
    let acc = 0, total = 0;
    for (const h of c.hist) total += h;
    for (let b = 0; b < 51; b++) { acc += c.hist[b]; if (acc >= total * 0.95) { c.stats.p95 = r2(((b + 1) / 50) * c.stats.rated); break; } }
    if (c.stats.maxTrackingError !== undefined) c.stats.maxTrackingError = r1(c.rotary ? (c.stats.maxTrackingError * 180) / Math.PI : c.stats.maxTrackingError);
    c.stats.maxSpeed = r1(c.rotary ? (c.mode === "velocity" ? (c.stats.maxSpeed * 60) / (2 * Math.PI) : (c.stats.maxSpeed * 180) / Math.PI) : c.stats.maxSpeed);
    // g·mm²/s³ → W
    c.stats.avgPowerW = +((c.power / ranSteps) / (c.rotary ? 1e9 : 1e9)).toFixed(3);
  }
  const collisions = [...collide.entries()].map(([k, v]) => {
    const [a, b] = k.split("|").map(Number);
    return { a: spec.parts[a].id, b: spec.parts[b].id, firstAt: r2(v.first), share: r2(v.count / Math.max(checks, 1)) };
  }).filter((c) => !interference.some((x) => (x.a === c.a && x.b === c.b) || (x.a === c.b && x.b === c.a)));
  const limitHits = [...limitCount.entries()].map(([joint, n]) => ({ joint, share: r2(n / Math.max(path.length, 1)) })).filter((l) => l.share > 0);
  const jointRanges = [...ranges.entries()].map(([joint, r]) => ({
    joint,
    min: r1(r.rotary ? (r.min * 180) / Math.PI : r.min),
    max: r1(r.rotary ? (r.max * 180) / Math.PI : r.max),
    unit: r.rotary ? "°" : "mm",
  }));
  const jointDrift = [...drift.entries()].map(([joint, mm]) => ({ joint, mm: r2(mm) })).filter((d) => d.mm > 1);

  // --- findings
  const findings: Finding[] = [];
  const statuses: Status[] = [];
  const push = (status: Status, message: string) => { statuses.push(status); findings.push({ status, message }); };
  if (exploded) push("fail", "The simulation became unstable (parts flew apart). Check that joint anchors sit inside both parts and that motors aren't absurdly strong for very light parts.");
  for (const x of interference) push("fail", `"${x.a}" and "${x.b}" overlap by ${x.depth} mm in the starting pose — the printed parts would not fit together. Add clearance (≥ 0.3 mm) or connect them with a joint.`);
  if (mobile) {
    const dirWord = distance < 5 ? "barely moves" : `moves ${r1(distance)} mm (${r1(disp[0])} in X, ${r1(disp[1])} in Y)`;
    push(fell ? "fail" : "info", `${trackId} ${dirWord} in ${duration} s — ${r1(distance / duration)} mm/s; ${fell ? `FALLS OVER (max tilt ${r1(maxTilt)}°)` : `stays upright (max tilt ${r1(maxTilt)}°)`}; heading changed ${r1(angDiff(endHeading, startHeading))}°.`);
  }
  if (mobile && ctls.length && !fell && distance > 20 && Math.abs(angDiff(endHeading, startHeading)) > 20) {
    push("warn", `Veers off course: heading changed ${r1(angDiff(endHeading, startHeading))}° while moving — left and right sides don't push equally (uneven weight, grip or timing).`);
  }
  if (!mobile) {
    const moving = jointRanges.filter((r) => r.max - r.min > (r.unit === "°" ? 2 : 1));
    if (moving.length) push("info", `Range of motion: ${moving.map((r) => r.unit === "°" && r.max - r.min > 350 ? `${r.joint} full turns` : `${r.joint} ${r.min}…${r.max} ${r.unit} (${r1(r.max - r.min)} ${r.unit})`).join("; ")}.`);
    else if (ctls.length) push("warn", "Nothing moves: the mechanism is jammed or the motors can't overcome the load.");
  }
  for (const m of ctls.map((c) => c.stats)) {
    const name = `${m.joint}${m.preset ? ` (${m.preset})` : ""}`;
    if (m.saturated > 0.25 || ((m.maxTrackingError ?? 0) > 20 && m.saturated > 0.05)) {
      push("fail", `Motor ${name} is too weak: at its limit ${Math.round(m.saturated * 100)}% of the time${m.maxTrackingError !== undefined ? `, lags up to ${m.maxTrackingError}${m.unit === "N" ? " mm" : "°"} behind` : ""}. It wanted ${m.peakDemand} ${m.unit} (rated ${m.rated}). Use a stronger motor, lighter/shorter parts, or slower motion.`);
    } else if (m.saturated > 0.05 || m.p95 > m.rated * 0.7) {
      push("warn", `Motor ${name} runs close to its limit (typically ${m.p95}, peak ${m.peak} of ${m.rated} ${m.unit}; at the limit ${Math.round(m.saturated * 100)}% of the time${m.maxTrackingError !== undefined ? `, lags up to ${m.maxTrackingError}${m.unit === "N" ? " mm" : "°"}` : ""}) — little margin for friction, wear and battery sag.`);
    } else {
      push("pass", `Motor ${name}: typically ${m.p95}, peak ${m.peak} of ${m.rated} ${m.unit}${m.maxTrackingError !== undefined ? `, follows within ${m.maxTrackingError}${m.unit === "N" ? " mm" : "°"}` : ""}.`);
    }
  }
  for (const c of collisions) push(c.share > 0.02 ? "warn" : "info", `"${c.a}" hits "${c.b}" (first at ${c.firstAt} s, ${Math.round(c.share * 100)}% of the time) — parts collide during motion.`);
  for (const l of limitHits) if (l.share > 0.1) push("warn", `Joint ${l.joint} sits on its end stop ${Math.round(l.share * 100)}% of the time — the motion asks for more travel than the limits allow.`);
  for (const d of jointDrift) if (d.mm > 3) push("warn", `Joint ${d.joint} was pulled ${d.mm} mm apart at peak load — results near that joint are less reliable (very light part on a heavy one?).`);

  const status = worst(statuses.length ? statuses : ["pass"]);
  const fixes: string[] = [];
  if (ctls.some((c) => c.stats.saturated > 0.25)) fixes.push("Pick a stronger preset (SG90 → MG90S → MG996R), shorten the lever arm, make moving parts lighter (lower infill, hollow), or reduce the motion amplitude/frequency.");
  if (fell) fixes.push("Widen the stance or lower the body; for walkers keep at least 3 feet on the ground (slower gait) or shift weight over the support feet.");
  if (interference.length) fixes.push("Leave 0.3–0.5 mm clearance between separate printed parts (0.2 mm for tight press fits).");
  if (collisions.some((c) => c.share > 0.02)) fixes.push("Change the phase between joints or add clearance so parts don't swing into each other.");
  if (mobile && distance < 5 && !fell && ctls.length) fixes.push("It doesn't travel: add grip (TPU feet/tyres, friction 0.9), make the power stroke longer than the return stroke, or lift feet during the return swing.");

  const data: MechData = {
    name: spec.name ?? "mechanism",
    duration,
    track: trackId,
    mobile,
    displacement: disp.map(r1) as Vec3,
    distance: r1(distance),
    pathLength: r1(pathLength),
    speed: r1(distance / duration),
    headingChange: r1(angDiff(endHeading, startHeading)),
    maxTilt: r1(maxTilt),
    finalTilt: r1(finalTilt),
    fell,
    motors: ctls.map((c) => c.stats),
    collisions,
    interference,
    limitHits,
    jointDrift,
    jointRanges,
    masses: spec.parts.map((p, i) => ({ id: p.id, grams: r1(grams[i]), collider: colliderKinds[i] })),
    path: path.filter((_, i) => i % 6 === 0),
  };
  const headline = exploded ? "Simulation unstable." : !ctls.length ? `Passive assembly: ${fell ? "falls over" : `settles, max tilt ${r1(maxTilt)}°`}${interference.length ? " — parts overlap" : ""}.` : mobile
    ? `${fell ? "Falls over" : distance < 5 ? "Doesn't travel" : `Travels ${r1(distance)} mm at ${r1(distance / duration)} mm/s`}${ctls.some((c) => c.stats.saturated > 0.25) ? "; motor(s) too weak" : ""}.`
    : `${ctls.length} motor(s) over ${duration} s${ctls.some((c) => c.stats.saturated > 0.25) ? " — motor(s) too weak" : ""}${interference.length ? " — parts overlap" : ""}${collisions.some((c) => c.share > 0.02) ? " — parts collide" : ""}.`;
  return {
    check: { id: "mechanism", title: `Mechanism: ${data.name}`, status, summary: headline, accuracy: "simulated", findings, fixes, data },
    parts: spec.parts.map((p, i) => ({ id: p.id, mesh: meshes[i], color: hexColor(p.color, i), fixed: !!p.fixed })),
    frames,
    lift,
  };
}

// ----------------------------------------------------------------------------- filmstrip

export function renderMechanism(out: MechOutput, count = 6): Uint8Array {
  const f = out.frames;
  if (!f || !f.times.length) throw new Error("renderMechanism needs a run with record: true");
  const n = f.times.length;
  const picks = Array.from({ length: count }, (_, k) => Math.min(n - 1, Math.round((k / (count - 1)) * (n - 1))));
  // one camera for all frames: bounds of every pose
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const posed = (fi: number) => out.parts.map((p, i) => {
    const o = f.bodies[i].poses.slice(fi * 7, fi * 7 + 7);
    return poseMesh(p.mesh, [o[3], o[4], o[5], o[6]], [o[0], o[1], o[2]]);
  });
  for (const fi of picks) for (const m of posed(fi)) {
    const b = bbox(m);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.min[k]); hi[k] = Math.max(hi[k], b.max[k]); }
  }
  lo[2] = Math.min(lo[2], 0);
  const d = out.check.data;
  // path of the tracked part up to each frame (where it has been, not where it will go)
  const trailTo = (fi: number) => {
    if (!d.mobile) return [];
    const ti0 = out.parts.findIndex((p) => p.id === d.track);
    const pts: Vec3[] = [];
    for (let k = 0; k <= fi; k += 3) { const o = f.bodies[ti0].poses.slice(k * 7, k * 7 + 3); pts.push([o[0], o[1], 0.1]); }
    return pts.length > 1 ? [{ points: pts, color: [124, 140, 255] as RGB, width: 2 }] : [];
  };
  // a robot that travels far: follow it with a constant zoom instead of framing the whole trip
  const size0 = out.parts.map((p) => bbox(p.mesh)).reduce((m, b) => Math.max(m, b.size[0], b.size[1], b.size[2]), 0);
  const follow = d.mobile && d.distance > size0 * 1.5;
  const ti = out.parts.findIndex((p) => p.id === d.track);
  const fitFor = (fi: number) => {
    if (!follow) return { min: lo, max: hi };
    const o = f.bodies[ti].poses.slice(fi * 7, fi * 7 + 3);
    const h = size0 * 1.1;
    return { min: [o[0] - h, o[1] - h, 0] as Vec3, max: [o[0] + h, o[1] + h, Math.max(hi[2], h)] as Vec3 };
  };
  const scenes = picks.map((fi) => {
    const ms = posed(fi);
    const colors: number[] = [];
    ms.forEach((m, i) => { for (let t = 0; t < triCount(m); t++) colors.push(...out.parts[i].color); });
    return { mesh: mergeMeshes(ms), faceColors: new Uint8Array(colors), label: `T = ${f.times[fi].toFixed(1)} S`, lines: trailTo(fi), fit: fitFor(fi) };
  });
  return renderScenes(scenes, {
    fit: { min: lo, max: hi },
    groundZ: 0,
    cols: 3,
    title: `${out.check.status.toUpperCase()} - ${out.check.summary}`.slice(0, 90),
    legend: out.parts.slice(0, 9).map((p) => ({ color: p.color, label: p.id })),
  }).png;
}

// ----------------------------------------------------------------------------- helpers

function validate(spec: MechSpec) {
  if (!spec || !Array.isArray(spec.parts) || !spec.parts.length) throw new Error("Mechanism needs a non-empty `parts` list");
  const ids = new Set<string>();
  for (const p of spec.parts) {
    if (!p.id) throw new Error("Every part needs an `id`");
    if (ids.has(p.id)) throw new Error(`Duplicate part id "${p.id}"`);
    if (p.id === "world") throw new Error(`"world" is reserved`);
    ids.add(p.id);
  }
  for (const j of spec.joints ?? []) {
    if (j.parent !== "world" && !ids.has(j.parent)) throw new Error(`Joint parent "${j.parent}" is not a part`);
    if (!ids.has(j.child)) throw new Error(`Joint child "${j.child}" is not a part`);
    if (!Array.isArray(j.anchor) || j.anchor.length !== 3) throw new Error(`Joint ${j.id ?? j.child} needs anchor [x,y,z]`);
    if (!["revolute", "hinge", "prismatic", "slider", "fixed", "ball"].includes(j.type)) throw new Error(`Joint ${j.id ?? j.child}: unknown type "${j.type}"`);
    if (j.motor && !["revolute", "hinge", "prismatic", "slider"].includes(j.type)) throw new Error(`Joint ${j.id ?? j.child}: only revolute/prismatic joints can have motors`);
  }
}

/** shortest-arc rotation taking unit vector a to unit vector b */
function arcQuat(a: Vec3, b: Vec3): RAPIER.Rotation {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) return { x: 0, y: 0, z: 1, w: 0 }; // 180° about Z (a is X here)
  const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const w = 1 + d, l = Math.hypot(c[0], c[1], c[2], w);
  return { x: c[0] / l, y: c[1] / l, z: c[2] / l, w: w / l };
}

const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const vec = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** roll (X), pitch (Y), yaw (Z) in degrees */
function eulerZYX(q: RAPIER.Rotation): Vec3 {
  const { x, y, z, w } = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(clamp(2 * (w * y - z * x), -1, 1));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [(roll * 180) / Math.PI, (pitch * 180) / Math.PI, (yaw * 180) / Math.PI];
}
const heading = (q: RAPIER.Rotation) => { const f = rotate(q, [1, 0, 0]); return (Math.atan2(f[1], f[0]) * 180) / Math.PI; };
const angDiff = (a: number, b: number) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

function worldPoint(b: RAPIER.RigidBody, local: Vec3): Vec3 {
  const t = b.translation();
  const r = rotate(b.rotation(), local);
  return [r[0] + t.x, r[1] + t.y, r[2] + t.z];
}
function pointVel(b: RAPIER.RigidBody, p: Vec3): Vec3 {
  const v = b.linvel(), w = b.angvel(), c = b.worldCom();
  const r = [p[0] - c.x, p[1] - c.y, p[2] - c.z];
  return [v.x + w.y * r[2] - w.z * r[1], v.y + w.z * r[0] - w.x * r[2], v.z + w.x * r[1] - w.y * r[0]];
}
function distToAxisSq(p: Vec3, a: Vec3, axis: Vec3): number {
  const d = sub(p, a);
  const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
  return d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - along * along;
}
