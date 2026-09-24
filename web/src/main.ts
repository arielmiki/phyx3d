import "./style.css";
import { Viewer, type Overlays, type MarkerSpec, featureColor } from "./viewer";
import { MATERIALS, PRINTERS } from "../../src/core/materials.js";
import type { Report, CheckResult, PartOptions, Region } from "../../src/core/index.js";

// ------------------------------------------------------------------ worker RPC
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let rpcId = 0;
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
worker.onmessage = (e) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  if (e.data.ok) p.res(e.data.res); else p.rej(new Error(e.data.error));
};
function call<T>(req: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = ++rpcId;
  return new Promise<T>((res, rej) => { pending.set(id, { res: res as (v: unknown) => void, rej }); worker.postMessage({ id, req }, transfer); });
}

// ------------------------------------------------------------------ state
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];
const viewer = new Viewer($("#viewport"));

interface GcodeData { segments: Float32Array; extruding: Uint8Array; feature: Uint8Array; features: string[]; layers: { z: number; start: number; end: number }[]; stats: { layers: number } }
interface AnalyzeRes { report: Report; positions: Float32Array; indices: Uint32Array; com: number[]; lift: number; rotation: number[]; bbox: { min: number[]; max: number[]; size: number[] }; grams: number }

const state: {
  name?: string;
  meshId?: number;
  analysis?: AnalyzeRes;
  gcode?: GcodeData;
  gflags?: Uint8Array;
  overlays: Overlays;
  pick?: [number, number, number];
} = { overlays: { overhangs: true, stability: true, markers: true, stress: false, bed: true } };

// ------------------------------------------------------------------ settings UI
for (const p of Object.values(PRINTERS)) $("#printer").insertAdjacentHTML("beforeend", `<option value="${p.id}">${p.name.replace("Bambu Lab ", "")}</option>`);
for (const m of Object.values(MATERIALS)) $("#material").insertAdjacentHTML("beforeend", `<option value="${m.id}">${m.name}</option>`);
try {
  const saved = JSON.parse(localStorage.getItem("phyx3d.settings") ?? "{}");
  if (saved.printer) ($("#printer") as HTMLSelectElement).value = saved.printer;
  if (saved.material) ($("#material") as HTMLSelectElement).value = saved.material;
} catch { /* storage unavailable */ }

// short screens (laptops): start with print settings collapsed so the verdict is visible
if (window.innerHeight < 820) ($("#settings") as HTMLDetailsElement).open = false;
function updateSettingsSummary() {
  const o = partOptions();
  const rot = o.rotate?.some((a) => a) ? ` · rot ${o.rotate.join(",")}` : "";
  $("#settings-sum").textContent = `${o.printer} · ${o.material} · ${Math.round((o.settings?.infill ?? 0) * 100)}% · ${o.settings?.walls} walls${rot}`;
}

function partOptions(): PartOptions {
  const num = (id: string) => +($(id) as HTMLInputElement).value || 0;
  return {
    printer: ($("#printer") as HTMLSelectElement).value,
    material: ($("#material") as HTMLSelectElement).value,
    rotate: [num("#rx"), num("#ry"), num("#rz")],
    settings: { infill: num("#infill") / 100, walls: Math.max(1, num("#walls")) },
  };
}

let reanalyzeTimer = 0;
function scheduleAnalyze() {
  try { localStorage.setItem("phyx3d.settings", JSON.stringify({ printer: ($("#printer") as HTMLSelectElement).value, material: ($("#material") as HTMLSelectElement).value })); } catch { /* ignore */ }
  clearTimeout(reanalyzeTimer);
  updateSettingsSummary();
  reanalyzeTimer = window.setTimeout(() => runAnalyze(), 250);
}
for (const id of ["#printer", "#material", "#walls", "#rx", "#ry", "#rz"]) $(id).addEventListener("change", scheduleAnalyze);
$("#infill").addEventListener("input", () => { $("#infill-out").textContent = `${($("#infill") as HTMLInputElement).value}%`; scheduleAnalyze(); });
$("#btn-rot-reset").addEventListener("click", () => { for (const id of ["#rx", "#ry", "#rz"]) ($(id) as HTMLInputElement).value = "0"; $("#orient-list").innerHTML = ""; scheduleAnalyze(); });

// ------------------------------------------------------------------ busy / hint
let busyCount = 0;
async function busy<T>(text: string, f: () => Promise<T>): Promise<T> {
  busyCount++;
  $("#busy-text").textContent = text;
  $("#busy").hidden = false;
  try { return await f(); } finally { if (--busyCount === 0) $("#busy").hidden = true; }
}
function hint(text: string | null) { $("#hint").hidden = !text; $("#hint").textContent = text ?? ""; }
function toast(text: string) { hint(text); setTimeout(() => hint(null), 3500); }

