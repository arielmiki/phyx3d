import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { box, massProps } from "../src/core/mesh.js";
import { loadFile, writeBinarySTL, parseSTL } from "../src/core/loaders.js";
import { parseGcode, parseDuration } from "../src/core/gcode.js";
import { checkGcode } from "../src/core/gcodecheck.js";

function model3mf(): string {
  const m = box(10, 10, 10);
  const v = [];
  for (let i = 0; i < m.positions.length; i += 3) v.push(`<vertex x="${m.positions[i]}" y="${m.positions[i + 1]}" z="${m.positions[i + 2]}"/>`);
  const t = [];
  for (let i = 0; i < m.indices.length; i += 3) t.push(`<triangle v1="${m.indices[i]}" v2="${m.indices[i + 1]}" v3="${m.indices[i + 2]}"/>`);
  return `<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>
    <object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></components></object></resources>
    <build><item objectid="2" transform="2 0 0 0 1 0 0 0 1 0 0 0"/></build></model>`;
}

// 20 mm square, 3 layers; layer 3 has a stray line far outside (printed over air)
const GCODE = `; HEADER_BLOCK_START
; model printing time: 5m 10s; total estimated time: 7m 2s
; total filament weight [g] : 1.23
; HEADER_BLOCK_END
G90
M83
G1 Z0.2 F600
; FEATURE: Outer wall
G1 X0 Y0 F3000
G1 X20 Y0 E1
G1 X20 Y20 E1
G1 X0 Y20 E1
G1 X0 Y0 E1
G1 Z0.4
G1 X20 Y0 E1
G1 X20 Y20 E1
G1 X0 Y20 E1
G1 X0 Y0 E1
G1 Z0.6
G1 X20 Y0 E1
G1 X60 Y0 E3
G2 X60 Y10 I0 J5 E1
`;

describe("loaders", () => {
  it("STL binary roundtrip", () => {
    const m = parseSTL(writeBinarySTL(box(10, 20, 30)));
    expect(massProps(m).volume).toBeCloseTo(6000, 0);
  });
  it("3MF with components and transforms", () => {
    const zip = zipSync({ "3D/3dmodel.model": strToU8(model3mf()) });
    const f = loadFile("part.3mf", zip);
    expect(massProps(f.mesh!).volume).toBeCloseTo(2000, 0); // x scaled by 2
    // component offset 20 then item scale 2 → x from 40 to 60
    let minx = Infinity;
    for (let i = 0; i < f.mesh!.positions.length; i += 3) minx = Math.min(minx, f.mesh!.positions[i]);
    expect(minx).toBeCloseTo(40, 3);
  });
  it("Bambu .gcode.3mf with slice_info", () => {
    const info = `<?xml version="1.0"?><config><plate><metadata key="index" value="1"/><metadata key="prediction" value="1234"/><metadata key="weight" value="5.67"/><filament id="1" type="PLA" color="#FFFFFF" used_m="1.9" used_g="5.67"/></plate></config>`;
    const zip = zipSync({ "Metadata/plate_1.gcode": strToU8(GCODE), "Metadata/slice_info.config": strToU8(info), "3D/3dmodel.model": strToU8(model3mf()) });
    const f = loadFile("x.gcode.3mf", zip);
    expect(f.gcode!.layers.length).toBe(3);
    expect(f.mesh).toBeDefined();
    const plates = (f.meta.sliceInfo as any).plates;
    expect(plates[0].predictionSeconds).toBe(1234);
    const c = checkGcode(f.gcode!, plates[0]);
    expect((c.data as any).seconds).toBe(1234);
  });
});

describe("gcode", () => {
  it("parses layers, header time, arcs, and flags extrusion over air", () => {
    const g = parseGcode(GCODE);
    expect(g.stats.layers).toBe(3);
    expect(g.stats.estimatedSeconds).toBe(422);
    expect(g.stats.estimateSource).toBe("slicer");
    expect(g.features).toContain("Outer wall");
    const c = checkGcode(g);
    expect(c.status).not.toBe("pass");
    expect((c.data as any).unsupported[0].layer).toBe(3);
  });
  it("durations", () => {
    expect(parseDuration("1h 2m 3s")).toBe(3723);
    expect(parseDuration("1d 1h")).toBe(90000);
  });
});
