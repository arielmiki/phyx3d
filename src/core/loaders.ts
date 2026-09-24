// File loaders: STL (binary/ASCII), 3MF (incl. Bambu Studio projects), G-code, Bambu .gcode.3mf
import { unzipSync, strFromU8 } from "fflate";
import { type Mesh, weld, mergeMeshes } from "./mesh.js";
import { parseGcode, type GcodeModel } from "./gcode.js";

export interface LoadedFile {
  name: string;
  /** solid shape, if the file contains one */
  mesh?: Mesh;
  /** toolpath, if the file contains sliced G-code */
  gcode?: GcodeModel;
  /** extra info (Bambu slice_info, plate number, …) */
  meta: Record<string, unknown>;
}

export function loadFile(name: string, data: Uint8Array): LoadedFile {
  const lower = name.toLowerCase();
  if (lower.endsWith(".stl")) return { name, mesh: parseSTL(data), meta: {} };
  if (lower.endsWith(".gcode") || lower.endsWith(".gco") || lower.endsWith(".g")) {
    return { name, gcode: parseGcode(strFromU8(data)), meta: {} };
  }
  if (lower.endsWith(".3mf")) return load3MF(name, data);
  // sniff: zip → 3MF, "solid"/binary → STL
  if (data[0] === 0x50 && data[1] === 0x4b) return load3MF(name, data);
  return { name, mesh: parseSTL(data), meta: {} };
}

// ---------------- STL ----------------

export function parseSTL(data: Uint8Array): Mesh {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === data.byteLength) return parseBinarySTL(dv, n);
  }
  const text = strFromU8(data);
  if (/^\s*solid/.test(text) && text.includes("facet")) return parseAsciiSTL(text);
  if (data.byteLength >= 84) return parseBinarySTL(dv, Math.floor((data.byteLength - 84) / 50));
  throw new Error("Not a valid STL file");
}

function parseBinarySTL(dv: DataView, n: number): Mesh {
  const soup = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12; // skip normal
    for (let k = 0; k < 9; k++) soup[t * 9 + k] = dv.getFloat32(o + k * 4, true);
  }
  return weld(soup);
}

function parseAsciiSTL(text: string): Mesh {
  const soup: number[] = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) soup.push(+m[1], +m[2], +m[3]);
  return weld(soup);
}

export function writeBinarySTL(mesh: Mesh): Uint8Array {
  const n = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const p = mesh.positions, idx = mesh.indices;
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    const vs = [a, b, c];
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) dv.setFloat32(o + 12 + k * 12 + j * 4, p[vs[k] + j], true);
  }
  return new Uint8Array(buf);
}

// ---------------- 3MF ----------------

type Mat = number[]; // 12 numbers, 3MF row-major affine: x' = x*m0 + y*m3 + z*m6 + m9 …

const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(s: string | undefined): Mat {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 ? v : IDENTITY;
}

/** a then b */
function mul(a: Mat, b: Mat): Mat {
  const r = new Array(12).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      let s = i === 3 ? b[9 + j] : 0;
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      r[i * 3 + j] = s;
    }
  }
  return r;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}

interface ModelObject {
  mesh?: { v: number[]; t: number[] };
  components: { objectid: string; path?: string; transform: Mat }[];
}

function parseModelXml(xml: string): { objects: Map<string, ModelObject>; items: { objectid: string; transform: Mat }[] } {
  const objects = new Map<string, ModelObject>();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(xml))) {
    const a = attrs(m[1]);
    const body = m[2];
    const obj: ModelObject = { components: [] };
    if (body.includes("<mesh")) {
      const v: number[] = [];
      const t: number[] = [];
      const vRe = /<vertex\b([^>]*)\/>/g;
      let vm: RegExpExecArray | null;
      while ((vm = vRe.exec(body))) {
        const va = attrs(vm[1]);
        v.push(+va.x, +va.y, +va.z);
      }
      const tRe = /<triangle\b([^>]*)\/>/g;
      while ((vm = tRe.exec(body))) {
        const ta = attrs(vm[1]);
        t.push(+ta.v1, +ta.v2, +ta.v3);
      }
      obj.mesh = { v, t };
    }
    const cRe = /<component\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(body))) {
      const ca = attrs(cm[1]);
      obj.components.push({ objectid: ca.objectid, path: ca["p:path"], transform: parseTransform(ca.transform) });
    }
    objects.set(a.id, obj);
  }
  const items: { objectid: string; transform: Mat }[] = [];
  const buildMatch = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
  if (buildMatch) {
    const iRe = /<item\b([^>]*)\/>/g;
    let im: RegExpExecArray | null;
    while ((im = iRe.exec(buildMatch[1]))) {
      const ia = attrs(im[1]);
      if (ia.printable === "0") continue;
      items.push({ objectid: ia.objectid, transform: parseTransform(ia.transform) });
    }
  }
  return { objects, items };
}

