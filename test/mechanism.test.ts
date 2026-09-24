import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileExpr, compileSignal } from "../src/core/expr.js";
import { simulateMechanism, type MechSpec } from "../src/core/mechanism.js";

const ex = (f: string) => JSON.parse(readFileSync(join("examples/mechanisms", f), "utf8")) as MechSpec;
const files = (dir: string) => (f: string) => new Uint8Array(readFileSync(join("examples/mechanisms", dir, f)));

describe("expressions", () => {
  it("evaluates math, functions, precedence and ternaries", () => {
    const s = { t: 0.25 };
    expect(compileExpr("30*sin(2*pi*t)")(s)).toBeCloseTo(30, 6);
    expect(compileExpr("2^3^2")(s)).toBe(512);
    expect(compileExpr("-2^2")(s)).toBe(-4);
    expect(compileExpr("t < 1 ? 5 : 9")(s)).toBe(5);
    expect(compileExpr("clamp(ramp(t,0,1)*100, 0, 20)")(s)).toBe(20);
  });
  it("rejects unknown names and garbage", () => {
    expect(() => compileSignal("sinn(t)")).toThrow(/Unknown function/);
    expect(() => compileSignal("foo*2")).toThrow(/Unknown variable/);
    expect(() => compileSignal("3 +")).toThrow();
  });
  it("keyframes interpolate and loop", () => {
    const f = compileSignal({ keyframes: [[0, 0], [1, 10], [2, 0]], loop: true });
    expect(f(0.5)).toBeCloseTo(5);
    expect(f(2.5)).toBeCloseTo(5);
  });
});

describe("mechanism physics", () => {
  it("rover speed matches wheel rpm × circumference", async () => {
    const out = await simulateMechanism(ex("rover.mech.json"), () => new Uint8Array());
    const d = out.check.data;
    const ideal = (120 / 60) * 2 * Math.PI * 30; // 377 mm/s
    expect(d.speed / ideal).toBeGreaterThan(0.9);
    expect(d.speed / ideal).toBeLessThan(1.02);
    expect(Math.abs(d.headingChange)).toBeLessThan(5);
  });
  it("crank-slider stroke = 2 × crank radius, rod swing = asin(r/L)", async () => {
    const out = await simulateMechanism(ex("crank_slider.mech.json"), () => new Uint8Array());
    const rail = out.check.data.jointRanges.find((r) => r.joint === "rail")!;
    const wrist = out.check.data.jointRanges.find((r) => r.joint === "wrist_pin")!;
    expect(rail.max - rail.min).toBeCloseTo(60, 0);
    expect(wrist.max).toBeCloseTo((Math.asin(30 / 80) * 180) / Math.PI, 0);
  });
  it("servo holding torque equals m·g·r (pendulum)", async () => {
    const spec: MechSpec = {
      duration: 2,
      parts: [{ id: "rod", shape: { box: [100, 10, 10] }, position: [60, 0, 100], mass: 1, payloads: [{ mass: 100, at: [110, 0, 100] }] }],
      joints: [{ id: "j", type: "revolute", parent: "world", child: "rod", anchor: [10, 0, 100], axis: [0, -1, 0], motor: { preset: "MG996R", target: 0 } }],
      environment: { floor: false },
    };
    const out = await simulateMechanism(spec, () => new Uint8Array(), { record: true });
    const v = out.frames!.joints[0].values;
    const torque = v[v.length - 1] * 0.94;
    expect(torque / (101 * 9.81e-6 * 100)).toBeGreaterThan(0.95);
    expect(torque / (101 * 9.81e-6 * 100)).toBeLessThan(1.05);
  });
  it("arm from STL parts: shoulder hold torque matches hand calculation", async () => {
    const out = await simulateMechanism(ex("arm/arm.mech.json"), files("arm"), { record: true });
    const v = out.frames!.joints[0].values; // shoulder: [t, angle, torque/max]
    const i = v.length - 3;
    expect(Math.abs(v[i + 1])).toBeLessThan(3); // back at 0°
    // upper arm 13 g @50 mm + elbow servo 55 g @100 mm + forearm 12.5 g @~146 mm + payload 150 g @188 mm
    expect(v[i + 2] * 0.94).toBeGreaterThan(0.32);
    expect(v[i + 2] * 0.94).toBeLessThan(0.4);
    expect(out.check.data.masses.find((m) => m.id === "base")!.collider).toBe("convex decomposition");
  });
  it("weak servos under a heavy body are flagged", async () => {
    const spec = ex("walker.mech.json");
    spec.parts[0].extraMass = 900;
    for (const j of spec.joints!) j.motor!.preset = "SG90";
    const out = await simulateMechanism(spec, () => new Uint8Array());
    expect(out.check.data.motors.some((m) => m.saturated > 0.05 || m.p95 > m.rated * 0.7)).toBe(true);
    expect(out.check.status).not.toBe("pass");
  });
  it("walker walks forward and stays upright", async () => {
    const out = await simulateMechanism(ex("walker.mech.json"), () => new Uint8Array());
    expect(out.check.data.displacement[0]).toBeGreaterThan(150);
    expect(out.check.data.fell).toBe(false);
  }, 60000);
  it("detects parts overlapping at the start", async () => {
    const out = await simulateMechanism({ duration: 0.5, parts: [{ id: "a", shape: { box: [20, 20, 20] }, position: [0, 0, 10] }, { id: "b", shape: { box: [20, 20, 20] }, position: [15, 0, 10] }] }, () => new Uint8Array());
    expect(out.check.status).toBe("fail");
    expect(out.check.data.interference[0].depth).toBeGreaterThan(3);
  });
});
