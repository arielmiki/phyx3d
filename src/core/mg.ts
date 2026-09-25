// Geometric multigrid preconditioner for the voxel FEA.
//
// Plain Jacobi-preconditioned CG needs thousands of iterations on slender or thin-walled parts (a plate
// 2 elements thick and 80 mm wide, a frame hanging off a small contact patch): the error that survives is
// smooth over the whole part, and Jacobi only damps error at the element scale. A V-cycle fixes that by
// removing the smooth error on coarser grids: each level merges 2×2×2 elements into one.
//
// Coarse levels are re-discretised, not Galerkin products: a coarse element's stiffness is the unit
// stiffness scaled by how much of it is solid. That is cheap and matrix-free, and good enough as a
// preconditioner — CG on the fine level still decides when the answer is converged.

export interface MgFine {
  /** element grid size */
  nx: number; ny: number; nz: number;
  /** voxel index (i + nx·(j + ny·k)) of each element */
  elems: ArrayLike<number>;
  /** stiffness scale of each element (E·h for a full fine voxel) */
  scale: ArrayLike<number>;
  /** compact node number of each grid node ((nx+1)(ny+1)(nz+1)), −1 if unused */
  nodeDof: Int32Array;
  /** per dof (compact node·3 + axis): held */
  fixed: Uint8Array;
  /** 24×24 unit-cube element stiffness */
  Ke: Float64Array;
}

interface Level {
  nx: number; ny: number; nz: number;
  elems: Int32Array;
  scale: Float64Array;
  nodeDof: Int32Array;
  nNodes: number;
  edofs: Int32Array;
  fixed: Uint8Array;
  invDiag: Float64Array;
  omega: number;
  /** prolongation from the next coarser level: per node of THIS level, up to 8 (coarse node, weight) */
  pStart?: Int32Array; pNode?: Int32Array; pW?: Float64Array;
  /** dense Cholesky factor (coarsest level only) */
  chol?: Float64Array; free?: Int32Array;
}

// Damped-Jacobi smoothing only damps (never amplifies) error while ω·λmax(D⁻¹K) < 2. λmax depends on
// the shape — one-voxel-thick walls push it well above the ~2 of a solid block — so it is measured per level.
const OMEGA_LAMBDA = 1.1;  // ω = OMEGA_LAMBDA / λmax
const SWEEPS = 2;        // smoothing sweeps before and after the coarse correction
const COARSEST = 1500;   // dofs at or below which the level is solved directly

function nodeOffsets(nx: number, ny: number) {
  const NX = nx + 1, NY = ny + 1;
  return (i: number, j: number, k: number) => i + NX * (j + NY * k);
}

function finishLevel(nx: number, ny: number, nz: number, elems: Int32Array, scale: Float64Array, nodeDof: Int32Array, nNodes: number, fixed: Uint8Array, Ke: Float64Array): Level {
  const nid = nodeOffsets(nx, ny);
  const edofs = new Int32Array(elems.length * 24);
  for (let e = 0; e < elems.length; e++) {
    const v = elems[e];
    const i = v % nx, j = Math.floor(v / nx) % ny, k = Math.floor(v / (nx * ny));
    const ns = [nid(i, j, k), nid(i + 1, j, k), nid(i + 1, j + 1, k), nid(i, j + 1, k), nid(i, j, k + 1), nid(i + 1, j, k + 1), nid(i + 1, j + 1, k + 1), nid(i, j + 1, k + 1)];
    for (let a = 0; a < 8; a++) for (let d = 0; d < 3; d++) edofs[e * 24 + a * 3 + d] = nodeDof[ns[a]] * 3 + d;
  }
  const diag = new Float64Array(nNodes * 3);
  for (let e = 0; e < elems.length; e++) for (let a = 0; a < 24; a++) diag[edofs[e * 24 + a]] += Ke[a * 25] * scale[e];
  const invDiag = diag.map((d, i) => (fixed[i] || d === 0 ? 0 : 1 / d));
  const L: Level = { nx, ny, nz, elems, scale, nodeDof, nNodes, edofs, fixed, invDiag, omega: 0.5 };
  L.omega = OMEGA_LAMBDA / lambdaMax(L, Ke);
  return L;
}

/** Largest eigenvalue of D⁻¹K by power iteration (a slight overestimate is the safe side). */
function lambdaMax(L: Level, Ke: Float64Array): number {
  const n = L.nNodes * 3;
  let x = new Float64Array(n), y = new Float64Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; x[i] = L.fixed[i] ? 0 : seed / 0x7fffffff - 0.5; }
  let lam = 1;
  for (let it = 0; it < 15; it++) {
    applyA(L, Ke, x, y);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { y[i] *= L.invDiag[i]; num += y[i] * y[i]; den += x[i] * x[i]; }
    lam = Math.sqrt(num / (den || 1));
    const norm = Math.sqrt(num) || 1;
    for (let i = 0; i < n; i++) y[i] /= norm;
    [x, y] = [y, x];
  }
  return lam * 1.05;
}

