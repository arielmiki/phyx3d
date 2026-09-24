// Headless software renderer → PNG. Lets an agent (or a CI job) *see* the part with problem
// areas coloured in, without a GPU or browser.
import { type Mesh, bbox, faceNormals, triCount, type Vec3 } from "./mesh.js";
import { encodePNG } from "./png.js";

export type ViewName = "iso" | "iso-back" | "below" | "front" | "back" | "left" | "right" | "top";
export type RGB = [number, number, number];

export interface Marker { at: Vec3; color: RGB; label?: string; size?: number }
export interface Polyline { points: Vec3[]; color: RGB; closed?: boolean; width?: number }

export interface RenderOptions {
  /** size of each view in pixels */
  width?: number;
  height?: number;
  views?: ViewName[];
  /** per-face RGB 0..255 (3 per triangle); default neutral grey-blue */
  faceColors?: Uint8Array;
  /** per-pixel colour from the surface point (world mm) and face index — overrides faceColors */
  pointColor?: (x: number, y: number, z: number, face: number) => RGB;
  markers?: Marker[];
  lines?: Polyline[];
  title?: string;
  legend?: { color: RGB; label: string }[];
  /** draw a checkered build plate under the part (default true) */
  bed?: boolean;
  /** fixed framing box (instead of the mesh bbox) — keeps the camera still across animation frames */
  fit?: { min: Vec3; max: Vec3 };
  /** text in the corner of each view (default: view name) */
  label?: string;
  /** z of the ground plane (default: lowest point) */
  groundZ?: number;
}

const VIEW_DIRS: Record<ViewName, { dir: Vec3; up: Vec3 }> = {
  iso: { dir: [-1, 1, -0.8], up: [0, 0, 1] }, // camera at front-right-above looking in
  "iso-back": { dir: [1, -1, -0.8], up: [0, 0, 1] },
  below: { dir: [-1, 1, 0.9], up: [0, 0, 1] }, // from below: shows overhang undersides
  front: { dir: [0, 1, 0], up: [0, 0, 1] },
  back: { dir: [0, -1, 0], up: [0, 0, 1] },
  left: { dir: [1, 0, 0], up: [0, 0, 1] },
  right: { dir: [-1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, -1], up: [0, 1, 0] },
};

export const BASE_COLOR: RGB = [150, 170, 196];

class Canvas {
  readonly px: Uint8ClampedArray;
  constructor(readonly w: number, readonly h: number, bg: RGB = [250, 250, 252]) {
    this.px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { this.px[i * 4] = bg[0]; this.px[i * 4 + 1] = bg[1]; this.px[i * 4 + 2] = bg[2]; this.px[i * 4 + 3] = 255; }
  }
  set(x: number, y: number, c: RGB, a = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    this.px[o] = this.px[o] * (1 - a) + c[0] * a;
    this.px[o + 1] = this.px[o + 1] * (1 - a) + c[1] * a;
    this.px[o + 2] = this.px[o + 2] * (1 - a) + c[2] * a;
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1) {
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(this.h, y + h); j++) for (let i = Math.max(0, Math.floor(x)); i < Math.min(this.w, x + w); i++) this.set(i, j, c, a);
  }
  circle(cx: number, cy: number, r: number, c: RGB, outline: RGB = [20, 20, 20]) {
    for (let y = -r - 2; y <= r + 2; y++) for (let x = -r - 2; x <= r + 2; x++) {
      const d = Math.hypot(x, y);
      if (d <= r) this.set(cx + x, cy + y, c);
      else if (d <= r + 1.8) this.set(cx + x, cy + y, outline);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, width = 1) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 0;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (width <= 1) this.set(x, y, c);
      else this.rect(x - width / 2, y - width / 2, width, width, c);
    }
  }
  text(x: number, y: number, s: string, c: RGB = [30, 30, 40], scale = 2, bg?: RGB) {
    const w = textWidth(s, scale);
    if (bg) this.rect(x - 3, y - 3, w + 6, 7 * scale + 6, bg, 0.85);
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT["?"];
      for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
        if (g[row] & (1 << (4 - col))) this.rect(cx + col * scale, y + row * scale, scale, scale, c);
      }
      cx += 6 * scale;
    }
  }
  blit(src: Canvas, ox: number, oy: number) {
    for (let y = 0; y < src.h; y++) {
      const ty = oy + y;
      if (ty < 0 || ty >= this.h) continue;
      this.px.set(src.px.subarray(y * src.w * 4, (y + 1) * src.w * 4), (ty * this.w + ox) * 4);
    }
  }
}

