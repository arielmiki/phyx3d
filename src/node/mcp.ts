#!/usr/bin/env node
// phyx3d MCP server — gives Claude Code (or any MCP client) tools to test a design before printing.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyze, renderReport, suggestOrientations, checkStrength, dropTest, tiltTest, pushTest, stackTest, checkGcode,
  Part, MATERIALS, PRINTERS, MOTOR_PRESETS, INTERLOCK_TYPES, buildReport, type LoadCase, type VisualMode, type ViewName, type MechSpec, type InterlockFile,
} from "../core/index.js";
import { loadPath, requireMesh, compactReport, compactCheck, saveRun, runMechanismFile, saveMechanismRun, runInterlockFile, interlockPayload, saveInterlockRun } from "./shared.js";
import { sliceWithBambu } from "./slice.js";

const server = new McpServer({ name: "phyx3d", version: "0.1.0" });

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const partShape = {
  path: z.string().describe("Absolute path to an STL, 3MF or Bambu .gcode.3mf file"),
  material: z.string().optional().describe(`Filament: ${Object.keys(MATERIALS).join(", ")} (default PLA)`),
  printer: z.string().optional().describe(`Printer: ${Object.keys(PRINTERS).join(", ")} (default P1S)`),
  rotate: vec3.optional().describe("Rotate the part before testing, Euler degrees [x,y,z] applied X→Y→Z. Use suggest_orientation to find good values."),
  infill: z.number().min(0).max(100).optional().describe("Sparse infill % (default 15)"),
  walls: z.number().int().min(1).max(20).optional().describe("Wall loops (default 2)"),
};
type PartArgs = { path: string; material?: string; printer?: string; rotate?: [number, number, number]; infill?: number; walls?: number };
const partOpts = (a: PartArgs) => ({
  material: a.material,
  printer: a.printer,
  rotate: a.rotate,
  settings: { ...(a.infill !== undefined ? { infill: a.infill / 100 } : {}), ...(a.walls !== undefined ? { walls: a.walls } : {}) },
});

const region = z.union([
  z.object({ face: z.enum(["bottom", "top", "-x", "+x", "-y", "+y"]), depth: z.number().optional().describe("mm into the part from that face (default: just the surface layer)") }),
  z.object({ box: z.object({ min: vec3, max: vec3 }) }).describe("Axis-aligned box in printer mm coordinates (see part size/position in analyze_model)"),
  z.object({ sphere: z.object({ center: vec3, radius: z.number() }) }),
  z.object({ rel: z.object({ min: vec3, max: vec3 }) }).describe("Box as FRACTIONS of the part's bounding box (0..1 per axis). Easiest option: e.g. the far 15% of the part along +x = {rel:{min:[0.85,0,0],max:[1,1,1]}}"),
]);

const png = (data: Uint8Array) => ({ type: "image" as const, data: Buffer.from(data).toString("base64"), mimeType: "image/png" });
const json = (o: unknown) => ({ type: "text" as const, text: JSON.stringify(o, null, 1) });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true });