// ------------------------------------------------------------------ loading files
async function openBytes(name: string, bytes: ArrayBuffer, opts: { keepSettings?: boolean } = {}) {
  closeSim();
  const res = await busy(`Reading ${name}…`, () => call<{ name: string; meshId?: number; gcode?: GcodeData; gcheck?: CheckResult; gflags?: Uint8Array }>({ type: "load", name, bytes }, [bytes]));
  state.name = name;
  state.meshId = res.meshId;
  state.analysis = undefined;
  viewer.clearModel();
  viewer.clearGcode();
  $("#gcode-bar").hidden = true;
  $("#stress-result").innerHTML = "";
  $("#physics-result").innerHTML = "";
  $("#orient-list").innerHTML = "";
  state.pick = undefined;
  setOverlay("stress", false);
  if (!opts.keepSettings) for (const id of ["#rx", "#ry", "#rz"]) ($(id) as HTMLInputElement).value = "0";
  if (res.gcode) {
    state.gcode = res.gcode;
    state.gflags = res.gflags;
    showGcode(res.gcheck!);
  } else {
    state.gcode = undefined;
    $("#gcode-result").innerHTML = "";
  }
  if (res.meshId) await runAnalyze();
  else { renderGcodeOnlyReport(res.gcheck); switchTab("gcode"); }
}