export const textWidth = (s: string, scale = 2) => s.length * 6 * scale;

function renderView(mesh: Mesh, view: ViewName, w: number, h: number, opts: RenderOptions, normals: Float32Array): Canvas {
  const cv = new Canvas(w, h);
  const { dir: d0, up: up0 } = VIEW_DIRS[view];
  const dl = Math.hypot(...d0);
  const d: Vec3 = [d0[0] / dl, d0[1] / dl, d0[2] / dl];
  let right = cross(d, up0);
  const rl = Math.hypot(...right);
  right = [right[0] / rl, right[1] / rl, right[2] / rl];
  const camUp = cross(right, d);
  const mb = bbox(mesh);
  const b = opts.fit ? { min: opts.fit.min, max: opts.fit.max, size: [0, 1, 2].map((k) => opts.fit!.max[k] - opts.fit!.min[k]) as Vec3 } : mb;
  const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const showBed = opts.bed !== false && d[2] < 0.3;
  const margin = Math.max(8, Math.max(b.size[0], b.size[1]) * 0.12);
  const groundZ = opts.groundZ ?? b.min[2];
  const bedMin: Vec3 = [b.min[0] - margin, b.min[1] - margin, groundZ];
  const bedMax: Vec3 = [b.max[0] + margin, b.max[1] + margin, groundZ];

  // fit: project bbox corners (+ bed)
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) corners.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
  if (showBed) for (let i = 0; i < 4; i++) corners.push([i & 1 ? bedMax[0] : bedMin[0], i & 2 ? bedMax[1] : bedMin[1], groundZ]);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const c of corners) {
    const r = [c[0] - center[0], c[1] - center[1], c[2] - center[2]];
    const u = dot(r, right), v = dot(r, camUp);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const top = 30; // room for the label
  const scale = Math.min((w - 24) / Math.max(maxU - minU, 1e-6), (h - top - 16) / Math.max(maxV - minV, 1e-6));
  const cu = (minU + maxU) / 2, cvv = (minV + maxV) / 2;
  const project = (p: ArrayLike<number>): [number, number, number] => {
    const r = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
    return [w / 2 + (dot(r, right) - cu) * scale, top + (h - top) / 2 - (dot(r, camUp) - cvv) * scale, dot(r, d)];
  };

  const depth = new Float32Array(w * h).fill(Infinity);
  const faceId = new Int32Array(w * h).fill(-1);
  const light1: Vec3 = norm([-d[0] * 0.6 + 0.3, -d[1] * 0.6 + 0.2, -d[2] * 0.6 + 0.7]);

  const raster = (a: number[], bb: number[], c: number[], color: (l1: number, l2: number, l3: number) => RGB, id: number) => {
    const minx = Math.max(0, Math.floor(Math.min(a[0], bb[0], c[0])));
    const maxx = Math.min(w - 1, Math.ceil(Math.max(a[0], bb[0], c[0])));
    const miny = Math.max(0, Math.floor(Math.min(a[1], bb[1], c[1])));
    const maxy = Math.min(h - 1, Math.ceil(Math.max(a[1], bb[1], c[1])));
    const area = (bb[0] - a[0]) * (c[1] - a[1]) - (bb[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) return;
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l1 = ((bb[0] - px) * (c[1] - py) - (bb[1] - py) * (c[0] - px)) / area;
      const l2 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const z = l1 * a[2] + l2 * bb[2] + l3 * c[2];
      const i = y * w + x;
      if (z >= depth[i]) continue;
      depth[i] = z;
      faceId[i] = id;
      const col = color(l1, l2, l3);
      const o = i * 4;
      cv.px[o] = col[0]; cv.px[o + 1] = col[1]; cv.px[o + 2] = col[2];
    }
  };

  if (showBed) {
    const zb = groundZ - 0.02;
    const q = [[bedMin[0], bedMin[1], zb], [bedMax[0], bedMin[1], zb], [bedMax[0], bedMax[1], zb], [bedMin[0], bedMax[1], zb]].map(project);
    const world = (l1: number, l2: number, l3: number, A: number[], B: number[], C: number[]) => [l1 * A[0] + l2 * B[0] + l3 * C[0], l1 * A[1] + l2 * B[1] + l3 * C[1]];
    const W = [[bedMin[0], bedMin[1]], [bedMax[0], bedMin[1]], [bedMax[0], bedMax[1]], [bedMin[0], bedMax[1]]];
    const checker = (x: number, y: number): RGB => ((Math.floor(x / 10) + Math.floor(y / 10)) & 1 ? [214, 218, 224] : [228, 231, 236]);
    raster(q[0], q[1], q[2], (l1, l2, l3) => { const [x, y] = world(l1, l2, l3, W[0], W[1], W[2]); return checker(x, y); }, -2);
    raster(q[0], q[2], q[3], (l1, l2, l3) => { const [x, y] = world(l1, l2, l3, W[0], W[2], W[3]); return checker(x, y); }, -2);
  }

  const p = mesh.positions, idx = mesh.indices;
  const n = triCount(mesh);
  const fc = opts.faceColors;
  for (let t = 0; t < n; t++) {
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    const facing = nx * d[0] + ny * d[1] + nz * d[2];
    if (facing > 0.02) continue; // back face
    const A = project(p.subarray(idx[t * 3] * 3)), B = project(p.subarray(idx[t * 3 + 1] * 3)), C = project(p.subarray(idx[t * 3 + 2] * 3));
    const lam = Math.max(0, nx * light1[0] + ny * light1[1] + nz * light1[2]);
    const shade = 0.42 + 0.45 * Math.max(0, -facing) + 0.18 * lam;
    const pc = opts.pointColor;
    if (pc) {
      const ia = idx[t * 3] * 3, ib = idx[t * 3 + 1] * 3, ic = idx[t * 3 + 2] * 3;
      raster(A, B, C, (l1, l2, l3) => {
        const c = pc(l1 * p[ia] + l2 * p[ib] + l3 * p[ic], l1 * p[ia + 1] + l2 * p[ib + 1] + l3 * p[ic + 1], l1 * p[ia + 2] + l2 * p[ib + 2] + l3 * p[ic + 2], t);
        return [Math.min(255, c[0] * shade), Math.min(255, c[1] * shade), Math.min(255, c[2] * shade)];
      }, t);
      continue;
    }
    const base: RGB = fc ? [fc[t * 3], fc[t * 3 + 1], fc[t * 3 + 2]] : BASE_COLOR;
    const col: RGB = [Math.min(255, base[0] * shade), Math.min(255, base[1] * shade), Math.min(255, base[2] * shade)];
    raster(A, B, C, () => col, t);
  }

  // outline pass: crease + silhouette edges
  const edgeCol: RGB = [40, 44, 56];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const f = faceId[i];
    if (f < 0) continue;
    for (const j of [i + 1, i + w]) {
      const g = faceId[j];
      if (g === f) continue;
      let edge = false;
      if (g < 0) edge = true;
      else {
        const dn = normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2];
        edge = dn < 0.85 || Math.abs(depth[i] - depth[j]) > 2 / scale + 1.5;
      }
      if (edge) { cv.set(x, y, edgeCol, 0.8); }
    }
  }

  for (const l of opts.lines ?? []) {
    const pts = l.points.map(project);
    const m = l.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < m; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      cv.line(a[0], a[1], c[0], c[1], l.color, l.width ?? 2);
    }
  }
  for (const mk of opts.markers ?? []) {
    const [x, y] = project(mk.at);
    cv.circle(x, y, mk.size ?? 6, mk.color);
    if (mk.label) cv.text(x + (mk.size ?? 6) + 5, y - 7, mk.label, [20, 20, 30], 2, [255, 255, 255]);
  }
  cv.text(8, 8, opts.label ?? view, [80, 84, 96], 2);
  return cv;
}