server.registerTool(
  "analyze_model",
  {
    title: "Check a 3D model before printing",
    description:
      "Runs every printability check on a model for a Bambu Lab printer: mesh health, bed fit, overhangs/supports, floating islands, thin walls, " +
      "stability & bed adhesion (centre of mass, tip angle, wobble while printing), warp risk and a filament/time estimate. " +
      "Returns a verdict (ready / printable-with-care / needs-changes), a score, per-check findings with mm coordinates, and a prioritized todo list of design fixes. " +
      "Also returns an annotated picture (red = needs support, blue outline = footprint, COM marker). Call this after every design change. " +
      "Coordinates: part is placed centred on the bed with its lowest point at z=0; X/Y are bed axes in mm.",
    inputSchema: { ...partShape, image: z.boolean().optional().describe("Include the annotated picture (default true)") },
  },
  async (a) => {
    try {
      const f = loadPath(a.path);
      const { report, part } = analyze(requireMesh(f), partOpts(a));
      if (f.gcode) report.checks.push(checkGcode(f.gcode, (f.meta.sliceInfo as { plates?: never[] })?.plates?.[0]));
      const img = renderReport(part, report, "overview");
      saveRun("check", f.name, part.mesh, report, { overview: img.png });
      const b = part.bbox;
      const out = { ...compactReport(report), placement: { min: b.min.map((v) => +v.toFixed(2)), max: b.max.map((v) => +v.toFixed(2)) } };
      return { content: a.image === false ? [json(out)] : [json(out), png(img.png)] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "stress_test",
  {
    title: "Strength test (FEA)",
    description:
      "Finite-element strength test with FDM layer weakness. Hold the part at `fixed` regions and apply `loads` (newtons), `displacements` (mm) and/or `acceleration` (in g). " +
      "Returns minimum safety factor, weakest spot (mm), whether it fails along or across layers, max deflection, and a colour stress picture. " +
      "Region coordinates are printer mm after placement (get them from analyze_model `placement`). " +
      "Examples: shelf bracket → fixed [{face:'-x'}] (wall side), loads [{region:{face:'top'}, force:[0,0,-50]}]. " +
      "Hook → fixed [{face:'top'}], loads [{region:{box:{min:[..],max:[..]}}, force:[0,0,-20]}]. " +
      "Safety ≥ 2 is good for static loads, ≥ 3 for impact/repeated loads. This is a rough guide, not certified engineering.",
    inputSchema: {
      ...partShape,
      fixed: z.array(region).min(1).describe("Where the part is held (screwed, glued, clamped)"),
      loads: z.array(z.object({ region, force: vec3.describe("Force in newtons [fx,fy,fz]; 10 N ≈ 1 kg hanging") })).optional(),
      acceleration: vec3.optional().describe("Body acceleration in g, e.g. [0,0,-1] = own weight"),
      displacements: z.array(z.object({ region, move: vec3.describe("Distance in mm [dx,dy,dz] the region is pushed") })).optional()
        .describe("Push a region a set distance instead of a force: use for snap arms, detents and clips (their travel is fixed by the geometry). Reports the force it takes (pushForces, N) and the safety factor at that travel."),
      required_safety: z.number().optional().describe("Required safety factor (default 2)"),
      resolution: z.number().int().min(2000).max(200000).optional().describe("Number of finite elements (default 25000; more = slower, finer). Thin walls refine automatically."),
      element_size: z.number().min(0.1).max(10).optional().describe("Element size in mm, instead of resolution. Pin it when comparing builds of the same design: at sharp inside corners the peak stress depends on element size, so a fixed element COUNT on a slightly changed part gives a different safety factor."),
    },
  },
  async (a) => {
    try {
      const f = loadPath(a.path);
      const part = new Part(requireMesh(f), partOpts(a));
      const lc: LoadCase = { fixed: a.fixed, loads: a.loads ?? [], acceleration: a.acceleration, displacements: a.displacements };
      const s = checkStrength(part, lc, { requiredSafety: a.required_safety, elements: a.resolution, elementSize: a.element_size });
      const { fea, ...check } = s;
      const img = renderReport(part, buildReport(part, [check]), "stress", fea);
      saveRun("stress", f.name, part.mesh, compactCheck(check), { stress: img.png });
      return { content: [json(compactCheck(check)), png(img.png)] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "simulate_physics",
  {
    title: "Physics simulation",
    description:
      "Rigid-body physics (Rapier engine) on the printed part with its real printed mass and friction. Scenarios: " +
      "'drop' — dropped from `height` mm in random orientations onto a floor; reports impact speed, peak g, bounces, which side it lands on, and runs an impact stress check on the worst landing. " +
      "'tilt' — table tilted slowly until the part tips or slides (angle in degrees, per direction). " +
      "'push' — sideways push at the top until it tips; force in newtons. " +
      "'stack' — stacks `count` copies and checks the tower holds. " +
      "Use `orientation` (Euler degrees) to test how the part stands in use when that differs from the print orientation.",
    inputSchema: {
      ...partShape,
      scenario: z.enum(["drop", "tilt", "push", "stack"]),
      height: z.number().optional().describe("drop: height in mm (default 1000)"),
      floor: z.enum(["concrete", "tile", "wood", "carpet"]).optional().describe("drop: floor type (default tile)"),
      trials: z.number().int().min(1).max(30).optional().describe("drop: random orientations (default 8)"),
      orientation: vec3.optional().describe("tilt/push/stack/drop: starting orientation, Euler degrees"),
      count: z.number().int().min(2).max(10).optional().describe("stack: number of copies (default 3)"),
    },
  },
  async (a) => {
    try {
      const f = loadPath(a.path);
      const part = new Part(requireMesh(f), partOpts(a));
      const r =
        a.scenario === "drop" ? await dropTest(part, { height: a.height, floor: a.floor, trials: a.trials, orientation: a.orientation })
          : a.scenario === "tilt" ? await tiltTest(part, { orientation: a.orientation })
            : a.scenario === "push" ? await pushTest(part, { orientation: a.orientation })
              : await stackTest(part, { count: a.count, orientation: a.orientation });
      saveRun(a.scenario, f.name, part.mesh, compactCheck(r));
      return { content: [json(compactCheck(r))] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "suggest_orientation",
  {
    title: "Find the best print orientation",
    description: "Tries laying the part on each large flat face and the 6 axis directions; ranks by support area, floating islands, stability, warp and height. Returns `rotation` values to pass as `rotate` to other tools, and to apply in Bambu Studio.",
    inputSchema: partShape,
  },
  async (a) => {
    try {
      const f = loadPath(a.path);
      return { content: [json(suggestOrientations(requireMesh(f), partOpts(a)).slice(0, 8))] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "render_view",
  {
    title: "Render the model",
    description: "Picture of the model from chosen views with an overlay: overview (supports + stability + thin walls + islands), overhangs, stability, thin-walls or plain. Use it to *see* the design you just generated.",
    inputSchema: {
      ...partShape,
      mode: z.enum(["overview", "overhangs", "stability", "thin-walls", "plain"]).optional(),
      views: z.array(z.enum(["iso", "iso-back", "below", "front", "back", "left", "right", "top"])).optional().describe("Default: iso, below, front, top"),
    },
  },
  async (a) => {
    try {
      const f = loadPath(a.path);
      const { report, part } = analyze(requireMesh(f), partOpts(a));
      const img = renderReport(part, report, (a.mode ?? "overview") as VisualMode, undefined, { views: a.views as ViewName[] | undefined });
      return { content: [png(img.png)] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "simulate_mechanism",
  {
    title: "Simulate a mechanism / robot",
    description:
      "Real-physics simulation of several printed parts connected by joints and driven by motors — walking robots, wheeled vehicles, " +
      "robot arms, grippers, linkages. Give a .mech.json file (`path`) or the spec inline (`spec` + `base_dir` for STL paths). " +
      "Spec: {name, duration (s), material, infill, parts:[{id, file (STL, assembly coordinates) | shape:{box:[x,y,z]} | {cylinder:{r,h,axis}} | {sphere:{r}}, " +
      "position, rotation, material, infill, mass, extraMass, payloads:[{mass (g), at:[x,y,z]}], fixed, friction, color}], " +
      "joints:[{id, type: revolute|prismatic|fixed|ball, parent (part id or 'world'), child, anchor:[x,y,z] (assembly mm), axis:[x,y,z], limits:[min,max] (° or mm), " +
      "motor:{preset, mode: position|velocity, target, maxTorque (N·m), maxSpeed}}], environment:{floor, friction, slope (°), obstacles:[{min,max}]}, track (part id)}. " +
      `Motor presets: ${Object.entries(MOTOR_PRESETS).map(([k, v]) => `${k} (${v.note})`).join("; ")}. ` +
      "Servo targets are degrees (mm for sliders); DC-motor targets are rpm. A target is a number, keyframes {keyframes:[[t,v],…], loop, smooth}, or an expression of t, " +
      "e.g. \"20*sin(2*pi*1.2*t + pi)\" (functions: sin cos abs min max clamp ramp(t,t0,t1) smoothstep square tri saw step mod; ternary a?b:c). " +
      "Expressions can read live sensors of the tracked part for closed-loop control: yaw, pitch, roll (°), x, y, z (mm), speed (mm/s). " +
      "Z is up, the floor is z=0 (the assembly is set down on it unless a part is fixed). Model STL parts in their assembly position so anchors line up. " +
      "Returns: distance travelled, speed, heading drift, falls over?, per-motor peak torque vs rating (too weak?), tracking error, parts colliding, parts overlapping at start, joint ranges — plus a filmstrip picture.",
    inputSchema: {
      path: z.string().optional().describe("Absolute path to a .mech.json file"),
      spec: z.record(z.string(), z.unknown()).optional().describe("Mechanism spec inline (instead of path)"),
      base_dir: z.string().optional().describe("Folder that STL `file` paths in an inline spec are relative to"),
      duration: z.number().min(0.2).max(60).optional().describe("Seconds to simulate (overrides the spec)"),
    },
  },
  async (a) => {
    try {
      if (!a.path && !a.spec) throw new Error("Give `path` to a .mech.json file or an inline `spec`.");
      const baseDir = a.path ? undefined : a.base_dir ?? process.cwd();
      const { out, png: film, spec } = await runMechanismFile(a.path ?? "", { spec: a.spec as MechSpec | undefined, baseDir, duration: a.duration });
      saveMechanismRun(spec.name ?? "mechanism", spec, out, film);
      return { content: [json(compactCheck(out.check)), png(film)] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "check_interlock",
  {
    title: "Check interlocking parts",
    description:
      "Do two (or more) printed parts that lock together actually work? Sweeps the moving part along its assembly path against the others with exact mesh collision. " +
      "Checks: fit in the assembled pose (gap / touching / clamped / overlapping), whether the path is clear or jams (and where), which directions it can escape and the free play in each, " +
      "detent/lock engagement (catch height minus free play, vs 0.2 mm detent / 0.6 mm lock, in whole layers), press-fit interference, and whether it also goes together the wrong way (flipped/turned). " +
      "Give a .interlock.json (`path`) or the spec inline (`spec` + `base_dir`). Model every part in its ASSEMBLED position. " +
      "Spec: {name, layerHeight, parts:[{id, file | shape, position, rotation}], interlocks:[{name, type, moving (part id), against:[part ids] (default: all others), " +
      "axis:[x,y,z] (direction the moving part travels to go IN; for twist/screw the turning axis), travel (mm), depth (mm pushed in before a twist), angle (° twist, sign = direction), " +
      "center:[x,y,z] (point on the turning axis), pitch, turns (screw), hold: lock|detent|none, clearance:[min,max] mm, insert:[{move:[x,y,z]} | {rotate:deg, axis, about} | {screw:deg, pitch, axis, about}] (custom path), wrongWays}]}. " +
      `Types: ${Object.keys(INTERLOCK_TYPES).join(", ")}. ` +
      "Motion families: slide (dovetail, T-slot, tongue-and-groove, mortise-and-tenon…), twist (bayonet, quarter-turn, cam lock…), screw (thread), snap (cantilever/annular snap, detent, ball snap…), friction (press-fit, wedge, collet). " +
      "Snap arm strength is a separate test: run stress_test with `displacements` at the catch height this tool reports. Returns JSON per interlock plus a picture each (moving part in blue, insertion path, first contact).",
    inputSchema: {
      path: z.string().optional().describe("Absolute path to a .interlock.json file"),
      spec: z.record(z.string(), z.unknown()).optional().describe("Interlock spec inline (instead of path)"),
      base_dir: z.string().optional().describe("Folder that part `file` paths in an inline spec are relative to"),
    },
  },
  async (a) => {
    try {
      if (!a.path && !a.spec) throw new Error("Give `path` to a .interlock.json file or an inline `spec`.");
      const { run } = runInterlockFile(a.path, { spec: a.spec as InterlockFile | undefined, baseDir: a.path ? undefined : a.base_dir ?? process.cwd() });
      saveInterlockRun(run);
      return { content: [json(interlockPayload(run)), ...run.checks.slice(0, 4).map((c) => png(c.picture))] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "check_gcode",
  {
    title: "Check sliced G-code",
    description: "Reads a .gcode or Bambu Studio .gcode.3mf: layers, print time, filament, and extrusion printed over thin air (missing supports) with layer numbers and positions.",
    inputSchema: { path: z.string() },
  },
  async (a) => {
    try {
      const f = loadPath(a.path);
      if (!f.gcode) throw new Error("No G-code in this file");
      return { content: [json(compactCheck(checkGcode(f.gcode, (f.meta.sliceInfo as { plates?: never[] })?.plates?.[0])))] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "slice_bambu",
  {
    title: "Slice with Bambu Studio",
    description: "Slices an STL/3MF with the installed Bambu Studio CLI using profiles in ~/.phyx3d/profiles (machine.json, process.json, filament.json) or a Bambu .3mf project's own settings. Returns the .gcode.3mf path, exact print time and filament, and a G-code check. Does NOT start a print.",
    inputSchema: { path: z.string(), profiles: z.string().optional(), out_dir: z.string().optional() },
  },
  async (a) => {
    try {
      const r = await sliceWithBambu(a.path, { profiles: a.profiles, outDir: a.out_dir });
      return { content: [json({ output: r.output, seconds: r.seconds, grams: r.grams, check: compactCheck(r.check) })] };
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "list_materials",
  { title: "Materials & printers", description: "Material presets (strength along/across layers, stiffness, density) and printer build volumes.", inputSchema: {} },
  async () => ({ content: [json({ materials: MATERIALS, printers: PRINTERS })] }),
);

await server.connect(new StdioServerTransport());
