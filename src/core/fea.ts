// Linear-elastic finite element analysis on the voxel grid (8-node hexahedra, matrix-free PCG).
// Stiffness is isotropic; strength is checked separately along layers (XY) and across layers (Z),
// because FDM parts are much weaker when pulled apart between layers.
import type { Part } from "./context.js";
import { type VoxelGrid, voxelize, vIndex, countSolid } from "./voxel.js";
import { type CheckResult, type Finding, r2, r3 } from "./report.js";
import { multigrid } from "./mg.js";

export type Region =
  | { face: "bottom" | "top" | "-x" | "+x" | "-y" | "+y"; depth?: number }
  | { box: { min: [number, number, number]; max: [number, number, number] } }
  | { sphere: { center: [number, number, number]; radius: number } }
  /** box as fractions of the part's bounding box: [0,0,0] = min corner, [1,1,1] = max corner */
  | { rel: { min: [number, number, number]; max: [number, number, number] } };

export interface LoadCase {
  /** where the part is held (glued, screwed, clamped) */
  fixed: Region[];
  /** forces in newtons, spread evenly over the region */
  loads: { region: Region; force: [number, number, number] }[];
  /** body acceleration in g (e.g. [0,0,-1] = own weight, [0,0,-50] ≈ hard drop impact) */
  acceleration?: [number, number, number];
  /**
   * Prescribed motion in mm: push a region by a set distance instead of a guessed force — the right
   * way to test a snap, detent or clip, which always travels the same distance whatever it costs.
   * Only the axes with a non-zero component are held; the others stay free (a ramp pushes one way).
   * The report gives the force it takes (reaction) and the safety factor at that travel.
   */
  displacements?: { region: Region; move: [number, number, number] }[];
}

export interface FeaOptions {
  /** target number of solid elements (speed vs accuracy); default 25k */
  elements?: number;
  /**
   * Element size in mm, instead of `elements`. Pin it to compare builds of a design: at a sharp inside
   * corner the peak stress grows as elements shrink, so the same count on a slightly different part
   * (a different element size) gives a different safety factor there.
   */
  elementSize?: number;
  /**
   * The grid is refined past `elements` when it misses too much of the part (walls thinner than an
   * element), up to this many elements. Default max(elements, 60k).
   */
  maxElements?: number;
  maxIterations?: number;
  tolerance?: number;
  /** "multigrid" (default) converges in tens of iterations; "jacobi" is the simple fallback */
  preconditioner?: "multigrid" | "jacobi";
}

export interface FeaResult {
  grid: VoxelGrid;
  /** element index (voxel index) for each solved element */
  elements: Int32Array;
  vonMises: Float32Array;
  /** stress pulling layers apart (normal + ½·interlayer shear), MPa */
  sigmaZ: Float32Array;
  safety: Float32Array;
  maxDisplacement: number;
  maxDisplacementAt: [number, number, number];
  iterations: number;
  converged: boolean;
  /** final relative residual |f − Ku| / |f| */
  residual: number;
  /** share of the part's volume the element grid holds (≈ 1 when every wall is resolved) */
  captured: number;
  /** average displacement of the part's material (mm): how far its centre of mass moves under the load */
  meanDisplacement: [number, number, number];
  droppedElements: number;
  /** force needed for each prescribed displacement, N (x, y, z) */
  reactions: { move: [number, number, number]; force: [number, number, number]; nodes: number }[];
}

// ---------- unit-cube element matrices ----------

const XI = [-1, 1, 1, -1, -1, 1, 1, -1];
const ETA = [-1, -1, 1, 1, -1, -1, 1, 1];
const ZETA = [-1, -1, -1, -1, 1, 1, 1, 1];
const G = 1 / Math.sqrt(3);
const GAUSS: [number, number, number][] = [];
for (const a of [-G, G]) for (const b of [-G, G]) for (const c of [-G, G]) GAUSS.push([a, b, c]);

