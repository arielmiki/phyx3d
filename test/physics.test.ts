import { describe, it, expect } from "vitest";
import { box, extrudeXZ } from "../src/core/mesh.js";
import { Part } from "../src/core/context.js";
import { dropTest, tiltTest, pushTest, stackTest } from "../src/core/physics.js";

describe("physics", () => {
  it("cube tilt ≈ 45° (or slides first)", async () => {
    const r = await tiltTest(new Part(box(20, 20, 20)), { directions: 4 });
    console.log("tilt cube", r.summary);
    const d = r.data as any;
    // PLA friction 0.45 → slides at atan(0.45)≈24° before tipping at 45°
    expect(d.minTipAngle === null || d.minTipAngle > 35).toBe(true);
  }, 60000);
  it("tall block tips early", async () => {
    // 10 x 40 base, 60 tall: tip angle about the 10mm side = atan(5/30) ≈ 9.5°
    const r = await tiltTest(new Part(box(10, 40, 60)), { directions: 4 });
    console.log("tilt tall", r.summary);
    expect((r.data as any).minTipAngle).toBeGreaterThan(6);
    expect((r.data as any).minTipAngle).toBeLessThan(14);
  }, 60000);
  it("push test on a tall block tips", async () => {
    const r = await pushTest(new Part(box(10, 40, 60)), { directions: 4 });
    console.log("push", r.summary);
    // analytic: F·h = W·5  → F = W·5/60 ≈ 0.083 W
    const w = (r.data as any).weightN;
    const tip = (r.data as any).results.filter((x: any) => x.outcome === "tips").map((x: any) => x.forceN);
    expect(Math.min(...tip) / w).toBeGreaterThan(0.05);
    expect(Math.min(...tip) / w).toBeLessThan(0.13);
  }, 60000);
  it("drop test runs and reports impact", async () => {
    const T = extrudeXZ([[20, 0], [30, 0], [30, 30], [50, 30], [50, 40], [0, 40], [0, 30], [20, 30]], 10);
    const r = await dropTest(new Part(T), { trials: 4, height: 1000 });
    console.log("drop", r.summary, JSON.stringify(r.data.worst));
    expect(r.data.worst.impactSpeed).toBeGreaterThan(4);
    expect(r.data.worst.impactSpeed).toBeLessThan(5.5);
  }, 120000);
  it("stack of cubes holds", async () => {
    const r = await stackTest(new Part(box(20, 20, 10)), { count: 3 });
    console.log("stack", r.summary);
    expect(r.status).not.toBe("fail");
  }, 60000);
});