/** Build the next coarser level (2×2×2 fine elements → 1) and the prolongation into `fine`. */
function coarsen(fine: Level, Ke: Float64Array): Level {
  const cnx = Math.ceil(fine.nx / 2), cny = Math.ceil(fine.ny / 2), cnz = Math.ceil(fine.nz / 2);
  const acc = new Map<number, number>();
  for (let e = 0; e < fine.elems.length; e++) {
    const v = fine.elems[e];
    const i = v % fine.nx, j = Math.floor(v / fine.nx) % fine.ny, k = Math.floor(v / (fine.nx * fine.ny));
    const c = (i >> 1) + cnx * ((j >> 1) + cny * (k >> 1));
    acc.set(c, (acc.get(c) ?? 0) + fine.scale[e]);
  }
  const elems = Int32Array.from([...acc.keys()].sort((a, b) => a - b));
  // a full coarse element is twice the size (stiffness ∝ E·h): Σ(8 children at E·h)/4 = E·2h
  const scale = Float64Array.from(elems, (c) => acc.get(c)! / 4);
  const cNX = cnx + 1, cNY = cny + 1, cNZ = cnz + 1;
  const nodeDof = new Int32Array(cNX * cNY * cNZ).fill(-1);
  const cnid = nodeOffsets(cnx, cny);
  let nNodes = 0;
  for (const v of elems) {
    const i = v % cnx, j = Math.floor(v / cnx) % cny, k = Math.floor(v / (cnx * cny));
    for (let dk = 0; dk <= 1; dk++) for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
      const n = cnid(i + di, j + dj, k + dk);
      if (nodeDof[n] < 0) nodeDof[n] = nNodes++;
    }
  }
  // prolongation: trilinear interpolation of each fine node from the coarse nodes around it
  const fNX = fine.nx + 1, fNY = fine.ny + 1;
  const pStart = new Int32Array(fine.nNodes + 1);
  const pNode: number[] = [], pW: number[] = [];
  const fineNodeGrid = new Int32Array(fine.nNodes);
  for (let n = 0; n < fine.nodeDof.length; n++) if (fine.nodeDof[n] >= 0) fineNodeGrid[fine.nodeDof[n]] = n;
  // a coarse node is held if any fine node it interpolates to is held (keeps the coarse problem anchored)
  const cFixed = new Uint8Array(nNodes * 3);
  for (let f = 0; f < fine.nNodes; f++) {
    pStart[f] = pNode.length;
    const n = fineNodeGrid[f];
    const i = n % fNX, j = Math.floor(n / fNX) % fNY, k = Math.floor(n / (fNX * fNY));
    const is = i & 1 ? [i >> 1, (i >> 1) + 1] : [i >> 1], js = j & 1 ? [j >> 1, (j >> 1) + 1] : [j >> 1], ks = k & 1 ? [k >> 1, (k >> 1) + 1] : [k >> 1];
    const w = 1 / (is.length * js.length * ks.length);
    for (const K of ks) for (const J of js) for (const I of is) {
      const c = nodeDof[cnid(I, J, K)];
      if (c < 0) continue;
      pNode.push(c); pW.push(w);
      for (let d = 0; d < 3; d++) if (fine.fixed[f * 3 + d]) cFixed[c * 3 + d] = 1;
    }
  }
  pStart[fine.nNodes] = pNode.length;
  fine.pStart = pStart; fine.pNode = Int32Array.from(pNode); fine.pW = Float64Array.from(pW);
  return finishLevel(cnx, cny, cnz, elems, scale, nodeDof, nNodes, cFixed, Ke);
}

function applyA(L: Level, Ke: Float64Array, x: Float64Array, y: Float64Array) {
  y.fill(0);
  const ue = new Float64Array(24);
  const { edofs, scale } = L;
  for (let e = 0; e < L.elems.length; e++) {
    const o = e * 24, s = scale[e];
    for (let a = 0; a < 24; a++) ue[a] = x[edofs[o + a]];
    for (let a = 0; a < 24; a++) {
      let t = 0;
      const row = a * 24;
      for (let b = 0; b < 24; b++) t += Ke[row + b] * ue[b];
      y[edofs[o + a]] += t * s;
    }
  }
  for (let i = 0; i < y.length; i++) if (L.fixed[i]) y[i] = 0;
}

/** Dense Cholesky of the coarsest level (free dofs only, a hair of regularisation keeps it SPD). */
function factorCoarsest(L: Level, Ke: Float64Array) {
  const free: number[] = [];
  const pos = new Int32Array(L.nNodes * 3).fill(-1);
  for (let i = 0; i < L.nNodes * 3; i++) if (!L.fixed[i]) { pos[i] = free.length; free.push(i); }
  const n = free.length;
  const A = new Float64Array(n * n);
  for (let e = 0; e < L.elems.length; e++) {
    const o = e * 24, s = L.scale[e];
    for (let a = 0; a < 24; a++) {
      const pa = pos[L.edofs[o + a]];
      if (pa < 0) continue;
      for (let b = 0; b < 24; b++) {
        const pb = pos[L.edofs[o + b]];
        if (pb >= 0) A[pa * n + pb] += Ke[a * 24 + b] * s;
      }
    }
  }
  let maxD = 0;
  for (let i = 0; i < n; i++) maxD = Math.max(maxD, A[i * n + i]);
  for (let i = 0; i < n; i++) A[i * n + i] += 1e-9 * maxD + (A[i * n + i] === 0 ? maxD : 0);
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] * A[j * n + k];
    d = Math.sqrt(Math.max(d, 1e-12 * maxD));
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = A[i * n + j];
      for (let k = 0; k < j; k++) t -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = t / d;
    }
  }
  L.chol = A; L.free = Int32Array.from(free);
}