/** strain-displacement matrix (6×24) for a cube with edge 1 at natural point (ξ,η,ζ) */
function Bmatrix(xi: number, eta: number, zeta: number): Float64Array {
  const B = new Float64Array(6 * 24);
  for (let i = 0; i < 8; i++) {
    // dN/dx = dN/dξ · 2/h with h = 1
    const dx = (XI[i] * (1 + ETA[i] * eta) * (1 + ZETA[i] * zeta)) / 8 * 2;
    const dy = (ETA[i] * (1 + XI[i] * xi) * (1 + ZETA[i] * zeta)) / 8 * 2;
    const dz = (ZETA[i] * (1 + XI[i] * xi) * (1 + ETA[i] * eta)) / 8 * 2;
    const c = i * 3;
    B[0 * 24 + c] = dx;
    B[1 * 24 + c + 1] = dy;
    B[2 * 24 + c + 2] = dz;
    B[3 * 24 + c] = dy; B[3 * 24 + c + 1] = dx;
    B[4 * 24 + c + 1] = dz; B[4 * 24 + c + 2] = dy;
    B[5 * 24 + c] = dz; B[5 * 24 + c + 2] = dx;
  }
  return B;
}

function Dmatrix(E: number, nu: number): Float64Array {
  const l = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const mu = E / (2 * (1 + nu));
  const D = new Float64Array(36);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) D[i * 6 + j] = l + (i === j ? 2 * mu : 0);
  for (let i = 3; i < 6; i++) D[i * 6 + i] = mu;
  return D;
}

const GAUSS_B = GAUSS.map(([a, b, c]) => Bmatrix(a, b, c));

/** Ke for a unit cube with E = 1 (scale by E·h for real elements). */
function unitStiffness(nu: number): Float64Array {
  const D = Dmatrix(1, nu);
  const K = new Float64Array(24 * 24);
  const detJ = 1 / 8; // (h/2)³ with h = 1
  const DB = new Float64Array(6 * 24);
  for (const B of GAUSS_B) {
    DB.fill(0);
    for (let i = 0; i < 6; i++) for (let k = 0; k < 6; k++) {
      const d = D[i * 6 + k];
      if (!d) continue;
      for (let j = 0; j < 24; j++) DB[i * 24 + j] += d * B[k * 24 + j];
    }
    for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += B[k * 24 + a] * DB[k * 24 + b];
      K[a * 24 + b] += s * detJ;
    }
  }
  return K;
}

// ---------- solver ----------

const TRACE = typeof process !== "undefined" && !!process.env?.PHYX3D_TRACE;
const FACE_NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

