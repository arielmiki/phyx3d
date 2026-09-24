// Slice with the real Bambu Studio CLI (optional — only if Bambu Studio is installed).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, copyFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { loadFile, checkGcode, type CheckResult } from "../core/index.js";

export function findBambuStudio(): string[] | null {
  const env = process.env.PHYX3D_BAMBU_STUDIO;
  if (env) return env.split(" ");
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const name of ["bambu-studio", "BambuStudio", "bambu_studio"]) {
    for (const d of pathDirs) if (existsSync(join(d, name))) return [join(d, name)];
  }
  const candidates = [
    "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
    "/opt/bambu-studio/bin/bambu-studio",
    "/usr/bin/bambu-studio",
  ];
  for (const c of candidates) if (existsSync(c)) return [c];
  for (const dir of [join(homedir(), "Applications"), join(homedir(), "Downloads"), homedir()]) {
    if (!existsSync(dir)) continue;
    const app = readdirSync(dir).find((f) => /bambu.*studio.*\.appimage$/i.test(f));
    if (app) return [join(dir, app)];
  }
  if (existsSync("/var/lib/flatpak/app/com.bambulab.BambuStudio") || existsSync(join(homedir(), ".local/share/flatpak/app/com.bambulab.BambuStudio"))) {
    return ["flatpak", "run", "--command=bambu-studio", "com.bambulab.BambuStudio"];
  }
  return null;
}

export interface SliceOptions {
  /** folder with machine.json, process.json, filament.json exported from Bambu Studio */
  profiles?: string;
  machine?: string;
  process?: string;
  filament?: string;
  plate?: number;
  /** auto-orient in Bambu Studio (default off: keep the agent's orientation) */
  orient?: boolean;
  arrange?: boolean;
  outDir?: string;
  timeoutMs?: number;
}

export interface SliceResult {
  output: string;
  check: CheckResult;
  seconds?: number;
  grams?: number;
  log: string;
}

function profileFiles(o: SliceOptions): { machine?: string; process?: string; filament?: string } {
  const dir = o.profiles ?? process.env.PHYX3D_PROFILES ?? join(homedir(), ".phyx3d", "profiles");
  const pick = (explicit: string | undefined, kind: string) => {
    if (explicit) return resolve(explicit);
    if (!existsSync(dir)) return undefined;
    const f = readdirSync(dir).find((n) => n.toLowerCase().startsWith(kind) && n.endsWith(".json"));
    return f ? join(dir, f) : undefined;
  };
  return { machine: pick(o.machine, "machine"), process: pick(o.process, "process"), filament: pick(o.filament, "filament") };
}

export async function sliceWithBambu(input: string, o: SliceOptions = {}): Promise<SliceResult> {
  const exe = findBambuStudio();
  if (!exe) {
    throw new Error(
      "Bambu Studio not found. Install it (AppImage from https://github.com/bambulab/BambuStudio/releases, or flatpak com.bambulab.BambuStudio) " +
        "or set PHYX3D_BAMBU_STUDIO to its path.",
    );
  }
  const prof = profileFiles(o);
  const isProject = input.toLowerCase().endsWith(".3mf");
  if (!isProject && (!prof.machine || !prof.process || !prof.filament)) {
    throw new Error(
      "Slicing an STL needs Bambu Studio profiles. Put machine.json, process.json and filament.json (exported from Bambu Studio: " +
        "Printer/Process/Filament → ⋯ → Export) into ~/.phyx3d/profiles, or pass a .3mf project saved from Bambu Studio (it carries its own settings).",
    );
  }
  const work = mkdtempSync(join(tmpdir(), "phyx3d-slice-"));
  const src = join(work, basename(input));
  copyFileSync(input, src);
  const outName = basename(input).replace(/(\.gcode)?\.(stl|3mf|obj|step)$/i, "") + ".gcode.3mf";
  const args = [
    ...exe.slice(1),
    "--slice", String(o.plate ?? 0),
    "--arrange", o.arrange === false ? "0" : "1",
    "--orient", o.orient ? "1" : "0",
    "--allow-newer-file",
    "--min-save",
    "--export-3mf", outName,
    "--outputdir", work,
  ];
  if (prof.machine && prof.process) args.push("--load-settings", `${prof.machine};${prof.process}`);
  if (prof.filament) args.push("--load-filaments", prof.filament);
  args.push(src);
  const log = await new Promise<string>((res, rej) => {
    const p = spawn(exe[0], args, { cwd: work, env: { ...process.env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { p.kill("SIGKILL"); rej(new Error("Bambu Studio timed out")); }, o.timeoutMs ?? 300_000);
    p.on("error", (e) => { clearTimeout(timer); rej(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) rej(new Error(`Bambu Studio exited with code ${code}.\n${out.slice(-2000)}`));
      else res(out);
    });
  });
  const produced = join(work, outName);
  if (!existsSync(produced) || statSync(produced).size === 0) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`Bambu Studio finished but produced no ${outName}.\n${log.slice(-2000)}`);
  }
  const outDir = resolve(o.outDir ?? ".");
  const final = join(outDir, outName);
  copyFileSync(produced, final);
  rmSync(work, { recursive: true, force: true }); // Bambu leaves hundreds of MB of temp files
  const loaded = loadFile(final, new Uint8Array(readFileSync(final)));
  const info = (loaded.meta.sliceInfo as { plates?: { predictionSeconds?: number; weightGrams?: number }[] } | undefined)?.plates?.[0];
  const check = loaded.gcode ? checkGcode(loaded.gcode, info) : { id: "gcode", title: "Sliced G-code", status: "info" as const, summary: "No G-code found in output", accuracy: "exact" as const, findings: [], fixes: [], data: {} };
  return { output: final, check, seconds: info?.predictionSeconds, grams: info?.weightGrams, log: log.slice(-1500) };
}
