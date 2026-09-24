// Streaming-ish G-code parser tuned for Bambu Studio / Orca / Prusa output.

export interface GcodeLayer {
  z: number;
  /** layer thickness (z minus previous layer z) */
  height: number;
  /** first segment index in this layer (inclusive) */
  start: number;
  /** last segment index (exclusive) */
  end: number;
}

export interface GcodeModel {
  /** x0 y0 z0 x1 y1 z1 per segment */
  segments: Float32Array;
  /** 1 = extruding, 0 = travel */
  extruding: Uint8Array;
  /** index into `features` */
  feature: Uint8Array;
  /** mm/min */
  feedrate: Float32Array;
  features: string[];
  layers: GcodeLayer[];
  stats: {
    segments: number;
    layers: number;
    filamentMm: number;
    travelMm: number;
    extrudeMm: number;
    /** from the slicer header when present, else rough kinematic estimate */
    estimatedSeconds: number;
    estimateSource: "slicer" | "phyx3d-rough";
    filamentGrams?: number;
    bounds: { min: [number, number, number]; max: [number, number, number] };
  };
  header: Record<string, string>;
}

const FEATURE_PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^;\s*FEATURE:\s*(.+)$/i, (m) => m[1].trim()], // Bambu Studio / Orca
  [/^;\s*TYPE:\s*(.+)$/i, (m) => m[1].trim()], // Prusa / Cura / Orca
];