export function solveFea(part: Part, lc: LoadCase, opts: FeaOptions = {}): FeaResult {
  const target = opts.elements ?? 25000;
  const maxEl = opts.maxElements ?? Math.max(target, 60000);
  let size = opts.elementSize ?? Math.max(0.2, Math.cbrt(part.mass.volume / target));
  // strength runs on the design pose: loads/fixtures stay attached to the design whatever the print orientation
  const buildModel = (grid: VoxelGrid) => {
    const [bnx, bny, bnz] = part.buildDir;
    const { nx, ny, nz } = grid;
    const h = grid.size;
    const mat = part.material;
    const E = mat.youngsModulus;
    const Ku = unitStiffness(mat.poisson);
    const NX = nx + 1, NY = ny + 1;
    const nodeId = (i: number, j: number, k: number) => i + NX * (j + NY * k);
    const nodePos = (n: number): [number, number, number] => {
      const i = n % NX, j = Math.floor(n / NX) % NY, k = Math.floor(n / (NX * NY));
      return [grid.origin[0] + i * h, grid.origin[1] + j * h, grid.origin[2] + k * h];
    };

    // element list with their 8 node ids
    const elemVox: number[] = [];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (grid.data[vIndex(grid, i, j, k)]) elemVox.push(vIndex(grid, i, j, k));
    const elemNodes = (v: number): number[] => {
      const i = v % nx, j = Math.floor(v / nx) % ny, k = Math.floor(v / (nx * ny));
      return [nodeId(i, j, k), nodeId(i + 1, j, k), nodeId(i + 1, j + 1, k), nodeId(i, j + 1, k), nodeId(i, j, k + 1), nodeId(i + 1, j, k + 1), nodeId(i + 1, j + 1, k + 1), nodeId(i, j + 1, k + 1)];
    };

    // active nodes
    const totalNodes = NX * NY * (nz + 1);
    const used = new Uint8Array(totalNodes);
    for (const v of elemVox) for (const n of elemNodes(v)) used[n] = 1;
    const activeNodes: number[] = [];
    for (let n = 0; n < totalNodes; n++) if (used[n]) activeNodes.push(n);
    let zMin = Infinity, zMax = -Infinity, xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const n of activeNodes) {
      const [x, y, z] = nodePos(n);
      zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const inRegion = (r: Region, p: [number, number, number]): boolean => {
      if ("face" in r) {
        const d = Math.max(r.depth ?? 0, h * 0.5);
        switch (r.face) {
          case "bottom": return p[2] <= zMin + d;
          case "top": return p[2] >= zMax - d;
          case "-x": return p[0] <= xMin + d;
          case "+x": return p[0] >= xMax - d;
          case "-y": return p[1] <= yMin + d;
          case "+y": return p[1] >= yMax - d;
        }
      }
      if ("box" in r) {
        const e = h * 0.5;
        return [0, 1, 2].every((i) => p[i] >= r.box.min[i] - e && p[i] <= r.box.max[i] + e);
      }
      if ("rel" in r) {
        const lo = [xMin, yMin, zMin], hi = [xMax, yMax, zMax];
        const e = h * 0.5;
        return [0, 1, 2].every((i) => p[i] >= lo[i] + r.rel.min[i] * (hi[i] - lo[i]) - e && p[i] <= lo[i] + r.rel.max[i] * (hi[i] - lo[i]) + e);
      }
      const c = r.sphere.center;
      return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) <= r.sphere.radius + h * 0.5;
    };

    const fixedNode = new Uint8Array(totalNodes);
    let nFixed = 0;
    for (const n of activeNodes) if (lc.fixed.some((r) => inRegion(r, nodePos(n)))) { fixedNode[n] = 1; nFixed++; }
    if (!nFixed) throw new Error("No part of the model lies in the 'fixed' region — nothing holds the part.");

    // Drop elements not joined to the fixed region through shared FACES. Voxels that touch only along an
    // edge or at a corner are hinges: they make K singular (the "deflection" runs to 1e10 mm) and stall the solver.
    const elemAt = new Int32Array(nx * ny * nz).fill(-1);
    elemVox.forEach((v, e) => { elemAt[v] = e; });
    const reached = new Uint8Array(elemVox.length);
    const queue: number[] = [];
    // held = at least 3 of its nodes fixed (no 3 corners of a cube are in line); fewer is a hinge
    elemVox.forEach((v, e) => { if (elemNodes(v).filter((n) => fixedNode[n]).length >= 3) { reached[e] = 1; queue.push(e); } });
    while (queue.length) {
      const v = elemVox[queue.pop()!];
      const i = v % nx, j = Math.floor(v / nx) % ny, k = Math.floor(v / (nx * ny));
      for (const [di, dj, dk] of FACE_NB) {
        const a = i + di, b = j + dj, c = k + dk;
        if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
        const e2 = elemAt[vIndex(grid, a, b, c)];
        if (e2 >= 0 && !reached[e2]) { reached[e2] = 1; queue.push(e2); }
      }
    }
    const elements = elemVox.filter((_, e) => reached[e]);
    const dropped = elemVox.length - elements.length;
    return { bnx, bny, bnz, nx, ny, nz, h, mat, E, Ku, NX, NY, nodeId, nodePos, elemNodes, totalNodes, activeNodes, inRegion, fixedNode, elements, dropped };
  };
  // Walls thinner than an element vanish from a voxel grid, or turn into chains of voxels touching only
  // at edges, which are hinges and get dropped. Either way the model left over is not the part: refine
  // until the connected model holds the part's volume.
  let grid = voxelize(part.designMesh, +size.toFixed(4));
  let M = buildModel(grid);
  const keptShare = () => (M.elements.length * M.h ** 3) / Math.max(part.mass.volume, 1e-9);
  while (!opts.elementSize && Math.abs(keptShare() - 1) > 0.12 && size > 0.2 && countSolid(grid) / 0.75 ** 3 <= maxEl) {
    size *= 0.75;
    grid = voxelize(part.designMesh, +size.toFixed(4));
    M = buildModel(grid);
  }
  const captured = keptShare();
  const { bnx, bny, bnz, nx, ny, nz, h, mat, E, Ku, NX, NY, nodeId, nodePos, elemNodes, totalNodes, inRegion, fixedNode, elements, dropped } = M;

  // compact dof numbering
  const dofOf = new Int32Array(totalNodes).fill(-1);
  let nNodes = 0;
  for (const v of elements) for (const n of elemNodes(v)) if (dofOf[n] < 0) dofOf[n] = nNodes++;
  const ndof = nNodes * 3;
  const nodeOfDof = new Int32Array(nNodes);
  for (let n = 0; n < totalNodes; n++) if (dofOf[n] >= 0) nodeOfDof[dofOf[n]] = n;
  const edofs = new Int32Array(elements.length * 24);
  elements.forEach((v, e) => {
    const ns = elemNodes(v);
    for (let a = 0; a < 8; a++) for (let d = 0; d < 3; d++) edofs[e * 24 + a * 3 + d] = dofOf[ns[a]] * 3 + d;
  });
  const fixedDof = new Uint8Array(ndof);
  for (let i = 0; i < nNodes; i++) if (fixedNode[nodeOfDof[i]]) fixedDof[i * 3] = fixedDof[i * 3 + 1] = fixedDof[i * 3 + 2] = 1;

  // load vector (N)
  const f = new Float64Array(ndof);
  for (const load of lc.loads) {
    const nodes: number[] = [];
    for (let i = 0; i < nNodes; i++) if (inRegion(load.region, nodePos(nodeOfDof[i]))) nodes.push(i);
    if (!nodes.length) throw new Error(`Load region ${JSON.stringify(load.region)} does not touch the part.`);
    for (const i of nodes) for (let d = 0; d < 3; d++) f[i * 3 + d] += load.force[d] / nodes.length;
  }
  if (lc.acceleration) {
    // element mass (kg) × g × accel → split over 8 nodes
    const massE = (h ** 3 / 1e9) * mat.density * 1000 * part.estimateGrams().solidFraction;
    for (let e = 0; e < elements.length; e++) for (let a = 0; a < 8; a++) for (let d = 0; d < 3; d++) {
      f[edofs[e * 24 + a * 3 + d]] += (massE * 9.81 * lc.acceleration[d]) / 8;
    }
  }
  for (let i = 0; i < ndof; i++) if (fixedDof[i]) f[i] = 0;

  // prescribed displacements: held dofs with a value
  const up = new Float64Array(ndof);
  const presc: { move: [number, number, number]; dofs: number[] }[] = [];
  for (const dsp of lc.displacements ?? []) {
    const nodes: number[] = [];
    for (let i = 0; i < nNodes; i++) if (inRegion(dsp.region, nodePos(nodeOfDof[i]))) nodes.push(i);
    if (!nodes.length) throw new Error(`Displacement region ${JSON.stringify(dsp.region)} does not touch the part.`);
    const dofs: number[] = [];
    for (const i of nodes) for (let d = 0; d < 3; d++) {
      if (Math.abs(dsp.move[d]) < 1e-12) continue;
      const k = i * 3 + d;
      if (fixedDof[k]) continue;                 // a fixed region wins
      fixedDof[k] = 1; up[k] = dsp.move[d]; dofs.push(k);
    }
    presc.push({ move: dsp.move, dofs });
  }

  const scale = E * h;
  const Ke = Ku;
  const ue = new Float64Array(24);
  const matvec = (x: Float64Array, y: Float64Array) => {
    y.fill(0);
    for (let e = 0; e < elements.length; e++) {
      const o = e * 24;
      for (let a = 0; a < 24; a++) ue[a] = x[edofs[o + a]];
      for (let a = 0; a < 24; a++) {
        let s = 0;
        const row = a * 24;
        for (let b = 0; b < 24; b++) s += Ke[row + b] * ue[b];
        y[edofs[o + a]] += s * scale;
      }
    }
    for (let i = 0; i < ndof; i++) if (fixedDof[i]) y[i] = 0;
  };
  // Jacobi preconditioner
  const diag = new Float64Array(ndof);
  for (let e = 0; e < elements.length; e++) for (let a = 0; a < 24; a++) diag[edofs[e * 24 + a]] += Ke[a * 25] * scale;
  const invD = diag.map((d, i) => (fixedDof[i] || d === 0 ? 0 : 1 / d));
  // K·u without zeroing held rows: moves prescribed motion to the right-hand side, and gives reactions
  const kFull = (x: Float64Array, y: Float64Array) => {
    y.fill(0);
    for (let e = 0; e < elements.length; e++) {
      const o = e * 24;
      for (let a = 0; a < 24; a++) ue[a] = x[edofs[o + a]];
      for (let a = 0; a < 24; a++) {
        let s2 = 0;
        const row = a * 24;
        for (let b = 0; b < 24; b++) s2 += Ke[row + b] * ue[b];
        y[edofs[o + a]] += s2 * scale;
      }
    }
  };
  if (presc.length) {
    const kup = new Float64Array(ndof);
    kFull(up, kup);
    for (let i = 0; i < ndof; i++) if (!fixedDof[i]) f[i] -= kup[i];
  }

  // PCG
  const jacobi = (rr: Float64Array, zz: Float64Array) => { for (let i = 0; i < ndof; i++) zz[i] = rr[i] * invD[i]; };
  let precond = jacobi;
  if ((opts.preconditioner ?? "multigrid") === "multigrid") {
    const mg = multigrid({ nx, ny, nz, elems: elements, scale: new Float64Array(elements.length).fill(scale), nodeDof: dofOf, fixed: fixedDof, Ke });
    if (TRACE) console.error("mg levels", mg.levels, "omega", mg.omegas);
    precond = mg.apply;
  }
  const u = new Float64Array(ndof);
  const r = Float64Array.from(f);
  const z = new Float64Array(ndof);
  precond(r, z);
  const pdir = Float64Array.from(z);
  const Ap = new Float64Array(ndof);
  let rz = dot(r, z);
  const fNorm = Math.sqrt(dot(f, f)) || 1;
  const tol = opts.tolerance ?? 1e-6;
  const maxIt = opts.maxIterations ?? 10000;
  let it = 0, converged = false, residual = 1;
  for (; it < maxIt; it++) {
    matvec(pdir, Ap);
    const alpha = rz / (dot(pdir, Ap) || 1e-300);
    for (let i = 0; i < ndof; i++) { u[i] += alpha * pdir[i]; r[i] -= alpha * Ap[i]; }
    residual = Math.sqrt(dot(r, r)) / fNorm;
    if (TRACE && it % 500 === 0) console.error("it", it, residual.toExponential(2));
    if (residual < tol) { converged = true; it++; break; }
    precond(r, z);
    const rzNew = dot(r, z);
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < ndof; i++) pdir[i] = z[i] + beta * pdir[i];
  }

  // total displacement = solved free part + prescribed part; reactions at the pushed nodes
  for (let i = 0; i < ndof; i++) if (up[i]) u[i] = up[i];
  const reactions: FeaResult["reactions"] = [];
  if (presc.length) {
    const ku = new Float64Array(ndof);
    kFull(u, ku);
    for (const p of presc) {
      const F: [number, number, number] = [0, 0, 0];
      for (const k of p.dofs) F[k % 3] += ku[k];
      reactions.push({ move: p.move, force: F, nodes: p.dofs.length });
    }
  }

  // stresses: max over the 8 Gauss points of each element (MPa)
  const D = Dmatrix(E, mat.poisson);
  const vm = new Float32Array(elements.length);
  const sz = new Float32Array(elements.length);
  const sf = new Float32Array(elements.length);
  const strain = new Float64Array(6), stress = new Float64Array(6);
  const knock = strengthKnockdown(part);
  for (let e = 0; e < elements.length; e++) {
    for (let a = 0; a < 24; a++) ue[a] = u[edofs[e * 24 + a]];
    let maxVm = 0, maxSz = -Infinity;
    for (const B of GAUSS_B) {
      for (let i = 0; i < 6; i++) { let s = 0; for (let j = 0; j < 24; j++) s += B[i * 24 + j] * ue[j]; strain[i] = s / h; }
      for (let i = 0; i < 6; i++) { let s = 0; for (let j = 0; j < 6; j++) s += D[i * 6 + j] * strain[j]; stress[i] = s; }
      const [sx, sy, szz, txy, tyz, tzx] = stress;
      const v = Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - szz) ** 2 + (szz - sx) ** 2) + 3 * (txy * txy + tyz * tyz + tzx * tzx));
      if (v > maxVm) maxVm = v;
      // across-layer: traction on the layer plane (normal = build direction)
      const tx = sx * bnx + txy * bny + tzx * bnz, ty = txy * bnx + sy * bny + tyz * bnz, tz = tzx * bnx + tyz * bny + szz * bnz;
      const sn = tx * bnx + ty * bny + tz * bnz;
      const shear = Math.hypot(tx - sn * bnx, ty - sn * bny, tz - sn * bnz);
      const across = Math.max(sn, 0) + 0.5 * shear;
      if (across > maxSz) maxSz = across;
    }
    vm[e] = maxVm;
    sz[e] = maxSz;
  }
  for (let e = 0; e < elements.length; e++) {
    const sfXY = (mat.tensileXY * knock) / Math.max(vm[e], 1e-9);
    const sfZ = (mat.tensileZ * knock) / Math.max(sz[e], 1e-9);
    sf[e] = Math.min(sfXY, sfZ, 999);
  }
  const meanU: [number, number, number] = [0, 0, 0];
  for (let e = 0; e < elements.length; e++) for (let a = 0; a < 8; a++) for (let d = 0; d < 3; d++) meanU[d] += u[edofs[e * 24 + a * 3 + d]] / 8;
  for (let d = 0; d < 3; d++) meanU[d] /= Math.max(1, elements.length);
  let maxU = 0, maxUAt = 0;
  for (let i = 0; i < nNodes; i++) {
    const d = Math.hypot(u[i * 3], u[i * 3 + 1], u[i * 3 + 2]);
    if (d > maxU) { maxU = d; maxUAt = nodeOfDof[i]; }
  }
  return {
    grid,
    elements: Int32Array.from(elements),
    vonMises: vm,
    sigmaZ: sz,
    safety: sf,
    maxDisplacement: maxU,
    maxDisplacementAt: nodePos(maxUAt),
    iterations: it,
    converged,
    residual,
    captured,
    meanDisplacement: meanU,
    droppedElements: dropped,
    reactions,
  };
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Printed parts are not solid: thin walls + sparse infill carry less than the datasheet.
 * 1.0 for fully solid, ~0.7 for default 2 walls / 15% infill on chunky parts.
 */
