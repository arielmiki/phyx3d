// Runs the phyx3d core off the main thread so the viewer stays smooth.
import {
  loadFile, analyze, checkStrength, suggestOrientations, dropTest, tiltTest, pushTest, stackTest, checkGcode, scanUnsupported, Part, simulateMechanism,
  type Mesh, type PartOptions, type LoadCase, type CheckResult, type MechSpec,
} from "../../src/core/index.js";

const meshes = new Map<number, Mesh>();
let nextId = 1;

type Req =
  | { type: "load"; name: string; bytes: ArrayBuffer }
  | { type: "analyze"; meshId: number; opts: PartOptions }
  | { type: "stress"; meshId: number; opts: PartOptions; load: LoadCase & { pickPrint?: [number, number, number]; pickRadius?: number; pickForce?: [number, number, number] }; elements: number }
  | { type: "physics"; meshId: number; opts: PartOptions; scenario: "drop" | "tilt" | "push" | "stack"; params: Record<string, number | string> }
  | { type: "orient"; meshId: number; opts: PartOptions }
  | { type: "mechanism"; spec: MechSpec; files: Record<string, ArrayBuffer>; duration?: number };

self.onmessage = async (ev: MessageEvent<{ id: number; req: Req }>) => {
  const { id, req } = ev.data;
  try {
    const res = await handle(req);
    (self as unknown as Worker).postMessage({ id, ok: true, res: res.data }, res.transfer ?? []);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (e as Error).message });
  }
};

async function handle(req: Req): Promise<{ data: unknown; transfer?: Transferable[] }> {
  switch (req.type) {
    case "load": {
      const f = loadFile(req.name, new Uint8Array(req.bytes));
      let meshId: number | undefined;
      if (f.mesh) { meshId = nextId++; meshes.set(meshId, f.mesh); }
      const info = (f.meta.sliceInfo as { plates?: { predictionSeconds?: number; weightGrams?: number }[] } | undefined)?.plates?.[0];
      const gcheck: CheckResult | undefined = f.gcode ? checkGcode(f.gcode, info) : undefined;
      const g = f.gcode;
      const gflags = g ? scanUnsupported(g).flags : undefined;
      return {
        data: {
          name: f.name,
          meshId,
          meta: { plate: f.meta.plate, plates: f.meta.plates },
          gcode: g && { segments: g.segments, extruding: g.extruding, feature: g.feature, features: g.features, layers: g.layers, stats: g.stats },
          gcheck,
          gflags,
        },
        transfer: g ? [g.segments.buffer, g.extruding.buffer, g.feature.buffer, gflags!.buffer] : [],
      };
    }
    case "analyze": {
      const mesh = need(req.meshId);
      const { report, part } = analyze(mesh, req.opts);
      const positions = new Float32Array(part.mesh.positions);
      const indices = new Uint32Array(part.mesh.indices);
      return {
        data: { report, positions, indices, com: part.mass.centerOfMass, lift: part.lift, rotation: part.rotation, bbox: part.bbox, grams: part.estimateGrams().grams },
        transfer: [positions.buffer, indices.buffer],
      };
    }
    case "stress": {
      const part = new Part(need(req.meshId), req.opts);
      const lc: LoadCase = { fixed: req.load.fixed, loads: [...req.load.loads], acceleration: req.load.acceleration };
      if (req.load.pickPrint) {
        // picked in print pose → convert to design coordinates for the solver
        lc.loads.push({ region: { sphere: { center: part.toDesign(req.load.pickPrint), radius: req.load.pickRadius ?? 4 } }, force: req.load.pickForce ?? [0, 0, -10] });
      }
      const s = checkStrength(part, lc, { elements: req.elements });
      const { fea, ...check } = s;
      const g = fea.grid;
      return {
        data: { check, grid: { origin: g.origin, size: g.size, nx: g.nx, ny: g.ny, nz: g.nz }, elements: fea.elements, safety: fea.safety, rotation: part.rotation, lift: part.lift },
        transfer: [fea.elements.buffer, fea.safety.buffer],
      };
    }
    case "physics": {
      const part = new Part(need(req.meshId), req.opts);
      const p = req.params;
      const rec = { record: true };
      const r =
        req.scenario === "drop" ? await dropTest(part, { height: +p.height, floor: p.floor as "tile", trials: 6, ...rec })
          : req.scenario === "tilt" ? await tiltTest(part, { directions: 8, ...rec })
            : req.scenario === "push" ? await pushTest(part, {})
              : await stackTest(part, { count: +p.count, ...rec });
      return { data: { result: r, com: part.mass.centerOfMass } };
    }
    case "orient":
      return { data: suggestOrientations(need(req.meshId), req.opts).slice(0, 6) };
    case "mechanism": {
      const find = (name: string) => {
        const base = name.split(/[\\/]/).pop()!;
        const buf = req.files[name] ?? req.files[base];
        if (!buf) throw new Error(`Missing part file "${name}" — open it together with the .mech.json`);
        return new Uint8Array(buf);
      };
      const out = await simulateMechanism(req.spec, find, { record: true, duration: req.duration });
      const parts = out.parts.map((p) => ({ id: p.id, positions: p.mesh.positions, indices: p.mesh.indices, color: p.color }));
      return { data: { check: out.check, parts, frames: out.frames, floor: req.spec.environment?.floor !== false } };
    }
  }
}

function need(id: number): Mesh {
  const m = meshes.get(id);
  if (!m) throw new Error("Model not loaded");
  return m;
}
