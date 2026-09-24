// Triangle mesh type + geometry basics. All units are millimetres, Z is up (build direction).

export type Vec3 = [number, number, number];

export interface Mesh {
  /** xyz triplets */
  positions: Float32Array;
  /** 3 vertex indices per triangle, counter-clockwise seen from outside */
  indices: Uint32Array;
}

export interface BBox {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

export function triCount(m: Mesh): number {
  return m.indices.length / 3;
}

/** Merge coincident vertices of a triangle soup (9 floats per triangle) into an indexed mesh. */
export function weld(soup: ArrayLike<number>, tolerance = 1e-4): Mesh {
  const inv = 1 / tolerance;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const nTri = Math.floor(soup.length / 9);
  const idx: number[] = [];
  for (let t = 0; t < nTri; t++) {
    const tri = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const x = soup[o], y = soup[o + 1], z = soup[o + 2];
      const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
      let i = map.get(key);
      if (i === undefined) {
        i = pos.length / 3;
        pos.push(x, y, z);
        map.set(key, i);
      }
      tri[k] = i;
    }
    // drop degenerate triangles that collapsed during welding
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    idx.push(tri[0], tri[1], tri[2]);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export function mergeMeshes(meshes: Mesh[]): Mesh {
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

export function bbox(m: Mesh): BBox {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

export function tri(m: Mesh, t: number): [Vec3, Vec3, Vec3] {
  const p = m.positions, i = m.indices;
  const a = i[t * 3] * 3, b = i[t * 3 + 1] * 3, c = i[t * 3 + 2] * 3;
  return [
    [p[a], p[a + 1], p[a + 2]],
    [p[b], p[b + 1], p[b + 2]],
    [p[c], p[c + 1], p[c + 2]],
  ];
}

/** Unnormalised face normal (length = 2 × area). */
export function faceNormalRaw(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

export function faceNormals(m: Mesh): { normals: Float32Array; areas: Float32Array } {
  const n = triCount(m);
  const normals = new Float32Array(n * 3);
  const areas = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const [a, b, c] = tri(m, t);
    const r = faceNormalRaw(a, b, c);
    const len = Math.hypot(r[0], r[1], r[2]);
    areas[t] = len / 2;
    if (len > 0) {
      normals[t * 3] = r[0] / len;
      normals[t * 3 + 1] = r[1] / len;
      normals[t * 3 + 2] = r[2] / len;
    }
  }
  return { normals, areas };
}

export interface MassProps {
  /** mm³ (solid, i.e. 100% infill) */
  volume: number;
  /** mm² */
  surfaceArea: number;
  /** centre of mass of the solid, mm */
  centerOfMass: Vec3;
}

/** Volume, area and centre of mass via signed tetrahedra (divergence theorem). */
export function massProps(m: Mesh): MassProps {
  let vol = 0, area = 0, cx = 0, cy = 0, cz = 0;
  const n = triCount(m);
  for (let t = 0; t < n; t++) {
    const [a, b, c] = tri(m, t);
    const r = faceNormalRaw(a, b, c);
    area += Math.hypot(r[0], r[1], r[2]) / 2;
    // signed volume of tetra (origin, a, b, c)
    const v = (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    vol += v;
    cx += v * (a[0] + b[0] + c[0]) / 4;
    cy += v * (a[1] + b[1] + c[1]) / 4;
    cz += v * (a[2] + b[2] + c[2]) / 4;
  }
  const com: Vec3 = vol !== 0 ? [cx / vol, cy / vol, cz / vol] : [0, 0, 0];
  return { volume: Math.abs(vol), surfaceArea: area, centerOfMass: com };
}

export interface MeshHealth {
  triangles: number;
  vertices: number;
  /** edges used by only one triangle (holes) */
  openEdges: number;
  /** edges used by more than two triangles */
  nonManifoldEdges: number;
  /** edges whose two triangles disagree on winding (flipped normals) */
  flippedEdges: number;
  watertight: boolean;
  /** true when the signed volume is negative (all normals point inward) */
  inverted: boolean;
  /** number of disconnected shells */
  shells: number;
}

export function meshHealth(m: Mesh): MeshHealth {
  const n = triCount(m);
  const edges = new Map<string, { fwd: number; rev: number }>();
  const idx = m.indices;
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k], b = idx[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let e = edges.get(key);
      if (!e) { e = { fwd: 0, rev: 0 }; edges.set(key, e); }
      if (a < b) e.fwd++; else e.rev++;
    }
  }
  let open = 0, nonMan = 0, flipped = 0;
  for (const e of edges.values()) {
    const total = e.fwd + e.rev;
    if (total === 1) open++;
    else if (total > 2) nonMan++;
    else if (e.fwd !== 1) flipped++;
  }
  // shells via union-find over vertices
  const nv = m.positions.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < n; t++) {
    const a = find(idx[t * 3]), b = find(idx[t * 3 + 1]), c = find(idx[t * 3 + 2]);
    parent[b] = a; parent[find(c)] = find(a);
  }
  const roots = new Set<number>();
  const used = new Uint8Array(nv);
  for (let i = 0; i < idx.length; i++) used[idx[i]] = 1;
  for (let i = 0; i < nv; i++) if (used[i]) roots.add(find(i));

  let signed = 0;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = tri(m, t);
    signed += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return {
    triangles: n,
    vertices: nv,
    openEdges: open,
    nonManifoldEdges: nonMan,
    flippedEdges: flipped,
    watertight: open === 0 && nonMan === 0,
    inverted: signed < 0,
    shells: roots.size,
  };
}

// ---------- transforms ----------

export function transformMesh(m: Mesh, f: (x: number, y: number, z: number) => Vec3): Mesh {
  const p = new Float32Array(m.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    const r = f(m.positions[i], m.positions[i + 1], m.positions[i + 2]);
    p[i] = r[0]; p[i + 1] = r[1]; p[i + 2] = r[2];
  }
  return { positions: p, indices: m.indices };
}

export function translate(m: Mesh, d: Vec3): Mesh {
  return transformMesh(m, (x, y, z) => [x + d[0], y + d[1], z + d[2]]);
}

/** Rotate by Euler angles in degrees, applied X then Y then Z (about the origin). */
export function rotateDeg(m: Mesh, rx: number, ry: number, rz: number): Mesh {
  const [ax, ay, az] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  return transformMesh(m, (x, y, z) => {
    let y1 = y * cx - z * sx, z1 = y * sx + z * cx; y = y1; z = z1;
    let x1 = x * cy + z * sy; z1 = -x * sy + z * cy; x = x1; z = z1;
    x1 = x * cz - y * sz; y1 = x * sz + y * cz;
    return [x1, y1, z];
  });
}

/** Flip triangle winding (fixes inside-out meshes). */
export function flipWinding(m: Mesh): Mesh {
  const idx = new Uint32Array(m.indices);
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  return { positions: m.positions, indices: idx };
}

/** Move the mesh so it rests on the bed (z min = 0) centred at (cx, cy). */
export function placeOnBed(m: Mesh, cx: number, cy: number): Mesh {
  const b = bbox(m);
  return translate(m, [cx - (b.min[0] + b.max[0]) / 2, cy - (b.min[1] + b.max[1]) / 2, -b.min[2]]);
}

// ---------- primitives (used by tests, examples and the web demo) ----------

export function box(sx: number, sy: number, sz: number, origin: Vec3 = [0, 0, 0]): Mesh {
  return extrude([[0, 0], [sx, 0], [sx, sy], [0, sy]], sz, origin);
}

export function cylinder(r: number, h: number, segments = 48, origin: Vec3 = [0, 0, 0]): Mesh {
  const poly: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    poly.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return extrude(poly, h, origin);
}

/**
 * Extrude a simple polygon (CCW, XY plane) along +Z. Caps are triangulated by ear clipping,
 * so concave outlines (T, L, U shapes) are fine.
 */
export function extrude(poly: [number, number][], h: number, origin: Vec3 = [0, 0, 0]): Mesh {
  const n = poly.length;
  const soup: number[] = [];
  const [ox, oy, oz] = origin;
  const P = (i: number, top: boolean): Vec3 => [poly[i][0] + ox, poly[i][1] + oy, oz + (top ? h : 0)];
  const push = (a: Vec3, b: Vec3, c: Vec3) => soup.push(...a, ...b, ...c);
  for (const [a, b, c] of earClip(poly)) {
    push(P(a, true), P(b, true), P(c, true)); // top faces up
    push(P(a, false), P(c, false), P(b, false)); // bottom faces down
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(P(i, false), P(j, false), P(j, true));
    push(P(i, false), P(j, true), P(i, true));
  }
  return weld(soup);
}

/** Extrude a CCW profile drawn in the XZ plane along +Y (handy for T-shapes and brackets). */
export function extrudeXZ(profile: [number, number][], depth: number): Mesh {
  // build along Z then rotate so the profile's second coord becomes Z
  const m = extrude(profile, depth);
  // (x, y, z) -> (x, z, y) mirrors; fix winding afterwards
  return flipWinding(transformMesh(m, (x, y, z) => [x, z, y]));
}

function earClip(poly: [number, number][]): [number, number, number][] {
  const idx = poly.map((_, i) => i);
  // ensure CCW
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) idx.reverse();
  const out: [number, number, number][] = [];
  const cross = (a: number, b: number, c: number) =>
    (poly[b][0] - poly[a][0]) * (poly[c][1] - poly[a][1]) - (poly[b][1] - poly[a][1]) * (poly[c][0] - poly[a][0]);
  const inside = (p: number, a: number, b: number, c: number) =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (inside(p, a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

export function uvSphere(r: number, rings = 16, segments = 24, origin: Vec3 = [0, 0, 0]): Mesh {
  const soup: number[] = [];
  const P = (i: number, j: number): Vec3 => {
    const th = (i / rings) * Math.PI, ph = (j / segments) * Math.PI * 2;
    return [origin[0] + r * Math.sin(th) * Math.cos(ph), origin[1] + r * Math.sin(th) * Math.sin(ph), origin[2] + r * Math.cos(th)];
  };
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (i > 0) soup.push(...a, ...b, ...d);
    if (i < rings - 1) soup.push(...b, ...c, ...d);
  }
  return weld(soup, 1e-6);
}

/** Apply a rigid pose (unit quaternion, then translation) to every vertex. */
export function poseMesh(m: Mesh, q: [number, number, number, number], p: Vec3): Mesh {
  const [x, y, z, w] = q;
  return transformMesh(m, (vx, vy, vz) => {
    const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
    return [
      ix * w + iw * -x + iy * -z - iz * -y + p[0],
      iy * w + iw * -y + iz * -x - ix * -z + p[1],
      iz * w + iw * -z + ix * -y - iy * -x + p[2],
    ];
  });
}