export function strengthKnockdown(part: Part): number {
  return 0.55 + 0.45 * part.estimateGrams().solidFraction;
}

export function elementCenter(res: FeaResult, e: number): [number, number, number] {
  const g = res.grid;
  const v = res.elements[e];
  const i = v % g.nx, j = Math.floor(v / g.nx) % g.ny, k = Math.floor(v / (g.nx * g.ny));
  return [g.origin[0] + (i + 0.5) * g.size, g.origin[1] + (j + 0.5) * g.size, g.origin[2] + (k + 0.5) * g.size];
}

export type StrengthData = {
  minSafetyFactor: number;
  weakestAt: [number, number, number];
  /** "across-layers" means the part would split between layers — reorienting helps */
  failureMode: "along-layers" | "across-layers";
  maxVonMises: number;
  maxAcrossLayerStress: number;
  maxDeflection: number;
  maxDeflectionAt: [number, number, number];
  elements: number;
  elementSize: number;
  iterations: number;
  converged: boolean;
  /** final relative residual of the solve; below ~1e-3 the answer no longer changes */
  residual: number;
  /** share of the part's volume the element grid holds */
  captured: number;
  /** false when the numbers can't be trusted — see `unreliable` for why */
  reliable: boolean;
  unreliable: string[];
  strengthKnockdown: number;
  hotspots: { at: [number, number, number]; safety: number; mode: string }[];
  /** force it takes to push each prescribed displacement, N */
  pushForces: { move: [number, number, number]; forceN: number }[];
};