function load3MF(name: string, data: Uint8Array): LoadedFile {
  const files = unzipSync(data);
  const meta: Record<string, unknown> = {};
  let gcode: GcodeModel | undefined;

  // Bambu Studio sliced plate: Metadata/plate_N.gcode
  const gcodeNames = Object.keys(files).filter((f) => /Metadata\/plate_\d+\.gcode$/i.test(f)).sort();
  if (gcodeNames.length) {
    gcode = parseGcode(strFromU8(files[gcodeNames[0]]));
    meta.plate = gcodeNames[0].match(/plate_(\d+)/)![1];
    meta.plates = gcodeNames.length;
  }
  const sliceInfo = files["Metadata/slice_info.config"];
  if (sliceInfo) meta.sliceInfo = parseSliceInfo(strFromU8(sliceInfo));

  // shape
  const models = new Map<string, ReturnType<typeof parseModelXml>>();
  for (const f of Object.keys(files)) {
    if (f.toLowerCase().endsWith(".model")) models.set("/" + f.replace(/^\//, ""), parseModelXml(strFromU8(files[f])));
  }
  const rootPath = [...models.keys()].find((k) => /\/3D\/3dmodel\.model$/i.test(k)) ?? [...models.keys()][0];
  let mesh: Mesh | undefined;
  if (rootPath) {
    const parts: Mesh[] = [];
    const root = models.get(rootPath)!;
    const emit = (path: string, id: string, tf: Mat, depth: number) => {
      if (depth > 16) return;
      const obj = models.get(path)?.objects.get(id);
      if (!obj) return;
      if (obj.mesh && obj.mesh.t.length) {
        const soup = new Float32Array(obj.mesh.t.length * 3);
        const v = obj.mesh.v;
        for (let i = 0; i < obj.mesh.t.length; i++) {
          const vi = obj.mesh.t[i] * 3;
          const x = v[vi], y = v[vi + 1], z = v[vi + 2];
          soup[i * 3] = x * tf[0] + y * tf[3] + z * tf[6] + tf[9];
          soup[i * 3 + 1] = x * tf[1] + y * tf[4] + z * tf[7] + tf[10];
          soup[i * 3 + 2] = x * tf[2] + y * tf[5] + z * tf[8] + tf[11];
        }
        parts.push(weld(soup));
      }
      for (const c of obj.components) emit(c.path ?? path, c.objectid, mul(c.transform, tf), depth + 1);
    };
    for (const it of root.items) emit(rootPath, it.objectid, it.transform, 0);
    if (parts.length) mesh = mergeMeshes(parts);
  }
  if (!mesh && !gcode) throw new Error(`${name}: no mesh or G-code found in 3MF`);
  return { name, mesh, gcode, meta };
}

export interface SliceInfo {
  plates: { index: number; predictionSeconds?: number; weightGrams?: number; filaments: { type?: string; color?: string; usedGrams?: number; usedMeters?: number }[] }[];
}

function parseSliceInfo(xml: string): SliceInfo {
  const plates: SliceInfo["plates"] = [];
  const pRe = /<plate>([\s\S]*?)<\/plate>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(xml))) {
    const body = m[1];
    const md: Record<string, string> = {};
    const mRe = /<metadata\b([^>]*)\/>/g;
    let mm: RegExpExecArray | null;
    while ((mm = mRe.exec(body))) {
      const a = attrs(mm[1]);
      if (a.key) md[a.key] = a.value;
    }
    const filaments: SliceInfo["plates"][number]["filaments"] = [];
    const fRe = /<filament\b([^>]*)\/>/g;
    while ((mm = fRe.exec(body))) {
      const a = attrs(mm[1]);
      filaments.push({ type: a.type, color: a.color, usedGrams: a.used_g ? +a.used_g : undefined, usedMeters: a.used_m ? +a.used_m : undefined });
    }
    plates.push({
      index: md.index ? +md.index : plates.length + 1,
      predictionSeconds: md.prediction ? +md.prediction : undefined,
      weightGrams: md.weight ? +md.weight : undefined,
      filaments,
    });
  }
  return { plates };
}
