#!/usr/bin/env node
// phyx3d command line — every command prints a readable report, or JSON with --json.
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import {
  analyze, renderReport, suggestOrientations, checkStrength, dropTest, tiltTest, pushTest, stackTest, checkGcode,
  Part, MATERIALS, PRINTERS, buildReport, type CheckResult, type Region, type LoadCase, type Report, type VisualMode, type FloorType,
} from "../core/index.js";
import { loadPath, requireMesh, compactReport, compactCheck, saveRun, parseVec, runMechanismFile, saveMechanismRun } from "./shared.js";
import { sliceWithBambu, findBambuStudio } from "./slice.js";
import { startServer } from "./server.js";

const ICON: Record<string, string> = { pass: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " };

function printCheck(c: CheckResult) {
  console.log(`${ICON[c.status]} ${c.title}: ${c.summary}  [${c.accuracy}]`);
  for (const f of c.findings.slice(0, 6)) if (f.message !== c.summary) console.log(`     · ${f.message}`);
}
function printReport(r: Report) {
  console.log(`\n${r.verdict === "ready" ? "✅" : r.verdict === "needs-changes" ? "❌" : "⚠️ "} ${r.headline}  (score ${r.score}/100)`);
  console.log(`   ${r.part.material} on ${r.part.printer}, ${r.part.size.join(" × ")} mm${r.part.rotation ? `, rotated ${r.part.rotation.join(",")}°` : ""}\n`);
  for (const c of r.checks) printCheck(c);
  if (r.todo.length) {
    console.log("\nHow to fix:");
    r.todo.slice(0, 8).forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  }
  console.log();
}

/** "bottom" | "+x" | "box:x0,y0,z0:x1,y1,z1" | "sphere:x,y,z:r" */
export function parseRegion(s: string): Region {
  const [kind, a, b] = s.split(":");
  if (["bottom", "top", "-x", "+x", "-y", "+y"].includes(kind)) return { face: kind as "bottom", depth: a ? +a : undefined };
  if (kind === "box") return { box: { min: parseVec(a)!, max: parseVec(b)! } };
  if (kind === "sphere") return { sphere: { center: parseVec(a)!, radius: +b } };
  if (kind === "rel") return { rel: { min: parseVec(a)!, max: parseVec(b)! } };
  throw new Error(`Bad region "${s}". Use bottom|top|-x|+x|-y|+y, box:x0,y0,z0:x1,y1,z1, sphere:x,y,z:r or rel:fx0,fy0,fz0:fx1,fy1,fz1 (fractions of the part size)`);
}

const common = (c: Command) =>
  c
    .option("-m, --material <id>", `filament: ${Object.keys(MATERIALS).join(", ")}`, "PLA")
    .option("-p, --printer <id>", `printer: ${Object.keys(PRINTERS).join(", ")}`, "P1S")
    .option("-r, --rotate <x,y,z>", "rotate before analysis (degrees)")
    .option("--infill <percent>", "sparse infill %", "15")
    .option("--walls <n>", "wall loops", "2")
    .option("--json", "print JSON instead of text")
    .option("--no-save", "don't record this run in ~/.phyx3d/runs");

const partOpts = (o: Record<string, string>) => ({
  material: o.material,
  printer: o.printer,
  rotate: parseVec(o.rotate),
  settings: { infill: +o.infill / 100, walls: +o.walls },
});

const program = new Command();
program.name("phyx3d").description("Test 3D prints before printing: printability, stability, physics and strength.").version("0.1.0");

common(program.command("check <file>").description("run all printability & stability checks (STL, 3MF, .gcode.3mf)"))
  .option("--png <file>", "also save an annotated picture")
  .option("--fixed <region...>", "strength check: where the part is held (e.g. bottom, -x, box:0,0,0:10,10,5)")
  .option("--force <spec...>", "strength check: region=fx,fy,fz in newtons (e.g. +x=0,0,-20)")
  .action(async (file: string, o) => {
    const f = loadPath(file);
    const mesh = requireMesh(f);
    let load: LoadCase | undefined;
    if (o.fixed || o.force) {
      load = {
        fixed: (o.fixed ?? ["bottom"]).map(parseRegion),
        loads: (o.force ?? []).map((s: string) => { const [r, v] = s.split("="); return { region: parseRegion(r), force: parseVec(v)! }; }),
      };
    }
    const { report, part, fea } = analyze(mesh, { ...partOpts(o), load });
    if (f.gcode) report.checks.push(checkGcode(f.gcode, (f.meta.sliceInfo as { plates?: never[] })?.plates?.[0]));
    const img = renderReport(part, report, "overview");
    if (o.png) writeFileSync(o.png, img.png);
    const images: Record<string, Uint8Array> = { overview: img.png };
    if (fea) images.stress = renderReport(part, report, "stress", fea).png;
    if (o.save) saveRun("check", f.name, part.mesh, report, images);
    if (o.json) console.log(JSON.stringify(compactReport(report), null, 1));
    else printReport(report);
    process.exitCode = report.verdict === "needs-changes" ? 2 : 0;
  });

common(program.command("stress <file>").description("strength test: hold the part somewhere, push somewhere else"))
  .requiredOption("--fixed <region...>", "held region(s): bottom|top|-x|+x|-y|+y|box:..|sphere:..|rel:0,0,0:0.1,1,1")
  .option("--force <spec...>", "region=fx,fy,fz newtons, e.g. top=0,0,-50")
  .option("--accel <x,y,z>", "body acceleration in g, e.g. 0,0,-1 for own weight")
  .option("--safety <n>", "required safety factor", "2")
  .option("--elements <n>", "FE resolution (solid voxels)", "25000")
  .option("--png <file>", "save the stress picture")
  .action(async (file: string, o) => {
    const f = loadPath(file);
    const part = new Part(requireMesh(f), partOpts(o));
    const lc: LoadCase = {
      fixed: o.fixed.map(parseRegion),
      loads: (o.force ?? []).map((s: string) => { const [r, v] = s.split("="); return { region: parseRegion(r), force: parseVec(v)! }; }),
      acceleration: parseVec(o.accel),
    };
    const t0 = Date.now();
    const s = checkStrength(part, lc, { requiredSafety: +o.safety, elements: +o.elements });
    const { fea, ...check } = s;
    const report = buildReport(part, [check]);
    const img = renderReport(part, report, "stress", fea);
    if (o.png) writeFileSync(o.png, img.png);
    if (o.save) saveRun("stress", f.name, part.mesh, compactCheck(check), { stress: img.png });
    if (o.json) console.log(JSON.stringify(compactCheck(check), null, 1));
    else { printCheck(check); for (const x of check.fixes) console.log(`  → ${x}`); console.log(`  (${check.data.elements} elements, ${Date.now() - t0} ms)`); }
  });

for (const [name, desc] of [["drop", "drop test from a height (random orientations)"], ["tilt", "tilt the table until it tips or slides"], ["push", "push the top sideways until it tips"], ["stack", "stack copies and see if the tower holds"]] as const) {
  const cmd = common(program.command(`${name} <file>`).description(desc));
  if (name === "drop") cmd.option("--height <mm>", "drop height", "1000").option("--floor <type>", "concrete|tile|wood|carpet", "tile").option("--trials <n>", "random orientations", "8");
  if (name === "stack") cmd.option("--count <n>", "copies", "3");
  if (name !== "drop") cmd.option("--orientation <x,y,z>", "how the part sits on the table (degrees)");
  cmd.action(async (file: string, o) => {
    const f = loadPath(file);
    const part = new Part(requireMesh(f), partOpts(o));
    const r: CheckResult =
      name === "drop" ? await dropTest(part, { height: +o.height, floor: o.floor as FloorType, trials: +o.trials })
        : name === "tilt" ? await tiltTest(part, { orientation: parseVec(o.orientation) })
          : name === "push" ? await pushTest(part, { orientation: parseVec(o.orientation) })
            : await stackTest(part, { count: +o.count, orientation: parseVec(o.orientation) });
    if (o.save) saveRun(name, f.name, part.mesh, compactCheck(r));
    if (o.json) console.log(JSON.stringify(compactCheck(r), null, 1));
    else { printCheck(r); for (const x of r.fixes) console.log(`  → ${x}`); }
  });
}

common(program.command("orient <file>").description("compare print orientations and rank them")).action(async (file: string, o) => {
  const f = loadPath(file);
  const res = suggestOrientations(requireMesh(f), partOpts(o));
  if (o.json) return console.log(JSON.stringify(res, null, 1));
  console.log("\nBest print orientations (use --rotate x,y,z with other commands):\n");
  for (const c of res.slice(0, 6)) {
    console.log(`${ICON[c.status]} ${String(c.score).padStart(3)}  rotate ${c.rotation.join(",").padEnd(16)} ${c.label.padEnd(30)} supports ${c.supportArea} mm², islands ${c.islands}, tip ${c.tipAngle}°, height ${c.height} mm`);
  }
  console.log();
});

common(program.command("render <file>").description("save an annotated PNG"))
  .option("--mode <mode>", "overview|overhangs|stability|thin-walls|plain", "overview")
  .option("-o, --out <file>", "output PNG", "phyx3d.png")
  .option("--views <list>", "comma list: iso,below,front,back,left,right,top,iso-back")
  .action(async (file: string, o) => {
    const f = loadPath(file);
    const { report, part } = analyze(requireMesh(f), partOpts(o));
    const img = renderReport(part, report, o.mode as VisualMode, undefined, { views: o.views?.split(",") });
    writeFileSync(o.out, img.png);
    console.log(`Saved ${o.out} (${img.width}×${img.height})`);
  });

program.command("mech <file>").description("simulate a mechanism (.mech.json): robots, vehicles, linkages with joints and motors")
  .option("--duration <s>", "seconds to simulate")
  .option("--png <file>", "save the filmstrip picture")
  .option("--json", "print JSON")
  .option("--no-save", "don't record this run in ~/.phyx3d/runs")
  .action(async (file: string, o) => {
    const t0 = Date.now();
    const { out, png, spec } = await runMechanismFile(file, { duration: o.duration ? +o.duration : undefined });
    if (o.png) writeFileSync(o.png, png);
    if (o.save) saveMechanismRun(spec.name ?? file, spec, out, png);
    if (o.json) return console.log(JSON.stringify(compactCheck(out.check), null, 1));
    printCheck(out.check);
    for (const f of out.check.findings.slice(6)) console.log(`     · ${f.message}`);
    for (const x of out.check.fixes) console.log(`  → ${x}`);
    console.log(`  (${Date.now() - t0} ms)`);
  });

program.command("gcode <file>").description("check a sliced .gcode or Bambu .gcode.3mf").option("--json").action(async (file: string, o) => {
  const f = loadPath(file);
  if (!f.gcode) throw new Error("No G-code in this file.");
  const r = checkGcode(f.gcode, (f.meta.sliceInfo as { plates?: never[] })?.plates?.[0]);
  if (o.json) console.log(JSON.stringify(compactCheck(r), null, 1)); else printCheck(r);
});

program.command("slice <file>").description("slice with Bambu Studio (must be installed)")
  .option("--profiles <dir>", "folder with machine.json, process.json, filament.json (default ~/.phyx3d/profiles)")
  .option("--out <dir>", "output folder", ".")
  .option("--json")
  .action(async (file: string, o) => {
    const r = await sliceWithBambu(file, { profiles: o.profiles, outDir: o.out });
    if (o.json) console.log(JSON.stringify({ output: r.output, check: compactCheck(r.check) }, null, 1));
    else { console.log(`Sliced → ${r.output}`); printCheck(r.check); }
  });

program.command("serve").description("open the web app (shows your files and the agent's latest runs)")
  .option("--port <n>", "port", "5217")
  .action(async (o) => { await startServer(+o.port); });

program.command("doctor").description("check the environment").action(() => {
  console.log(`node ${process.version}`);
  const b = findBambuStudio();
  console.log(b ? `Bambu Studio: ${b.join(" ")}` : "Bambu Studio: not found (only needed for `phyx3d slice`)");
});

program.command("materials").description("list material presets").action(() => {
  for (const m of Object.values(MATERIALS)) console.log(`${m.id.padEnd(8)} ${String(m.tensileXY).padStart(3)} MPa along / ${String(m.tensileZ).padStart(2)} MPa across layers, E=${m.youngsModulus} MPa, ${m.density} g/cm³${m.needsEnclosure ? ", needs enclosure" : ""}`);
});

program.parseAsync().catch((e: Error) => {
  console.error(`phyx3d: ${e.message}`);
  process.exit(1);
});