export interface RenderResult { png: Uint8Array; width: number; height: number }

export function renderPNG(mesh: Mesh, opts: RenderOptions = {}): RenderResult {
  const views = opts.views ?? ["iso", "below", "front", "top"];
  const w = opts.width ?? 520, h = opts.height ?? 400;
  const cols = views.length > 1 ? 2 : 1;
  const rows = Math.ceil(views.length / cols);
  const header = opts.title ? 40 : 0;
  const legendRows = opts.legend?.length ? Math.ceil(opts.legend.length / 3) : 0;
  const footer = legendRows ? legendRows * 28 + 12 : 0;
  const W = cols * w, H = header + rows * h + footer;
  const out = new Canvas(W, H, [255, 255, 255]);
  const { normals } = faceNormals(mesh);
  views.forEach((v, i) => {
    const c = renderView(mesh, v, w - 4, h - 4, opts, normals);
    out.blit(c, (i % cols) * w + 2, header + Math.floor(i / cols) * h + 2);
  });
  if (opts.title) out.text(10, 12, opts.title.slice(0, Math.floor((W - 20) / 12)), [20, 24, 36], 2);
  (opts.legend ?? []).forEach((l, i) => {
    const x = 12 + (i % 3) * Math.floor(W / 3), y = header + rows * h + 10 + Math.floor(i / 3) * 28;
    out.rect(x, y, 18, 18, l.color);
    out.text(x + 26, y + 2, l.label.slice(0, Math.floor(W / 3 / 12) - 3), [30, 34, 46], 2);
  });
  return { png: encodePNG(W, H, out.px), width: W, height: H };
}