export function parseGcode(text: string): GcodeModel {
  const segs: number[] = [];
  const ext: number[] = [];
  const feat: number[] = [];
  const feeds: number[] = [];
  const features: string[] = ["Unknown"];
  const featureIdx = new Map<string, number>([["Unknown", 0]]);
  let curFeature = 0;
  const header: Record<string, string> = {};

  let x = 0, y = 0, z = 0, e = 0, f = 3000;
  let absXYZ = true, absE = true;
  let filament = 0, travel = 0, extrudeLen = 0, roughTime = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const layers: GcodeLayer[] = [];
  let layerZ = -Infinity;

  const addSeg = (x1: number, y1: number, z1: number, de: number) => {
    const len = Math.hypot(x1 - x, y1 - y, z1 - z);
    if (len < 1e-6) return;
    const isExt = de > 1e-6;
    if (isExt) {
      if (z1 > layerZ + 1e-3) {
        if (layers.length) layers[layers.length - 1].end = segs.length / 6;
        const prevZ = layers.length ? layers[layers.length - 1].z : 0;
        layers.push({ z: z1, height: +(z1 - prevZ).toFixed(4), start: segs.length / 6, end: segs.length / 6 });
        layerZ = z1;
      }
      extrudeLen += len;
      filament += de;
      if (x1 < min[0]) min[0] = x1; if (y1 < min[1]) min[1] = y1; if (z1 < min[2]) min[2] = z1;
      if (x1 > max[0]) max[0] = x1; if (y1 > max[1]) max[1] = y1; if (z1 > max[2]) max[2] = z1;
    } else travel += len;
    roughTime += len / Math.max(f / 60, 1);
    segs.push(x, y, z, x1, y1, z1);
    ext.push(isExt ? 1 : 0);
    feat.push(curFeature);
    feeds.push(f);
  };

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === ";") {
      for (const [re, get] of FEATURE_PATTERNS) {
        const m = re.exec(line);
        if (m) {
          const name = get(m);
          let i = featureIdx.get(name);
          if (i === undefined) { i = features.length; features.push(name); featureIdx.set(name, i); }
          curFeature = i;
        }
      }
      const te = /total estimated time:\s*([^;]+)/i.exec(line);
      if (te) header["total estimated time"] = te[1].trim();
      const kv = /^;\s*([^:=]{3,60}?)\s*[:=]\s*(.+)$/.exec(line);
      if (kv && Object.keys(header).length < 400) header[kv[1].trim().toLowerCase()] = kv[2].trim();
      continue;
    }
    const code = line.split(";")[0].trim();
    const words = code.toUpperCase().match(/[A-Z][-+]?[\d.]*/g);
    if (!words) continue;
    const cmd = words[0];
    const p: Record<string, number> = {};
    for (let i = 1; i < words.length; i++) p[words[i][0]] = parseFloat(words[i].slice(1));
    switch (cmd) {
      case "G0":
      case "G1": {
        if (p.F !== undefined && !isNaN(p.F)) f = p.F;
        const nx = p.X === undefined ? x : absXYZ ? p.X : x + p.X;
        const ny = p.Y === undefined ? y : absXYZ ? p.Y : y + p.Y;
        const nz = p.Z === undefined ? z : absXYZ ? p.Z : z + p.Z;
        let de = 0;
        if (p.E !== undefined) { de = absE ? p.E - e : p.E; e = absE ? p.E : e + p.E; }
        addSeg(nx, ny, nz, de);
        x = nx; y = ny; z = nz;
        break;
      }
      case "G2":
      case "G3": {
        if (p.F !== undefined) f = p.F;
        const nx = p.X === undefined ? x : absXYZ ? p.X : x + p.X;
        const ny = p.Y === undefined ? y : absXYZ ? p.Y : y + p.Y;
        const nz = p.Z === undefined ? z : absXYZ ? p.Z : z + p.Z;
        let de = 0;
        if (p.E !== undefined) { de = absE ? p.E - e : p.E; e = absE ? p.E : e + p.E; }
        const cx = x + (p.I ?? 0), cy = y + (p.J ?? 0);
        const r = Math.hypot(x - cx, y - cy);
        const a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
        const cw = cmd === "G2";
        let sweep = a1 - a0;
        if (cw && sweep >= 0) sweep -= Math.PI * 2;
        if (!cw && sweep <= 0) sweep += Math.PI * 2;
        const n = Math.max(2, Math.ceil((Math.abs(sweep) * r) / 0.5));
        const z0 = z;
        for (let i = 1; i <= n; i++) {
          const a = a0 + (sweep * i) / n;
          const px = i === n ? nx : cx + r * Math.cos(a), py = i === n ? ny : cy + r * Math.sin(a);
          const pz = z0 + ((nz - z0) * i) / n;
          addSeg(px, py, pz, de / n);
          x = px; y = py; z = pz;
        }
        break;
      }
      case "G90": absXYZ = true; absE = true; break;
      case "G91": absXYZ = false; absE = false; break;
      case "M82": absE = true; break;
      case "M83": absE = false; break;
      case "G92": if (p.E !== undefined) e = p.E; break;
    }
  }
  if (layers.length) layers[layers.length - 1].end = segs.length / 6;

  const slicerTime = parseDuration(
    header["total estimated time"] ?? header["estimated printing time (normal mode)"] ?? header["model printing time"],
  );
  const grams = parseFloat(header["total filament weight [g]"] ?? header["filament used [g]"] ?? "");
  return {
    segments: new Float32Array(segs),
    extruding: new Uint8Array(ext),
    feature: new Uint8Array(feat),
    feedrate: new Float32Array(feeds),
    features,
    layers,
    stats: {
      segments: ext.length,
      layers: layers.length,
      filamentMm: +filament.toFixed(1),
      travelMm: +travel.toFixed(1),
      extrudeMm: +extrudeLen.toFixed(1),
      estimatedSeconds: Math.round(slicerTime ?? roughTime * 1.15),
      estimateSource: slicerTime ? "slicer" : "phyx3d-rough",
      filamentGrams: isNaN(grams) ? undefined : grams,
      bounds: { min, max },
    },
    header,
  };
}

/** "1h 2m 3s", "1d 2h", "23m 5s" → seconds */
export function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  // Bambu puts two values on one line: "model printing time: 23m 5s; total estimated time: 29m 18s"
  const part = s.split(";")[0];
  let total = 0, hit = false;
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(part))) {
    hit = true;
    total += +m[1] * { d: 86400, h: 3600, m: 60, s: 1 }[m[2] as "d" | "h" | "m" | "s"];
  }
  return hit ? total : undefined;
}