async function openUrl(url: string, name: string, opts?: { keepSettings?: boolean }) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url}`);
  await openBytes(name, await r.arrayBuffer(), opts);
}

$("#file").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await openBytes(f.name, await f.arrayBuffer()).catch(showError);
});
const drop = $("#drop");
for (const target of [drop, $("#stage")]) {
  target.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  target.addEventListener("dragleave", () => drop.classList.remove("over"));
  target.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) await openBytes(f.name, await f.arrayBuffer()).catch(showError);
  });
}
for (const b of $$("[data-example]")) b.addEventListener("click", () => openUrl(`examples/${b.dataset.example}`, b.dataset.example!).catch(showError));

function showError(e: Error) { console.error(e); toast(`⚠ ${e.message}`); }

// ------------------------------------------------------------------ analysis
async function runAnalyze() {
  if (!state.meshId) return;
  updateSettingsSummary();
  const a = await busy("Analysing…", () => call<AnalyzeRes>({ type: "analyze", meshId: state.meshId, opts: partOptions() })).catch((e) => { showError(e); return null; });
  if (!a) return;
  const first = !state.analysis;
  state.analysis = a;
  viewer.setModel(a.positions, a.indices, a.bbox);
  // sliced files: toolpath is the main view, the solid model can be toggled on
  viewer.modelGroup.visible = !state.gcode || ($("#gc-model") as HTMLInputElement).checked;
  const oh = a.report.checks.find((c) => c.id === "overhangs")?.data as { faceAngles?: number[] } | undefined;
  if (oh?.faceAngles) viewer.setOverhangs(oh.faceAngles);
  const st = a.report.checks.find((c) => c.id === "stability")?.data as { centerOfMass: number[]; supportPolygon: [number, number][] } | undefined;
  if (st) viewer.setStability(st.centerOfMass, st.supportPolygon, a.bbox.min[2]);
  viewer.setMarkers(collectMarkers(a.report));
  viewer.showPick(state.pick ?? null);
  setOverlay("stress", false);
  viewer.applyOverlays(state.overlays);
  if (first && !state.gcode) viewer.setView("iso");
  renderReport(a.report);
}

function collectMarkers(r: Report): MarkerSpec[] {
  const out: MarkerSpec[] = [];
  const isl = r.checks.find((c) => c.id === "islands")?.data as { islands?: { center: [number, number, number]; z: number }[] } | undefined;
  for (const i of (isl?.islands ?? []).slice(0, 8)) out.push({ at: i.center, color: "#e04ce0", label: `floating @ z${i.z}` });
  const tw = r.checks.find((c) => c.id === "thin-walls")?.data as { spots?: { at: [number, number, number]; thickness: number }[] } | undefined;
  for (const s of (tw?.spots ?? []).slice(0, 8)) out.push({ at: s.at, color: s.thickness < 0.4 ? "#ff5c5c" : "#f5b041", label: `${s.thickness} mm wall` });
  return out;
}

// ------------------------------------------------------------------ report panel
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function renderReport(r: Report) {
  const cls = r.verdict === "ready" ? "pass" : r.verdict === "needs-changes" ? "fail" : "warn";
  $("#verdict").innerHTML = `
    <div class="score ${cls}">${r.score}</div>
    <div><div class="headline">${esc(r.headline)}</div>
    <div class="meta">${esc(state.name ?? "")} · ${r.part.material} · ${r.part.size.join(" × ")} mm</div></div>`;
  $("#checks").innerHTML = r.checks.map((c, i) => checkHtml(c, i, c.status === "fail")).join("");
  bindFindings(r.checks);
}

function checkHtml(c: CheckResult, i: number, open: boolean): string {
  const items = c.findings.filter((f) => f.message !== c.summary).slice(0, 8)
    .map((f, j) => `<li class="${f.at ? "loc" : ""}" data-check="${i}" data-finding="${j}">${esc(f.message)}</li>`).join("");
  const fixes = c.fixes.map((f) => `<div class="fix">${esc(f)}</div>`).join("");
  return `<details class="check" ${open ? "open" : ""}>
    <summary><span class="dot ${c.status}"></span><div><div class="t">${esc(c.title)}<em>${c.accuracy}</em></div><div class="s">${esc(c.summary)}</div></div></summary>
    ${items || fixes ? `<div class="body">${items ? `<ul>${items}</ul>` : ""}${fixes}</div>` : ""}
  </details>`;
}

function bindFindings(checks: CheckResult[]) {
  for (const li of $$("li.loc")) {
    li.addEventListener("click", () => {
      const f = checks[+li.dataset.check!].findings.filter((x) => x.message !== checks[+li.dataset.check!].summary)[+li.dataset.finding!];
      if (f?.at) { viewer.showPick(f.at); toast(`(${f.at.join(", ")}) mm`); }
    });
  }
}

function renderGcodeOnlyReport(c?: CheckResult) {
  $("#verdict").innerHTML = c ? `<div class="score ${c.status === "fail" ? "fail" : c.status === "warn" ? "warn" : "pass"}">G</div><div><div class="headline">${esc(c.summary)}</div><div class="meta">${esc(state.name ?? "")}</div></div>` : "";
  $("#checks").innerHTML = c ? checkHtml(c, 0, true) : "";
  if (c) bindFindings([c]);
}

// ------------------------------------------------------------------ overlays & views
function setOverlay(k: keyof Overlays, on: boolean) {
  state.overlays[k] = on;
  $(`[data-ov="${k}"]`).classList.toggle("on", on);
  viewer.applyOverlays(state.overlays);
}
for (const b of $$("[data-ov]")) b.addEventListener("click", () => setOverlay(b.dataset.ov as keyof Overlays, !state.overlays[b.dataset.ov as keyof Overlays]));
for (const b of $$("[data-view]")) b.addEventListener("click", () => viewer.setView(b.dataset.view as "iso"));

// ------------------------------------------------------------------ tabs
function switchTab(t: string) {
  for (const b of $$(".tabs button")) b.classList.toggle("on", b.dataset.tab === t);
  for (const s of $$(".tab")) s.classList.toggle("on", s.id === `tab-${t}`);
  if (t === "agent") refreshRuns();
}
for (const b of $$(".tabs button")) b.addEventListener("click", () => switchTab(b.dataset.tab!));

// ------------------------------------------------------------------ orientation
$("#btn-orient").addEventListener("click", async () => {
  if (!state.meshId) return toast("Open a model first");
  const opts = partOptions();
  const list = await busy("Trying orientations…", () => call<{ rotation: number[]; label: string; score: number; supportArea: number; islands: number; tipAngle: number; height: number; status: string }[]>({ type: "orient", meshId: state.meshId, opts: { ...opts, rotate: [0, 0, 0] } })).catch(showError);
  if (!list) return;
  $("#orient-list").innerHTML = list.map((c, i) => `
    <button class="orient" data-i="${i}"><b>${c.score}</b>
      <span><span>${esc(c.label)}</span><br><span class="sub">supports ${c.supportArea} mm² · ${c.islands ? `${c.islands} islands · ` : ""}tip ${c.tipAngle}° · ${c.height} mm tall</span></span>
      <span class="pill ${c.status}">${c.status}</span></button>`).join("");
  for (const b of $$(".orient")) b.addEventListener("click", () => {
    const c = list[+b.dataset.i!];
    ["#rx", "#ry", "#rz"].forEach((id, k) => (($(id) as HTMLInputElement).value = String(Math.round(c.rotation[k] * 10) / 10)));
    runAnalyze();
  });
});

// ------------------------------------------------------------------ strength
function parseRegion(v: string): Region {
  if (v.startsWith("rel:")) { const [, a, b] = v.split(":"); return { rel: { min: a.split(",").map(Number) as never, max: b.split(",").map(Number) as never } }; }
  return { face: v as "top" };
}
$("#load-at").addEventListener("change", () => {
  if (($("#load-at") as HTMLSelectElement).value !== "pick") return;
  if (!state.analysis) return toast("Open a model first");
  hint("Click on the model where the force pushes");
  setOverlay("stress", false);
  viewer.pickOnce((p) => { state.pick = p; viewer.showPick(p); hint(null); toast(`Load point (${p.map((v) => v.toFixed(1)).join(", ")})`); });
});
$("#force").addEventListener("input", () => { const n = +($("#force") as HTMLInputElement).value; $("#force-hint").textContent = `${n} N ≈ ${(n / 9.81).toFixed(1)} kg hanging on it.`; });

$("#btn-stress").addEventListener("click", async () => {
  if (!state.meshId) return toast("Open a model first");
  const at = ($("#load-at") as HTMLSelectElement).value;
  const F = +($("#force") as HTMLInputElement).value;
  const dir = ($("#force-dir") as HTMLSelectElement).value.split(",").map((v) => +v * F) as [number, number, number];
  if (at === "pick" && !state.pick) return toast("Pick a load point on the model first");
  const load = {
    fixed: [parseRegion(($("#fixed") as HTMLSelectElement).value)],
    loads: at === "pick" ? [] : [{ region: parseRegion(at), force: dir }],
    ...(at === "pick" ? { pickPrint: state.pick, pickForce: dir, pickRadius: Math.max(3, (state.analysis?.bbox.size[0] ?? 40) * 0.06) } : {}),
  };
  const res = await busy("Solving stresses…", () => call<{ check: CheckResult; grid: never; elements: Int32Array; safety: Float32Array; rotation: number[]; lift: number }>({ type: "stress", meshId: state.meshId, opts: partOptions(), load, elements: +($("#fea-res") as HTMLSelectElement).value })).catch(showError);
  if (!res) return;
  viewer.setStress(res.grid, res.elements, res.safety, res.rotation, res.lift);
  setOverlay("stress", true);
  const d = res.check.data as { minSafetyFactor: number; failureMode: string; maxDeflection: number; weakestAt: number[]; maxVonMises: number; elements: number; strengthKnockdown: number };
  $("#stress-result").innerHTML = `
    <span class="pill ${res.check.status}">${res.check.status}</span>
    <div class="big">SF ${d.minSafetyFactor}</div>
    <div>${esc(res.check.summary)}</div>
    <div class="legend-bar"></div><div class="legend-labels"><span>&lt;1 breaks</span><span>2</span><span>3</span><span>strong</span></div>
    <table>
      <tr><td>Weak spot (design mm)</td><td>${d.weakestAt.join(", ")}</td></tr>
      <tr><td>Fails</td><td>${d.failureMode}</td></tr>
      <tr><td>Peak stress</td><td>${d.maxVonMises} MPa</td></tr>
      <tr><td>Max bend</td><td>${d.maxDeflection} mm</td></tr>
      <tr><td>Infill/wall knock-down</td><td>×${d.strengthKnockdown}</td></tr>
      <tr><td>Elements</td><td>${d.elements}</td></tr>
    </table>
    ${res.check.fixes.map((f) => `<div class="fix">${esc(f)}</div>`).join("")}`;
});

// ------------------------------------------------------------------ physics
type Frame = { t: number; p: number[]; q: number[] };
let sim: { frames: Frame[][]; kind: string; tilt: boolean; playing: boolean; start: number; t0: number; follow?: number } | null = null;

for (const b of $$("[data-sim]")) b.addEventListener("click", () => runPhysics(b.dataset.sim as "drop").catch(showError));

async function runPhysics(kind: "drop" | "tilt" | "push" | "stack") {
  if (!state.meshId || !state.analysis) return toast("Open a model first");
  const params = { height: +($("#drop-h") as HTMLInputElement).value, floor: ($("#drop-floor") as HTMLSelectElement).value, count: +($("#stack-n") as HTMLInputElement).value };
  const { result: r, com } = await busy(`Simulating ${kind}…`, () => call<{ result: CheckResult; com: number[] }>({ type: "physics", meshId: state.meshId, opts: partOptions(), scenario: kind, params }));
  const d = r.data as Record<string, unknown>;
  $("#physics-result").innerHTML = `<span class="pill ${r.status}">${r.status}</span> <b>${esc(r.title)}</b><p>${esc(r.summary)}</p>
    <ul>${r.findings.slice(0, 8).map((f) => `<li>${esc(f.message)}</li>`).join("")}</ul>${r.fixes.map((f) => `<div class="fix">${esc(f)}</div>`).join("")}`;
  // playback
  let frames: Frame[][] = [];
  const trialSel = $("#sim-trial") as HTMLSelectElement;
  trialSel.hidden = true;
  if (kind === "drop") {
    const trials = d.trials as { frames: Frame[]; peakG: number; restsOn: string }[];
    trialSel.innerHTML = trials.map((t, i) => `<option value="${i}">drop ${i + 1}: ${t.peakG} g, lands on ${esc(t.restsOn)}</option>`).join("");
    trialSel.hidden = false;
    const worstI = trials.reduce((bi, t, i) => (t.peakG > trials[bi].peakG ? i : bi), 0);
    trialSel.value = String(worstI);
    trialSel.onchange = () => playSim([trimDrop(trials[+trialSel.value].frames)], "drop", com);
    frames = [trimDrop(trials[worstI].frames)];
  } else if (kind === "tilt") frames = [(d.frames as Frame[]) ?? []];
  else if (kind === "stack") frames = (d.frames as Frame[][]) ?? [];
  if (frames.length && frames[0].length) playSim(frames, kind, com);
}

/** start the drop replay shortly before impact — a 1 m fall is mostly empty air */
function trimDrop(frames: Frame[]): Frame[] {
  const size = Math.max(...(state.analysis?.bbox.size ?? [50]));
  const i = frames.findIndex((f) => f.p[2] < size * 3);
  return frames.slice(Math.max(0, i - 3));
}

function playSim(frames: Frame[][], kind: string, com: number[]) {
  const size = Math.max(...(state.analysis?.bbox.size ?? [50]));
  viewer.startSim(frames.length, com, kind === "tilt" ? size * 8 : Math.max(600, size * 12));
  const last = frames[0][frames[0].length - 1];
  // tilt rotates the whole world about the origin, so keep the camera on the table centre
  if (kind === "tilt") viewer.frameSim([0, 0, size * 0.4], size * 2.2);
  else viewer.frameSim([last.p[0], last.p[1], size * (kind === "stack" ? frames.length / 2 : 0.5)], size * (kind === "stack" ? frames.length * 0.8 : 1.4));
  sim = { frames, kind, tilt: kind === "tilt", playing: true, start: frames[0][0].t, t0: performance.now() };
  $("#sim-bar").hidden = false;
  $("#gcode-bar").hidden = true;
}

function simFrame(now: number) {
  requestAnimationFrame(simFrame);
  if (!sim) return;
  const f0 = sim.frames[0];
  const dur = f0[f0.length - 1].t - sim.start;
  // drop/stack play at ~0.5× speed; tilt frames are degrees, played at 8°/s
  const speed = sim.tilt ? 8 : sim.kind === "drop" ? 0.35 : sim.kind === "mechanism" ? 1 : 0.8;
  let t: number;
  if (sim.playing) {
    t = sim.start + ((now - sim.t0) / 1000) * speed;
    if (t >= sim.start + dur) { t = sim.start + dur; sim.playing = false; }
    ($("#sim-time") as HTMLInputElement).value = String(Math.round(((t - sim.start) / Math.max(dur, 1e-6)) * 1000));
  } else t = sim.start + (+($("#sim-time") as HTMLInputElement).value / 1000) * dur;
  sim.frames.forEach((fr, i) => {
    let k = fr.findIndex((f) => f.t >= t);
    if (k < 0) k = fr.length - 1;
    viewer.setSimPose(i, fr[k].p, fr[k].q);
    if (sim!.tilt && i === 0) viewer.setSimTilt(fr[k].t);
    if (sim!.follow === i && ($("#mech-follow") as HTMLInputElement).checked) viewer.follow(fr[k].p[0] + mechCenter[0], fr[k].p[1] + mechCenter[1], mechCenter[2]);
  });
  if (sim.kind === "mechanism") drawMechCursor(t - sim.start);
  $("#sim-out").textContent = sim.tilt ? `table ${t.toFixed(1)}°` : `t = ${(t - sim.start).toFixed(2)} s`;
}
requestAnimationFrame(simFrame);
$("#sim-play").addEventListener("click", () => { if (sim) { sim.playing = true; sim.t0 = performance.now(); } });
$("#sim-time").addEventListener("input", () => { if (sim) sim.playing = false; });
$("#sim-close").addEventListener("click", closeSim);
function closeSim() {
  sim = null;
  viewer.stopSim();
  $("#sim-bar").hidden = true;
  viewer.applyOverlays(state.overlays);
  if (state.analysis) viewer.setView("iso");
}

// ------------------------------------------------------------------ mechanisms
interface MechRes { check: CheckResult; parts: { id: string; positions: Float32Array; indices: Uint32Array; color: number[] }[]; frames: { times: number[]; bodies: { id: string; poses: number[] }[]; joints: { id: string; values: number[] }[] }; floor: boolean }
const mech: { spec?: unknown; files: Record<string, ArrayBuffer>; last?: MechRes } = { files: {} };
let mechCenter = [0, 0, 0];

for (const b of $$("[data-mech]")) b.addEventListener("click", () => loadMechUrl(`examples/mechanisms/${b.dataset.mech}`).then(runMechanism).catch(showError));

async function loadMechUrl(url: string) {
  const spec = await (await fetch(url)).json();
  const dir = url.slice(0, url.lastIndexOf("/") + 1);
  mech.files = {};
  for (const p of spec.parts ?? []) if (p.file) mech.files[p.file] = await (await fetch(dir + p.file)).arrayBuffer();
  setMechSpec(spec);
}

function setMechSpec(spec: unknown) {
  mech.spec = spec;
  ($("#mech-json") as HTMLTextAreaElement).value = JSON.stringify(spec, null, 1);
  switchTab("mech");
}

$("#mech-file").addEventListener("change", async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  const json = files.find((f) => f.name.endsWith(".json"));
  if (!json) return toast("Select the .mech.json file (and its STL parts)");
  mech.files = {};
  for (const f of files) if (f !== json) mech.files[f.name] = await f.arrayBuffer();
  try { setMechSpec(JSON.parse(await json.text())); await runMechanism(); } catch (err) { showError(err as Error); }
});

$("#btn-mech").addEventListener("click", () => runMechanism().catch(showError));

async function runMechanism() {
  let spec: unknown;
  try { spec = JSON.parse(($("#mech-json") as HTMLTextAreaElement).value); } catch (e) { throw new Error(`Spec is not valid JSON: ${(e as Error).message}`); }
  mech.spec = spec;
  const dur = +($("#mech-dur") as HTMLInputElement).value || undefined;
  const res = await busy("Simulating mechanism…", () => call<MechRes>({ type: "mechanism", spec, files: mech.files, duration: dur }));
  showMechanism(res);
}

function showMechanism(res: MechRes) {
  mech.last = res;
  const c = res.check;
  const d = c.data as { mobile: boolean; distance: number; speed: number; headingChange: number; maxTilt: number; fell: boolean; track: string; duration: number;
    motors: { joint: string; preset?: string; unit: string; rated: number; peak: number; p95: number; saturated: number }[]; jointRanges: { joint: string; min: number; max: number; unit: string }[] };
  const metric = (v: string, l: string) => `<div class="metric"><b>${v}</b><span>${l}</span></div>`;
  const metrics = d.mobile
    ? metric(`${d.distance} mm`, `travelled in ${d.duration} s`) + metric(`${d.speed} mm/s`, "average speed") + metric(`${d.headingChange}°`, "heading drift") + metric(d.fell ? "FELL" : `${d.maxTilt}°`, d.fell ? "fell over" : "max tilt")
    : d.jointRanges.slice(0, 4).map((r) => metric(r.max - r.min > 350 && r.unit === "°" ? "full turns" : `${Math.round((r.max - r.min) * 10) / 10} ${r.unit}`, `${r.joint} travel`)).join("");
  $("#mech-result").innerHTML = `
    <span class="pill ${c.status}">${c.status}</span> <b>${esc(c.title)}</b>
    <p>${esc(c.summary)}</p>
    <div class="metrics">${metrics}</div>
    ${d.motors.map((m, i) => `<div class="motor"><div class="mh"><b>${esc(m.joint)}</b><span>${m.preset ?? ""} · typ ${m.p95} / peak ${m.peak} of ${m.rated} ${m.unit}</span></div>
      <div class="bar"><i class="peak" style="width:${Math.min(100, (m.peak / m.rated) * 100)}%"></i><i class="typ" style="width:${Math.min(100, (m.p95 / m.rated) * 100)}%"></i></div>
      <canvas data-motor="${i}"></canvas></div>`).join("")}
    <ul>${c.findings.filter((f) => !/^Motor /.test(f.message)).slice(0, 10).map((f) => `<li>${esc(f.message)}</li>`).join("")}</ul>
    ${c.fixes.map((f) => `<div class="fix">${esc(f)}</div>`).join("")}`;
  drawMechCursor(0);
  playMechanism(res);
}

/** torque-over-time sparkline per motor, with a playback cursor */
function drawMechCursor(t: number) {
  const res = mech.last;
  if (!res) return;
  for (const cv of $$<HTMLCanvasElement>("canvas[data-motor]")) {
    const v = res.frames.joints[+cv.dataset.motor!]?.values;
    if (!v) continue;
    const w = (cv.width = cv.clientWidth * devicePixelRatio), h = (cv.height = 34 * devicePixelRatio);
    const ctx = cv.getContext("2d")!;
    const T = v[v.length - 3] || 1;
    ctx.fillStyle = "rgba(255,92,92,.12)";
    ctx.fillRect(0, 0, w, h * 0.06);
    ctx.fillRect(0, h * 0.94, w, h * 0.06);
    ctx.strokeStyle = "#7c8cff";
    ctx.lineWidth = devicePixelRatio;
    ctx.beginPath();
    for (let i = 0; i < v.length; i += 3) {
      const x = (v[i] / T) * w, y = h / 2 - v[i + 2] * (h / 2 - 2);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "#e8eaf2";
    ctx.fillRect((t / T) * w, 0, devicePixelRatio, h);
  }
}

function playMechanism(res: MechRes) {
  const f = res.frames;
  const frames: Frame[][] = f.bodies.map((b) => f.times.map((t, k) => ({ t, p: b.poses.slice(k * 7, k * 7 + 3), q: b.poses.slice(k * 7 + 3, k * 7 + 7) })));
  const { center, size } = viewer.startMechanism(res.parts, res.floor);
  mechCenter = [0, 0, center[2]];
  const d0 = res.check.data as { mobile: boolean };
  viewer.frameSim(center, size * (d0.mobile ? 2.2 : 1.3));
  const d = res.check.data as { mobile: boolean; track: string };
  const follow = d.mobile ? res.parts.findIndex((p) => p.id === d.track) : -1;
  sim = { frames, kind: "mechanism", tilt: false, playing: true, start: f.times[0] ?? 0, t0: performance.now(), follow };
  ($("#sim-trial") as HTMLSelectElement).hidden = true;
  $("#sim-bar").hidden = false;
  $("#gcode-bar").hidden = true;
}

// ------------------------------------------------------------------ G-code
let gcPlay = 0;
function showGcode(c: CheckResult) {
  const g = state.gcode!;
  const opts = { travel: ($("#gc-travel") as HTMLInputElement).checked, air: ($("#gc-air") as HTMLInputElement).checked };
  viewer.setGcode(g, state.gflags ?? null, opts);
  const slider = $("#gc-layer") as HTMLInputElement;
  slider.max = String(g.layers.length);
  slider.value = String(g.layers.length);
  viewer.showLayers(g.layers.length);
  $("#gc-layer-out").textContent = `layer ${g.layers.length}/${g.layers.length}`;
  const used = g.features.filter((f) => f !== "Unknown").slice(0, 14);
  $("#gc-legend").innerHTML = used.map((f) => `<span><i style="background:rgb(${featureColor(f).map((v) => Math.round(v * 255)).join(",")})"></i>${esc(f)}</span>`).join("") + `<span><i style="background:#ff1ae6"></i>printed over air</span>`;
  $("#gcode-bar").hidden = false;
  viewer.setView("iso");
  const d = c.data as { layers: number; seconds: number; grams: number; hasSupport: boolean; unsupported: { layer: number; mm: number }[] };
  const h = Math.floor(d.seconds / 3600), m = Math.round((d.seconds % 3600) / 60);
  $("#gcode-result").innerHTML = `<span class="pill ${c.status}">${c.status}</span>
    <table><tr><td>Layers</td><td>${d.layers}</td></tr><tr><td>Print time</td><td>${h ? `${h}h ` : ""}${m}m</td></tr>
    <tr><td>Filament</td><td>${d.grams} g</td></tr><tr><td>Supports</td><td>${d.hasSupport ? "yes" : "no"}</td></tr></table>
    <p>${esc(c.summary)}</p>
    ${d.unsupported.slice(0, 12).map((u) => `<button class="ghost small" data-layer="${u.layer}">layer ${u.layer}: ${u.mm} mm</button>`).join(" ")}`;
  for (const b of $$("[data-layer]")) b.addEventListener("click", () => setLayer(+b.dataset.layer!));
  switchTab("gcode");
}
function setLayer(n: number) {
  const g = state.gcode;
  if (!g) return;
  ($("#gc-layer") as HTMLInputElement).value = String(n);
  viewer.showLayers(n);
  $("#gc-layer-out").textContent = `layer ${n}/${g.layers.length} · z ${g.layers[n - 1]?.z.toFixed(2)}`;
}
$("#gc-model").addEventListener("change", () => { viewer.modelGroup.visible = ($("#gc-model") as HTMLInputElement).checked; });
$("#gc-layer").addEventListener("input", () => { cancelAnimationFrame(gcPlay); setLayer(+($("#gc-layer") as HTMLInputElement).value); });
for (const id of ["#gc-travel", "#gc-air"]) $(id).addEventListener("change", () => {
  if (!state.gcode) return;
  const n = +($("#gc-layer") as HTMLInputElement).value;
  viewer.setGcode(state.gcode, state.gflags ?? null, { travel: ($("#gc-travel") as HTMLInputElement).checked, air: ($("#gc-air") as HTMLInputElement).checked });
  setLayer(n);
});
$("#gc-play").addEventListener("click", () => {
  const g = state.gcode;
  if (!g) return;
  cancelAnimationFrame(gcPlay);
  let layer = 1, frac = 0;
  const perLayer = Math.max(0.15, 12 / g.layers.length); // whole print in ~12 s
  let last = performance.now();
  const step = (now: number) => {
    frac += (now - last) / 1000 / perLayer;
    last = now;
    while (frac >= 1 && layer < g.layers.length) { frac -= 1; layer++; }
    ($("#gc-layer") as HTMLInputElement).value = String(layer);
    viewer.showLayers(layer, Math.min(1, frac));
    $("#gc-layer-out").textContent = `layer ${layer}/${g.layers.length} · z ${g.layers[layer - 1].z.toFixed(2)}`;
    if (layer < g.layers.length || frac < 1) gcPlay = requestAnimationFrame(step);
  };
  gcPlay = requestAnimationFrame(step);
});

// ------------------------------------------------------------------ agent runs (served by `phyx3d serve`)
interface Run { id: string; name: string; time: string; kind: string; verdict?: string; score?: number; headline?: string }
let lastRunId: string | null = null;
let serverMode = false;

async function refreshRuns(autoOpen = false) {
  let runs: Run[];
  try {
    const r = await fetch("api/runs");
    if (!r.ok) throw new Error();
    runs = await r.json();
    serverMode = true;
  } catch {
    $("#agent-status").innerHTML = "Not connected. Start the app with <code>phyx3d serve</code> to see what Claude Code tests, live.";
    return;
  }
  $("#agent-status").textContent = runs.length ? "Checks run by Claude Code and the phyx3d CLI:" : "No runs yet — ask Claude Code to design something and test it with phyx3d.";
  $("#agent-dot").classList.add("live");
  $("#runs").innerHTML = runs.slice(0, 40).map((r) => {
    const cls = r.verdict === "ready" || r.verdict === "pass" ? "pass" : r.verdict === "needs-changes" || r.verdict === "fail" ? "fail" : r.verdict === "info" ? "info" : "warn";
    return `<button class="run" data-run="${esc(r.id)}"><span class="n">${esc(r.name)}</span><span class="pill ${cls}">${r.kind}${r.score !== undefined ? ` ${r.score}` : ""}</span>
      <span class="h">${esc(r.headline ?? "")}</span><span class="time">${new Date(r.time).toLocaleTimeString()}</span></button>`;
  }).join("");
  for (const b of $$("[data-run]")) b.addEventListener("click", () => openRun(runs.find((r) => r.id === b.dataset.run)!).catch(showError));
  if (autoOpen && runs[0] && runs[0].id !== lastRunId && ($("#follow") as HTMLInputElement).checked) await openRun(runs[0]);
  if (runs[0]) lastRunId = runs[0].id;
}

async function openRun(r: Run) {
  for (const b of $$(".run")) b.classList.toggle("on", b.dataset.run === r.id);
  if (r.kind === "mechanism") {
    // the saved spec + part STLs reproduce the agent's run exactly (the simulation is deterministic)
    const base = `api/runs/${encodeURIComponent(r.id)}/`;
    const spec = await (await fetch(base + "mechanism.json")).json();
    mech.files = {};
    for (const p of spec.parts) mech.files[p.file] = await (await fetch(base + p.file)).arrayBuffer();
    setMechSpec(spec);
    return runMechanism().catch(showError);
  }
  if (r.kind === "interlock") return showInterlockRun(r);
  const result = await (await fetch(`api/runs/${encodeURIComponent(r.id)}/result.json`)).json().catch(() => null);
  // the saved STL is already in print pose: analyse it without extra rotation
  for (const id of ["#rx", "#ry", "#rz"]) ($(id) as HTMLInputElement).value = "0";
  const mat = result?.part?.material;
  if (mat && MATERIALS[mat]) ($("#material") as HTMLSelectElement).value = mat;
  await openUrl(`api/runs/${encodeURIComponent(r.id)}/model.stl`, r.name, { keepSettings: true });
  if (r.kind === "stress") toast("Agent ran a strength test — re-run it in the Strength tab to see the stress map.");
}

/** Interlock runs come from the CLI / agent only: show their pictures and findings. */
async function showInterlockRun(r: Run) {
  const base = `api/runs/${encodeURIComponent(r.id)}/`;
  const res = await (await fetch(base + "result.json")).json() as { summary: string; interlocks: CheckResult[] };
  document.querySelector(".il-overlay")?.remove();
  const el = document.createElement("div");
  el.className = "il-overlay";
  el.innerHTML = `<div class="il-box"><div class="il-head"><b>${esc(r.name)}</b> <span class="muted">${esc(res.summary)}</span><button class="il-close" aria-label="Close">✕</button></div>` +
    res.interlocks.map((c, i) => `<section><h3><span class="pill ${c.status}">${c.status}</span> ${esc(c.title)}</h3>
      <img src="${base}interlock-${i + 1}.png" alt="${esc(c.title)}">
      <ul>${c.findings.map((f) => `<li class="${f.status}">${esc(f.message)}</li>`).join("")}</ul>
      ${c.fixes.length ? `<p class="small muted">Fix: ${c.fixes.map(esc).join(" · ")}</p>` : ""}</section>`).join("") + "</div>";
  el.addEventListener("click", (e) => { if (e.target === el || (e.target as HTMLElement).classList.contains("il-close")) el.remove(); });
  document.body.appendChild(el);
}

try {
  const es = new EventSource("api/events");
  es.onmessage = () => refreshRuns(true);
  es.onopen = () => refreshRuns(false);
} catch { /* no server */ }
setInterval(() => { if (serverMode) refreshRuns(true); }, 8000);

updateSettingsSummary();

// start with something on screen
openUrl("examples/shelf_bracket.stl", "shelf_bracket.stl").catch(() => undefined);
