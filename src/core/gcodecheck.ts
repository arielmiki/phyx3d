// Checks on sliced G-code: stats, first layer, extrusion printed into thin air.
import type { GcodeModel } from "./gcode.js";
import { type CheckResult, type Finding, r1, r2 } from "./report.js";
import { formatDuration } from "./printability.js";

/** Per-segment flags: 1 = extrusion with nothing printed below it (bridges/supports excluded). */
export function scanUnsupported(g: GcodeModel, cell = 0.5): { flags: Uint8Array; layers: { layer: number; z: number; mm: number; at: [number, number, number] }[]; firstLayerMm: number } {
  const flags = new Uint8Array(g.extruding.length);
  const layers: { layer: number; z: number; mm: number; at: [number, number, number] }[] = [];
  const s = g.segments;
  let prev: Set<number> | null = null;
  let firstLayerMm = 0;
  const key = (x: number, y: number) => Math.floor(x / cell) * 100000 + Math.floor(y / cell);
  for (let li = 0; li < g.layers.length; li++) {
    const L = g.layers[li];
    const cur = new Set<number>();
    let bad = 0, bx = 0, by = 0, bn = 0;
    for (let i = L.start; i < L.end; i++) {
      if (!g.extruding[i]) continue;
      const x0 = s[i * 6], y0 = s[i * 6 + 1], x1 = s[i * 6 + 3], y1 = s[i * 6 + 4];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (li === 0) firstLayerMm += len;
      const n = Math.max(1, Math.ceil(len / cell));
      const feat = g.features[g.feature[i]] ?? "";
      const allowed = /bridge|support|brim|skirt|prime|wipe|purge/i.test(feat);
      let segBad = 0;
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
        cur.add(key(x, y));
        if (prev && !allowed) {
          let ok = false;
          for (let dx = -1; dx <= 1 && !ok; dx++) for (let dy = -1; dy <= 1; dy++) if (prev.has(key(x + dx * cell, y + dy * cell))) { ok = true; break; }
          if (!ok) { segBad++; bad += len / (n + 1); bx += x; by += y; bn++; }
        }
      }
      if (segBad > (n + 1) / 2) flags[i] = 1;
    }
    if (bad > 2) layers.push({ layer: li + 1, z: r2(L.z), mm: r1(bad), at: [r1(bx / bn), r1(by / bn), r2(L.z)] });
    prev = cur;
  }
  return { flags, layers, firstLayerMm };
}

export function checkGcode(g: GcodeModel, sliceInfo?: { predictionSeconds?: number; weightGrams?: number }): CheckResult {
  const findings: Finding[] = [];
  const scan = scanUnsupported(g);
  const unsupported = scan.layers;
  const firstLayerMm = scan.firstLayerMm;
  const totalBad = unsupported.reduce((a, u) => a + u.mm, 0);
  for (const u of unsupported.slice(0, 8)) findings.push({ status: u.mm > 20 ? "fail" : "warn", message: `Layer ${u.layer} (z=${u.z}): ${u.mm} mm of extrusion with nothing below near (${u.at[0]}, ${u.at[1]}).`, at: u.at });
  const secs = sliceInfo?.predictionSeconds ?? g.stats.estimatedSeconds;
  const grams = sliceInfo?.weightGrams ?? g.stats.filamentGrams ?? (g.stats.filamentMm * Math.PI * 0.875 ** 2 * 1.24) / 1000;
  const hasSupport = g.features.some((f) => /support/i.test(f));
  const status = totalBad > 50 ? "fail" : totalBad > 5 ? "warn" : "pass";
  findings.unshift({ status: "info", message: `${g.stats.layers} layers, ${formatDuration(secs)}, ${r1(grams)} g filament${hasSupport ? ", includes supports" : ""}.` });
  return {
    id: "gcode",
    title: "Sliced G-code",
    status,
    summary: status === "pass"
      ? `Toolpath OK: ${g.stats.layers} layers, ${formatDuration(secs)}, ${r1(grams)} g.`
      : `${r1(totalBad)} mm of extrusion printed over air across ${unsupported.length} layer(s) — add supports or change the design.`,
    accuracy: sliceInfo?.predictionSeconds ? "exact" : "estimate",
    findings,
    fixes: status === "pass" ? [] : ["Enable supports in Bambu Studio (Support → Enable, type tree(auto)) for the listed layers, or redesign the overhang."],
    data: {
      layers: g.stats.layers,
      seconds: Math.round(secs),
      grams: r1(grams),
      filamentMm: g.stats.filamentMm,
      firstLayerMm: r1(firstLayerMm),
      features: g.features.filter((f) => f !== "Unknown"),
      hasSupport,
      unsupported: unsupported.slice(0, 50),
      bounds: g.stats.bounds,
    },
  };
}