/** Several meshes (e.g. animation keyframes) in a grid, one fixed camera. */
export function renderScenes(
  scenes: { mesh: Mesh; faceColors?: Uint8Array; label: string; lines?: Polyline[]; markers?: Marker[]; fit?: { min: Vec3; max: Vec3 } }[],
  opts: { view?: ViewName; width?: number; height?: number; cols?: number; title?: string; fit?: { min: Vec3; max: Vec3 }; groundZ?: number; legend?: { color: RGB; label: string }[] } = {},
): RenderResult {
  const w = opts.width ?? 360, h = opts.height ?? 300;
  const cols = Math.min(opts.cols ?? 3, scenes.length);
  const rows = Math.ceil(scenes.length / cols);
  const header = opts.title ? 40 : 0;
  const legendRows = opts.legend?.length ? Math.ceil(opts.legend.length / 3) : 0;
  const footer = legendRows ? legendRows * 28 + 12 : 0;
  const out = new Canvas(cols * w, header + rows * h + footer, [255, 255, 255]);
  scenes.forEach((sc, i) => {
    const { normals } = faceNormals(sc.mesh);
    const c = renderView(sc.mesh, opts.view ?? "iso", w - 4, h - 4, { faceColors: sc.faceColors, fit: sc.fit ?? opts.fit, groundZ: opts.groundZ, label: sc.label, lines: sc.lines, markers: sc.markers }, normals);
    out.blit(c, (i % cols) * w + 2, header + Math.floor(i / cols) * h + 2);
  });
  if (opts.title) out.text(10, 12, opts.title.slice(0, Math.floor((cols * w - 20) / 12)), [20, 24, 36], 2);
  (opts.legend ?? []).forEach((l, i) => {
    const x = 12 + (i % 3) * Math.floor((cols * w) / 3), y = header + rows * h + 10 + Math.floor(i / 3) * 28;
    out.rect(x, y, 18, 18, l.color);
    out.text(x + 26, y + 2, l.label.slice(0, Math.floor((cols * w) / 3 / 12) - 3), [30, 34, 46], 2);
  });
  return { png: encodePNG(out.w, out.h, out.px), width: out.w, height: out.h };
}

// ---------- colour helpers ----------

export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  t = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Safety-factor colour ramp: red (<1) → orange → yellow (2) → green (≥3) */
export function safetyColor(sf: number): RGB {
  if (sf < 1) return [220, 40, 40];
  if (sf < 1.5) return lerpColor([230, 90, 30], [240, 160, 30], (sf - 1) / 0.5);
  if (sf < 2) return lerpColor([240, 160, 30], [235, 215, 60], (sf - 1.5) / 0.5);
  if (sf < 3) return lerpColor([235, 215, 60], [110, 190, 90], sf - 2);
  return lerpColor([110, 190, 90], [120, 160, 200], Math.min(1, (sf - 3) / 5));
}

function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: ArrayLike<number>, b: ArrayLike<number>): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a: Vec3): Vec3 { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// 5×7 bitmap font (rows top→bottom, 5 bits each)
const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12],
  " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12], "-": [0, 0, 0, 31, 0, 0, 0], ":": [0, 12, 12, 0, 12, 12, 0],
  ">": [8, 4, 2, 1, 2, 4, 8], "<": [2, 4, 8, 16, 8, 4, 2], "%": [24, 25, 2, 4, 8, 19, 3], "/": [0, 1, 2, 4, 8, 16, 0],
  "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8], "=": [0, 0, 31, 0, 31, 0, 0], "+": [0, 4, 4, 31, 4, 4, 0],
  ",": [0, 0, 0, 0, 12, 4, 8], "°": [12, 18, 18, 12, 0, 0, 0], "?": [14, 17, 1, 2, 4, 0, 4], "_": [0, 0, 0, 0, 0, 0, 31],
  "×": [0, 17, 10, 4, 10, 17, 0], "≥": [8, 4, 2, 4, 8, 0, 31], "≤": [2, 4, 8, 4, 2, 0, 31], "#": [10, 10, 31, 10, 31, 10, 10],
};