/** The same solve under a load scaled by `f`: the model is linear, so stress and displacement scale with it. */
export function scaleFea(res: FeaResult, f: number): FeaResult {
  const sc = (a: [number, number, number]) => a.map((v) => v * f) as [number, number, number];
  return {
    ...res,
    vonMises: res.vonMises.map((v) => v * f),
    sigmaZ: res.sigmaZ.map((v) => v * f),
    safety: res.safety.map((v) => Math.min(999, v / f)),
    maxDisplacement: res.maxDisplacement * f,
    meanDisplacement: sc(res.meanDisplacement),
    reactions: res.reactions.map((r) => ({ ...r, force: sc(r.force) })),
  };
}

/** `opts.result`: judge an existing solve (e.g. one rescaled with scaleFea) instead of solving again. */
export function checkStrength(part: Part, lc: LoadCase, opts: FeaOptions & { requiredSafety?: number; result?: FeaResult } = {}): CheckResult<StrengthData> & { fea: FeaResult } {
  const res = opts.result ?? solveFea(part, lc, opts);
  const need = opts.requiredSafety ?? 2;
  const mat = part.material;
  const knock = strengthKnockdown(part);
  // rank elements by safety, ignore the one-element-thick shell touching point loads (singular)
  const order = Array.from(res.safety.keys()).sort((a, b) => res.safety[a] - res.safety[b]);
  const hotspots: StrengthData["hotspots"] = [];
  for (const e of order) {
    const at = elementCenter(res, e);
    if (hotspots.some((h) => Math.hypot(h.at[0] - at[0], h.at[1] - at[1], h.at[2] - at[2]) < 8)) continue;
    const across = (mat.tensileZ * knock) / Math.max(res.sigmaZ[e], 1e-9) < (mat.tensileXY * knock) / Math.max(res.vonMises[e], 1e-9);
    hotspots.push({ at: r3(at), safety: r2(res.safety[e]), mode: across ? "across-layers" : "along-layers" });
    if (hotspots.length >= 5) break;
  }
  const weakest = hotspots[0];
  let maxVm = 0, maxSz = 0;
  for (let e = 0; e < res.elements.length; e++) { maxVm = Math.max(maxVm, res.vonMises[e]); maxSz = Math.max(maxSz, res.sigmaZ[e]); }
  const sfMin = weakest?.safety ?? 999;
  // Say plainly when the answer can't be trusted, instead of passing or failing the part on it.
  const unreliable: string[] = [];
  const size = Math.max(...part.bbox.size);
  if (!res.converged && res.residual > 1e-3) unreliable.push(`the solver stopped after ${res.iterations} iterations without converging (residual ${res.residual.toExponential(1)})`);
  if (Math.abs(res.captured - 1) > 0.2) unreliable.push(`the ${r2(res.grid.size)} mm element grid holds only ${Math.round(res.captured * 100)} % of the part's volume (walls thinner than ~${r2(res.grid.size * 2)} mm are not resolved)`);
  if (res.maxDisplacement > 0.1 * size) unreliable.push(`it bends ${res.maxDisplacement > 1e4 ? "without limit" : `${r2(res.maxDisplacement)} mm`}, more than 10 % of its size — beyond what a linear model can describe (a flexible material, or part of the model hanging by a thread)`);
  if (res.droppedElements > 0.05 * (res.elements.length + res.droppedElements)) unreliable.push(`${res.droppedElements} of ${res.elements.length + res.droppedElements} elements are not joined to the fixed region`);
  const reliable = unreliable.length === 0;
  const status = !reliable ? "warn" : sfMin < 1 ? "fail" : sfMin < need ? "warn" : "pass";
  const findings: Finding[] = hotspots.map((h) => ({
    status: h.safety < 1 ? "fail" : h.safety < need ? "warn" : "pass",
    message: `Safety factor ${h.safety} at (${h.at.join(", ")}) — ${h.mode === "across-layers" ? "layers would split apart here" : "material would yield/crack here"}.`,
    at: h.at,
  }));
  for (const r of res.reactions) {
    const L = Math.hypot(...r.move) || 1;
    const F = Math.abs((r.force[0] * r.move[0] + r.force[1] * r.move[1] + r.force[2] * r.move[2]) / L);
    findings.push({ status: "info", message: `Pushing ${r.move.map((v) => r2(v)).join(", ")} mm takes about ${r2(F)} N (${r2(F / 9.81)} kgf).` });
  }
  if (!reliable) findings.unshift({ status: "warn", message: `Unreliable result: ${unreliable.join("; ")}.` });
  else if (!res.converged) findings.push({ status: "info", message: `Solver stopped after ${res.iterations} iterations at residual ${res.residual.toExponential(1)}; close enough that the numbers hold.` });
  if (res.droppedElements) findings.push({ status: "info", message: `${res.droppedElements} voxels not connected to the fixed region were ignored.` });
  const fixes: string[] = [];
  if (status !== "pass") {
    if (weakest?.mode === "across-layers") fixes.push("The weak spot is pulled across layers: rotate the part so the load runs along the layers (lay it on its side), or add a fillet/gusset there.");
    fixes.push(`Thicken the section near (${weakest?.at.join(", ")}) or add a fillet (r ≥ 2 mm) to spread the stress.`);
    fixes.push("In Bambu Studio raise wall loops to 4–6 and infill to 30–40% (walls add far more strength than infill).");
    if (mat.id === "PLA") fixes.push("PETG or PLA-CF handles impact/creep better than PLA for loaded parts.");
  }
  return {
    id: "strength",
    title: "Strength under load",
    status,
    summary: `${reliable ? "" : `UNRELIABLE (${unreliable.map((u) => u.split(" (")[0]).join("; ")}) — `}Minimum safety factor ${r2(sfMin)} (need ≥ ${need}) — ${weakest?.mode === "across-layers" ? "limited by layer adhesion" : "limited by material strength"}; max deflection ${r2(res.maxDisplacement)} mm${res.reactions.length ? `; pushing it takes ${res.reactions.map((r) => { const L = Math.hypot(...r.move) || 1; return `${r2(Math.abs((r.force[0] * r.move[0] + r.force[1] * r.move[1] + r.force[2] * r.move[2]) / L))} N`; }).join(" + ")}` : ""}.`,
    accuracy: "rough-guide",
    findings,
    fixes,
    data: {
      minSafetyFactor: r2(sfMin),
      weakestAt: weakest?.at ?? [0, 0, 0],
      failureMode: (weakest?.mode as StrengthData["failureMode"]) ?? "along-layers",
      maxVonMises: r2(maxVm),
      maxAcrossLayerStress: r2(maxSz),
      maxDeflection: r2(res.maxDisplacement),
      maxDeflectionAt: r3(res.maxDisplacementAt),
      elements: res.elements.length,
      elementSize: r2(res.grid.size),
      iterations: res.iterations,
      converged: res.converged,
      residual: +res.residual.toExponential(2),
      captured: r2(res.captured),
      reliable,
      unreliable,
      strengthKnockdown: r2(knock),
      hotspots,
      pushForces: res.reactions.map((r) => {
        const L = Math.hypot(...r.move) || 1;
        return { move: r.move, forceN: r2(Math.abs((r.force[0] * r.move[0] + r.force[1] * r.move[1] + r.force[2] * r.move[2]) / L)) };
      }),
    },
    fea: res,
  };
}

