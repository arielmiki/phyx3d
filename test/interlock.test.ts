import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSTL } from "../src/core/loaders.js";
import { checkInterlock, checkInterlockFile, interlockPreset, INTERLOCK_TYPES, type InterlockSpec } from "../src/core/interlock.js";

// fixtures: examples/interlocks/make_interlocks.py (CLR = 0.15 mm per side)
const DIR = join(__dirname, "..", "examples", "interlocks");
const cache = new Map<string, ReturnType<typeof parseSTL>>();
const part = (id: string) => {
  if (!cache.has(id)) cache.set(id, parseSTL(new Uint8Array(readFileSync(join(DIR, `${id}.stl`)))));
  return { id, mesh: cache.get(id)! };
};
const run = (ids: string[], spec: InterlockSpec) => checkInterlock(ids.map(part), spec);
const find = (r: ReturnType<typeof run>, re: RegExp) => r.findings.find((f) => re.test(f.message));
const escape = (r: ReturnType<typeof run>, dir: string) => r.data.escapes.find((e) => e.direction === dir)?.blockedAfter;

describe("interlock presets", () => {
  it("maps names loosely and covers the families", () => {
    expect(interlockPreset("Dovetail joint").name).toBe("dovetail");
    expect(interlockPreset("T slot").preset.family).toBe("slide");
    expect(interlockPreset("bayonet").preset.family).toBe("twist");
    expect(interlockPreset("cantilever snap-fit").preset.family).toBe("snap");
    expect(interlockPreset("press fit").preset.family).toBe("friction");
    // every name in the common list resolves (as written, with "joint" / "fit" / "/" etc.)
    for (const n of ["T-track / T-key", "Finger/keyed slide", "Helical/threaded interlock", "Mousetrap-style rotating lock", "Finger joint / box joint",
      "Cross-shaped interlock", "Hirth-style serration", "Wedge-lock coupling", "Self-locking polygon joint", "U-shaped snap clip", "Spring tab lock"]) {
      expect(() => interlockPreset(n)).not.toThrow();
    }
    expect(() => interlockPreset("banana")).toThrow(/Unknown interlock type/);
    expect(new Set(Object.values(INTERLOCK_TYPES).map((p) => p.family))).toEqual(new Set(["slide", "twist", "screw", "snap", "friction", "custom"]));
  });
});

describe("interlock check", () => {
  it("dovetail: fits, slides in, locks against lifting, free play = design clearance", () => {
    const r = run(["dovetail_rail", "dovetail_slider"], { type: "dovetail", moving: "dovetail_slider", axis: [1, 0, 0] });
    expect(r.data.insertion?.clear).toBe(true);
    expect(r.data.fit[0].status).not.toBe("interfering");
    expect(escape(r, "+Z")).toBeGreaterThan(0.1);            // dovetail holds it down
    expect(escape(r, "+Z")).toBeLessThan(0.5);
    expect(escape(r, "-Z")).toBeLessThanOrEqual(0.01);       // it rests on the rail
    expect(escape(r, "+X")).toBeNull();                      // groove runs through: slides out the far end
    expect(r.status).toBe("warn");
    expect(r.picture.length).toBeGreaterThan(1000);
  }, 60000);

  it("zero clearance is clamped and fails", () => {
    const r = run(["dovetail_rail", "dovetail_slider_tight"], { type: "dovetail", moving: "dovetail_slider_tight", axis: [1, 0, 0] });
    expect(r.data.fit[0].status).toBe("clamped");
    expect(r.status).toBe("fail");
  }, 60000);

  it("T-slot free play equals the modelled 0.15 mm clearance", () => {
    const r = run(["tslot_rail", "tslot_slider"], { type: "t-slot", moving: "tslot_slider", axis: [1, 0, 0] });
    for (const d of ["+Y", "-Y", "+Z", "-Z"]) expect(escape(r, d)).toBeCloseTo(0.15, 1);
    expect(Math.abs(escape(r, "+Z")! - 0.15)).toBeLessThan(0.02);
  }, 60000);

  it("detent: held, engagement = catch height − free play", () => {
    const r = run(["detent_rail", "detent_slider"], { type: "detent", moving: "detent_slider", axis: [1, 0, 0] });
    expect(r.data.insertion?.clear).toBe(false);
    const e = r.data.engagement!;
    expect(e.needed).toBeCloseTo(0.6, 1);
    expect(e.net).toBeCloseTo(e.needed - e.freePlay, 2);
    expect(e.net).toBeGreaterThanOrEqual(0.2);
    expect(r.status).toBe("pass");
    // the same catch is too small to count as a lock
    const lock = run(["detent_rail", "detent_slider"], { type: "detent", hold: "lock", moving: "detent_slider", axis: [1, 0, 0] });
    expect(lock.status).toBe("fail");
    expect(lock.fixes.join(" ")).toMatch(/catch taller/);
  }, 60000);

  it("bayonet: push in, twist, stops against the end of the slot", () => {
    const r = run(["bayonet_socket", "bayonet_plug"], { type: "bayonet", moving: "bayonet_plug", axis: [0, 0, -1], depth: 6, angle: -30, center: [0, 0, 0], hold: "none" });
    expect(r.data.insertion?.clear).toBe(true);
    expect(escape(r, "+Z")).toBeCloseTo(0.15, 1);            // lug under the slot roof
    expect(escape(r, "-twist")).toBeLessThan(1);             // at the end of the slot
    expect(escape(r, "+twist")).toBeGreaterThan(29);         // back along the slot to the entry
    expect(r.status).toBe("pass");
  }, 60000);

  it("finds a part that also goes in the wrong way round", () => {
    const r = run(["dovetail_rail", "dovetail_slider_marked"], { type: "dovetail", moving: "dovetail_slider_marked", axis: [1, 0, 0] });
    expect(r.data.wrongWays.find((w) => w.variant === "turned about Z")?.result).toBe("assembles");
    expect(find(r, /wrong way/)?.status).toBe("warn");
    // the plain slider is symmetric about Z: turning it is the same part, not a wrong way
    const plain = run(["dovetail_rail", "dovetail_slider"], { type: "dovetail", moving: "dovetail_slider", axis: [1, 0, 0] });
    expect(plain.data.wrongWays.find((w) => w.variant === "turned about Z")?.result).toBe("same-as-correct");
  }, 60000);

  it("press fit: measures the interference per side", () => {
    const r = run(["pressfit_block", "pressfit_pin"], { type: "press-fit", moving: "pressfit_pin", axis: [0, 0, -1] });
    expect(r.data.fit[0].interference).toBeCloseTo(0.1, 2);
    expect(r.status).toBe("pass");
    const loose = run(["dovetail_rail", "dovetail_slider"], { type: "press-fit", moving: "dovetail_slider" });
    expect(loose.status).toBe("fail");
  }, 60000);

  it("spec file: parts placed by position, one result per interlock", () => {
    const spec = JSON.parse(readFileSync(join(DIR, "sliders.interlock.json"), "utf8"));
    const out = checkInterlockFile(spec, (f) => new Uint8Array(readFileSync(join(DIR, f))));
    expect(out.checks.map((c) => c.status)).toEqual(["warn", "warn", "pass"]);
    expect(out.status).toBe("warn");
    expect(() => checkInterlockFile({ ...spec, interlocks: [{ moving: "nope" }] }, (f) => new Uint8Array(readFileSync(join(DIR, f))))).toThrow(/not found/);
  }, 60000);
});
