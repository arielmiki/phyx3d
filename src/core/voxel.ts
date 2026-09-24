// Solid voxelisation by vertical ray parity. Z columns line up with print layers, which makes
// layer-by-layer questions (islands, partial centre of mass, cross-sections) cheap.
import { type Mesh, bbox, triCount } from "./mesh.js";

export interface VoxelGrid {
  /** world position of voxel (0,0,0)'s min corner */
  origin: [number, number, number];
  /** voxel edge length, mm */
  size: number;
  nx: number;
  ny: number;
  nz: number;
  /** 1 = solid */
  data: Uint8Array;
}

export const vIndex = (g: VoxelGrid, x: number, y: number, z: number) => x + g.nx * (y + g.ny * z);

export function voxelCenter(g: VoxelGrid, x: number, y: number, z: number): [number, number, number] {
  return [g.origin[0] + (x + 0.5) * g.size, g.origin[1] + (y + 0.5) * g.size, g.origin[2] + (z + 0.5) * g.size];
}

/** Pick a voxel size so the bounding box holds at most `budget` voxels. */
export function autoVoxelSize(m: Mesh, budget: number, minSize = 0.2): number {
  const b = bbox(m);
  const vol = Math.max(b.size[0], 0.1) * Math.max(b.size[1], 0.1) * Math.max(b.size[2], 0.1);
  return Math.max(minSize, Math.cbrt(vol / budget));
}

export function voxelize(m: Mesh, size: number): VoxelGrid {
  const b = bbox(m);
  const nx = Math.max(1, Math.ceil(b.size[0] / size));
  const ny = Math.max(1, Math.ceil(b.size[1] / size));
  const nz = Math.max(1, Math.ceil(b.size[2] / size));
  // centre the grid on the bbox so thin parts are sampled symmetrically
  const origin: [number, number, number] = [
    b.min[0] - (nx * size - b.size[0]) / 2,
    b.min[1] - (ny * size - b.size[1]) / 2,
    b.min[2],
  ];
  const g: VoxelGrid = { origin, size, nx, ny, nz, data: new Uint8Array(nx * ny * nz) };

  // bin triangles by the XY columns they cover
  const bins: number[][] = Array.from({ length: nx * ny }, () => []);
  const p = m.positions, idx = m.indices;
  const n = triCount(m);
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3] * 3, bb = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const minx = Math.min(p[a], p[bb], p[c]), maxx = Math.max(p[a], p[bb], p[c]);
    const miny = Math.min(p[a + 1], p[bb + 1], p[c + 1]), maxy = Math.max(p[a + 1], p[bb + 1], p[c + 1]);
    const x0 = Math.max(0, Math.floor((minx - origin[0]) / size - 0.5));
    const x1 = Math.min(nx - 1, Math.ceil((maxx - origin[0]) / size - 0.5));
    const y0 = Math.max(0, Math.floor((miny - origin[1]) / size - 0.5));
    const y1 = Math.min(ny - 1, Math.ceil((maxy - origin[1]) / size - 0.5));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bins[x + nx * y].push(t);
  }

  const hits: number[] = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const bin = bins[x + nx * y];
      if (!bin.length) continue;
      // tiny irrational offset avoids rays grazing shared edges/vertices exactly
      const px = origin[0] + (x + 0.5) * size + size * 1.37e-4;
      const py = origin[1] + (y + 0.5) * size + size * 2.71e-4;
      hits.length = 0;
      for (const t of bin) {
        const a = idx[t * 3] * 3, bb = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
        const ax = p[a], ay = p[a + 1], bx = p[bb], by = p[bb + 1], cx = p[c], cy = p[c + 1];
        const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(d) < 1e-14) continue; // vertical triangle
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        hits.push(l1 * p[a + 2] + l2 * p[bb + 2] + l3 * p[c + 2]);
      }
      if (hits.length < 2) continue;
      hits.sort((u, v) => u - v);
      for (let k = 0; k + 1 < hits.length; k += 2) {
        const z0 = hits[k], z1 = hits[k + 1];
        // fill voxels whose centre lies inside [z0, z1]
        const s = Math.max(0, Math.ceil((z0 - origin[2]) / size - 0.5));
        const e = Math.min(nz - 1, Math.floor((z1 - origin[2]) / size - 0.5));
        for (let z = s; z <= e; z++) g.data[vIndex(g, x, y, z)] = 1;
      }
    }
  }
  return g;
}

export function countSolid(g: VoxelGrid): number {
  let n = 0;
  for (let i = 0; i < g.data.length; i++) n += g.data[i];
  return n;
}

export interface LayerStat {
  /** z of the top of this voxel layer, mm (relative to grid origin) */
  zTop: number;
  /** solid cross-section area, mm² */
  area: number;
  /** cumulative solid volume from the bed up to and including this layer, mm³ */
  cumVolume: number;
  /** centre of mass of everything printed so far */
  cumCom: [number, number, number];
}

