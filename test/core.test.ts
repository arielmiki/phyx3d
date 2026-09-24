import { describe, it, expect } from "vitest";
import { box, cylinder, extrude, extrudeXZ, massProps, meshHealth, mergeMeshes } from "../src/core/mesh.js";
import { Part } from "../src/core/context.js";
import { voxelize, countSolid } from "../src/core/voxel.js";
import { checkOverhangs, checkIslands, checkThinWalls } from "../src/core/printability.js";
import { checkStability } from "../src/core/stability.js";
import { checkStrength } from "../src/core/fea.js";

describe("mesh", () => {
  it("box volume, COM, watertight", () => {
    const m = box(10, 20, 30);
    const mp = massProps(m);
    expect(mp.volume).toBeCloseTo(6000, 3);
    expect(mp.centerOfMass[2]).toBeCloseTo(15, 3);
    const h = meshHealth(m);
    expect(h.watertight).toBe(true);
    expect(h.inverted).toBe(false);
    expect(h.flippedEdges).toBe(0);
  });
  it("T profile extruded in XZ is a valid solid", () => {
    // T: stem 10 wide, 30 tall; bar 50 wide, 10 thick on top
    const t = extrudeXZ([[20, 0], [30, 0], [30, 30], [50, 30], [50, 40], [0, 40], [0, 30], [20, 30]], 10);
    const h = meshHealth(t);
    expect(h.watertight).toBe(true);
    expect(h.inverted).toBe(false);
    expect(massProps(t).volume).toBeCloseTo(10 * 30 * 10 + 50 * 10 * 10, 1);
  });
  it("voxelizes a cylinder to ~its volume", () => {
    const c = cylinder(10, 20, 64);
    const g = voxelize(c, 0.5);
    expect((countSolid(g) * 0.125) / (Math.PI * 100 * 20)).toBeGreaterThan(0.95);
  });
});

describe("printability", () => {
  const T = () => extrudeXZ([[20, 0], [30, 0], [30, 30], [50, 30], [50, 40], [0, 40], [0, 30], [20, 30]], 10);
  it("cube needs no support", () => {
    const r = checkOverhangs(new Part(box(20, 20, 20)));
    expect(r.status).toBe("pass");
  });
  it("T-shape arms need support (cantilevers, not bridges)", () => {
    const r = checkOverhangs(new Part(T()));
    expect(r.status).toBe("fail");
    expect(r.data.clusters.filter((c) => c.needsSupport).length).toBe(2);
  });
  it("bridge between two pillars is bridge-like", () => {
    // arch: two 10x10 legs, 10mm gap, 5mm roof
    const arch = extrudeXZ([[0, 0], [10, 0], [10, 20], [20, 20], [20, 0], [30, 0], [30, 25], [0, 25]], 10);
    const r = checkOverhangs(new Part(arch));
    expect(r.data.clusters.some((c) => c.bridgeLike)).toBe(true);
    expect(r.status).not.toBe("fail");
  });
  it("finds a floating island", () => {
    // upside-down L: the overhang starts in the air only if disconnected; use a separate floating box
    const r = checkIslands(new Part(mergeMeshes([box(10, 10, 10), box(10, 10, 5, [20, 0, 10])])));
    expect(r.status).toBe("fail");
    expect((r.data.islands as any[])[0].z).toBeCloseTo(10, 0);
  });
  it("detects a thin fin", () => {
    const fin = extrude([[0, 0], [0.5, 0], [0.5, 20], [0, 20]], 15); // 0.5 mm wall
    const r = checkThinWalls(new Part(fin));
    expect(r.status).not.toBe("pass");
  });
});

describe("stability", () => {
  it("cube is stable", () => {
    const r = checkStability(new Part(box(20, 20, 20)));
    expect(r.status).toBe("pass");
    expect(r.data.tipAngle).toBeCloseTo(45, 0);
  });
  it("tall thin pillar fails", () => {
    const r = checkStability(new Part(box(5, 5, 80)));
    expect(r.status).toBe("fail");
  });
  it("overhanging L (COM outside base) fails", () => {
    // thin stem at x=0..5, heavy arm reaching to x=60 at top
    const L = extrudeXZ([[0, 0], [5, 0], [5, 30], [60, 30], [60, 45], [0, 45]], 20);
    const r = checkStability(new Part(L));
    expect(r.data.comMargin).toBeLessThan(0);
    expect(r.status).toBe("fail");
  });
});

describe("strength (FEA)", () => {
  it("cantilever beam matches beam theory within 25%", () => {
    // 100 x 10 x 10 mm, fixed at -x end, 10 N down at +x end. σ = 6 MPa, δ = FL³/3EI
    const part = new Part(box(100, 10, 10), { material: "PLA", settings: { infill: 1 } });
    const r = checkStrength(part, { fixed: [{ face: "-x" }], loads: [{ region: { face: "+x" }, force: [0, 0, -10] }] }, { elements: 8000 });
    const I = (10 * 10 ** 3) / 12;
    const delta = (10 * 100 ** 3) / (3 * 2600 * I);
    console.log("FEA", { defl: r.data.maxDeflection, theory: +delta.toFixed(3), vm: r.data.maxVonMises, it: r.data.iterations, el: r.data.elements, sf: r.data.minSafetyFactor, mode: r.data.failureMode });
    expect(r.data.converged).toBe(true);
    expect(r.data.maxDeflection / delta).toBeGreaterThan(0.75);
    expect(r.data.maxDeflection / delta).toBeLessThan(1.25);
    expect(r.data.maxVonMises / 6).toBeGreaterThan(0.75);
    expect(r.data.maxVonMises / 6).toBeLessThan(1.6);
  });
  it("pushing the tip a set distance reports the force it takes (F = 3EIδ/L³)", () => {
    // snap-arm style test: displace the free end by the deflection 10 N would cause → reaction ≈ 10 N
    const part = new Part(box(100, 10, 10), { material: "PLA", settings: { infill: 1 } });
    const I = (10 * 10 ** 3) / 12;
    const delta = (10 * 100 ** 3) / (3 * 2600 * I);
    const r = checkStrength(part, { fixed: [{ face: "-x" }], loads: [], displacements: [{ region: { face: "+x" }, move: [0, 0, -delta] }] }, { elements: 8000 });
    expect(r.data.converged).toBe(true);
    expect(r.data.pushForces[0].forceN).toBeGreaterThan(8);
    expect(r.data.pushForces[0].forceN).toBeLessThan(12);
    expect(r.data.maxDeflection).toBeCloseTo(delta, 1);
    expect(r.findings.some((f) => /takes about/.test(f.message))).toBe(true);
  });
});