function solveCoarsest(L: Level, b: Float64Array, x: Float64Array) {
  const A = L.chol!, free = L.free!, n = free.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = b[free[i]];
    for (let k = 0; k < i; k++) t -= A[i * n + k] * y[k];
    y[i] = t / A[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = y[i];
    for (let k = i + 1; k < n; k++) t -= A[k * n + i] * y[k];
    y[i] = t / A[i * n + i];
  }
  x.fill(0);
  for (let i = 0; i < n; i++) x[free[i]] = y[i];
}

/**
 * Build a V-cycle preconditioner. Returns `apply(r, z)`: z ≈ K⁻¹ r, a fixed linear symmetric operator,
 * so it can precondition plain CG.
 */
export function multigrid(fine: MgFine): { apply: (r: Float64Array, z: Float64Array) => void; levels: number[]; omegas: number[] } {
  let nNodes = 0;
  for (const d of fine.nodeDof) if (d >= 0) nNodes++;
  const levels: Level[] = [finishLevel(fine.nx, fine.ny, fine.nz, Int32Array.from(fine.elems), Float64Array.from(fine.scale), fine.nodeDof, nNodes, fine.fixed, fine.Ke)];
  while (levels[levels.length - 1].nNodes * 3 > COARSEST && levels.length < 12) {
    const c = coarsen(levels[levels.length - 1], fine.Ke);
    if (c.nNodes >= levels[levels.length - 1].nNodes * 0.8) break;   // not shrinking: stop here
    levels.push(c);
  }
  const last = levels[levels.length - 1];
  const direct = last.nNodes * 3 <= COARSEST * 1.5;
  if (direct) factorCoarsest(last, fine.Ke);
  const Ke = fine.Ke;
  const tmp = levels.map((L) => ({ r: new Float64Array(L.nNodes * 3), Ax: new Float64Array(L.nNodes * 3), x: new Float64Array(L.nNodes * 3), b: new Float64Array(L.nNodes * 3) }));

  const smooth = (L: Level, t: (typeof tmp)[number], b: Float64Array, x: Float64Array, sweeps: number) => {
    for (let s = 0; s < sweeps; s++) {
      applyA(L, Ke, x, t.Ax);
      const w = L.omega;
      for (let i = 0; i < x.length; i++) x[i] += w * L.invDiag[i] * (b[i] - t.Ax[i]);
    }
  };
  const vcycle = (l: number, b: Float64Array, x: Float64Array) => {
    const L = levels[l], t = tmp[l];
    if (l === levels.length - 1) {
      if (direct) solveCoarsest(L, b, x);
      else { x.fill(0); smooth(L, t, b, x, 20); }
      return;
    }
    x.fill(0);
    smooth(L, t, b, x, SWEEPS);
    applyA(L, Ke, x, t.Ax);
    for (let i = 0; i < x.length; i++) t.r[i] = b[i] - t.Ax[i];
    // restrict the residual (Pᵀ r)
    const C = levels[l + 1], tc = tmp[l + 1];
    tc.b.fill(0);
    const pS = L.pStart!, pN = L.pNode!, pW = L.pW!;
    for (let f = 0; f < L.nNodes; f++) for (let q = pS[f]; q < pS[f + 1]; q++) {
      const c = pN[q] * 3, w = pW[q];
      tc.b[c] += w * t.r[f * 3]; tc.b[c + 1] += w * t.r[f * 3 + 1]; tc.b[c + 2] += w * t.r[f * 3 + 2];
    }
    for (let i = 0; i < tc.b.length; i++) if (C.fixed[i]) tc.b[i] = 0;
    vcycle(l + 1, tc.b, tc.x);
    // prolong the correction (P e)
    for (let f = 0; f < L.nNodes; f++) for (let q = pS[f]; q < pS[f + 1]; q++) {
      const c = pN[q] * 3, w = pW[q];
      x[f * 3] += w * tc.x[c]; x[f * 3 + 1] += w * tc.x[c + 1]; x[f * 3 + 2] += w * tc.x[c + 2];
    }
    for (let i = 0; i < x.length; i++) if (L.fixed[i]) x[i] = 0;
    smooth(L, t, b, x, SWEEPS);
  };
  return { apply: (r, z) => vcycle(0, r, z), levels: levels.map((L) => L.elems.length), omegas: levels.map((L) => +L.omega.toFixed(3)) };
}