/** Per-layer cross-section and "printed so far" centre of mass. */
export function layerStats(g: VoxelGrid): LayerStat[] {
  const out: LayerStat[] = [];
  const v = g.size ** 3;
  let cum = 0, sx = 0, sy = 0, sz = 0;
  for (let z = 0; z < g.nz; z++) {
    let n = 0;
    for (let y = 0; y < g.ny; y++) {
      for (let x = 0; x < g.nx; x++) {
        if (!g.data[vIndex(g, x, y, z)]) continue;
        n++;
        const c = voxelCenter(g, x, y, z);
        sx += c[0]; sy += c[1]; sz += c[2];
      }
    }
    cum += n;
    out.push({
      zTop: (z + 1) * g.size,
      area: n * g.size * g.size,
      cumVolume: cum * v,
      cumCom: cum ? [sx / cum, sy / cum, sz / cum] : [0, 0, 0],
    });
  }
  return out;
}

export interface Island {
  /** layer index where the unsupported region starts */
  layer: number;
  /** height above bed, mm */
  z: number;
  /** area of the unsupported region, mm² */
  area: number;
  center: [number, number, number];
  min: [number, number];
  max: [number, number];
}

/**
 * Regions that appear in a layer with nothing underneath (within one voxel sideways, which
 * lets ~45° slopes count as supported). These print in mid-air unless supports are added.
 */
export function findIslands(g: VoxelGrid): Island[] {
  const islands: Island[] = [];
  const { nx, ny } = g;
  const label = new Int32Array(nx * ny);
  for (let z = 1; z < g.nz; z++) {
    label.fill(0);
    let next = 1;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!g.data[vIndex(g, x, y, z)] || label[x + nx * y]) continue;
        // flood fill this connected region (8-neighbourhood)
        const stack = [x + nx * y];
        label[x + nx * y] = next;
        let supported = false, cnt = 0, cx = 0, cy = 0;
        let mnx = x, mxx = x, mny = y, mxy = y;
        while (stack.length) {
          const i = stack.pop()!;
          const ix = i % nx, iy = (i - ix) / nx;
          cnt++; cx += ix; cy += iy;
          if (ix < mnx) mnx = ix; if (ix > mxx) mxx = ix; if (iy < mny) mny = iy; if (iy > mxy) mxy = iy;
          if (!supported) {
            for (let dy = -1; dy <= 1 && !supported; dy++) for (let dx = -1; dx <= 1; dx++) {
              const qx = ix + dx, qy = iy + dy;
              if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
              if (g.data[vIndex(g, qx, qy, z - 1)]) { supported = true; break; }
            }
          }
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const qx = ix + dx, qy = iy + dy;
            if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
            const j = qx + nx * qy;
            if (!label[j] && g.data[vIndex(g, qx, qy, z)]) { label[j] = next; stack.push(j); }
          }
        }
        next++;
        if (!supported) {
          const c = voxelCenter(g, cx / cnt, cy / cnt, z);
          islands.push({
            layer: z,
            z: +(z * g.size).toFixed(2),
            area: +(cnt * g.size * g.size).toFixed(2),
            center: [+c[0].toFixed(1), +c[1].toFixed(1), +(g.origin[2] + z * g.size).toFixed(1)],
            min: [+(g.origin[0] + mnx * g.size).toFixed(1), +(g.origin[1] + mny * g.size).toFixed(1)],
            max: [+(g.origin[0] + (mxx + 1) * g.size).toFixed(1), +(g.origin[1] + (mxy + 1) * g.size).toFixed(1)],
          });
        }
      }
    }
  }
  return islands;
}

/**
 * Greedy merge of solid voxels into axis-aligned boxes (for physics colliders).
 * Returns boxes as [x0,y0,z0,x1,y1,z1] in voxel units (end exclusive).
 */
export function greedyBoxes(g: VoxelGrid): [number, number, number, number, number, number][] {
  const used = new Uint8Array(g.data.length);
  const boxes: [number, number, number, number, number, number][] = [];
  const solid = (x: number, y: number, z: number) => g.data[vIndex(g, x, y, z)] && !used[vIndex(g, x, y, z)];
  for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    if (!solid(x, y, z)) continue;
    let x1 = x + 1;
    while (x1 < g.nx && solid(x1, y, z)) x1++;
    let y1 = y + 1;
    grow: while (y1 < g.ny) {
      for (let i = x; i < x1; i++) if (!solid(i, y1, z)) break grow;
      y1++;
    }
    let z1 = z + 1;
    growZ: while (z1 < g.nz) {
      for (let j = y; j < y1; j++) for (let i = x; i < x1; i++) if (!solid(i, j, z1)) break growZ;
      z1++;
    }
    for (let k = z; k < z1; k++) for (let j = y; j < y1; j++) for (let i = x; i < x1; i++) used[vIndex(g, i, j, k)] = 1;
    boxes.push([x, y, z, x1, y1, z1]);
  }
  return boxes;
}
