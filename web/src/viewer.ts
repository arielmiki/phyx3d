// three.js scene: build plate, model with overlays, stress voxels, G-code toolpaths, physics playback.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type RGB = [number, number, number];
export interface Overlays { overhangs: boolean; stability: boolean; markers: boolean; stress: boolean; bed: boolean }
export interface MarkerSpec { at: [number, number, number]; color: string; label: string }

const PLATE = 256;

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
  readonly controls: OrbitControls;
  private bed = new THREE.Group();
  /** everything attached to the model, offset so the part sits in the middle of the plate */
  readonly modelGroup = new THREE.Group();
  private model?: THREE.Mesh;
  private edges?: THREE.LineSegments;
  private baseColors?: Float32Array;
  private overhangColors?: Float32Array;
  private stabilityGroup = new THREE.Group();
  private markerGroup = new THREE.Group();
  private stressGroup = new THREE.Group();
  private gcodeGroup = new THREE.Group();
  private simGroup = new THREE.Group();
  private pickMarker?: THREE.Mesh;
  private gcode?: { lines: THREE.LineSegments; layers: { start: number; end: number }[]; segIndex: Uint32Array; travel: boolean };
  private size = 60;
  private onPick?: (p: [number, number, number]) => void;
  private raf = 0;

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0f1115);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x20242c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(300, -400, 600);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9fb0ff, 0.6);
    fill.position.set(-400, 300, 200);
    this.scene.add(fill);

    this.buildBed();
    this.scene.add(this.bed, this.modelGroup, this.gcodeGroup, this.simGroup);
    this.modelGroup.add(this.stabilityGroup, this.markerGroup, this.stressGroup);
    this.setView("iso");

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.renderer.domElement.addEventListener("pointerdown", (e) => this.pointerDown(e));
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  private buildBed() {
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(PLATE, PLATE),
      new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.9, metalness: 0.1 }),
    );
    plate.position.set(PLATE / 2, PLATE / 2, -0.05);
    this.bed.add(plate);
    const pts: number[] = [];
    for (let i = 0; i <= PLATE; i += 16) { pts.push(i, 0, 0, i, PLATE, 0, 0, i, 0, PLATE, i, 0); }
    const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)), new THREE.LineBasicMaterial({ color: 0x323845 }));
    this.bed.add(grid);
    const border = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.02, PLATE, 0, 0.02, PLATE, PLATE, 0.02, 0, PLATE, 0.02], 3)), new THREE.LineBasicMaterial({ color: 0x5b6cf0 }));
    this.bed.add(border);
  }

  showBed(on: boolean) { this.bed.visible = on; }

  // ------------------------------------------------------------------ model
  setModel(positions: Float32Array, indices: Uint32Array, bbox: { min: number[]; max: number[] }) {
    this.clearModel();
    // non-indexed so each triangle can have its own colour and a flat normal
    const n = indices.length;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = indices[i] * 3; pos[i * 3] = positions[v]; pos[i * 3 + 1] = positions[v + 1]; pos[i * 3 + 2] = positions[v + 2]; }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.computeVertexNormals();
    this.baseColors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) this.baseColors.set([0.62, 0.68, 0.78], i * 3);
    geom.setAttribute("color", new THREE.BufferAttribute(this.baseColors.slice(), 3));
    this.model = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 28), new THREE.LineBasicMaterial({ color: 0x0b0d12, transparent: true, opacity: 0.55 }));
    this.modelGroup.add(this.model, this.edges);
    // centre on the plate
    const cx = (bbox.min[0] + bbox.max[0]) / 2, cy = (bbox.min[1] + bbox.max[1]) / 2;
    this.modelGroup.position.set(PLATE / 2 - cx, PLATE / 2 - cy, 0);
    this.size = Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2], 10);
    this.target = new THREE.Vector3(PLATE / 2, PLATE / 2, (bbox.max[2] - bbox.min[2]) / 2);
  }

  private target = new THREE.Vector3(PLATE / 2, PLATE / 2, 20);

  hasModel() { return !!this.model; }

  clearModel() {
    for (const o of [this.model, this.edges]) if (o) { this.modelGroup.remove(o); o.geometry.dispose(); }
    this.model = undefined; this.edges = undefined;
    for (const g of [this.stabilityGroup, this.markerGroup, this.stressGroup]) g.clear();
    this.overhangColors = undefined;
  }

  /** faceAngles: overhang angle per triangle (0 = fine) */
  setOverhangs(faceAngles: number[]) {
    if (!this.baseColors) return;
    const c = this.baseColors.slice();
    faceAngles.forEach((a, t) => {
      const col: RGB | null = a > 60 ? [0.9, 0.2, 0.2] : a > 45 ? [0.96, 0.66, 0.2] : null;
      if (col) for (let k = 0; k < 3; k++) c.set(col, (t * 3 + k) * 3);
    });
    this.overhangColors = c;
  }

  setStability(com: number[], polygon: [number, number][], z0: number) {
    this.stabilityGroup.clear();
    const s = Math.max(1.2, this.size * 0.025);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(s, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x444444 }));
    ball.position.set(com[0], com[1], com[2]);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(s * 1.6, s * 0.18, 8, 32), new THREE.MeshBasicMaterial({ color: 0x7c8cff }));
    ring.position.set(com[0], com[1], z0 + 0.1);
    const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(com[0], com[1], com[2]), new THREE.Vector3(com[0], com[1], z0)]), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 2, gapSize: 1.5 }));
    drop.computeLineDistances();
    this.stabilityGroup.add(ball, ring, drop);
    if (polygon.length > 1) {
      const pts = polygon.map(([x, y]) => new THREE.Vector3(x, y, z0 + 0.15));
      const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x7c8cff }));
      this.stabilityGroup.add(loop);
      const shape = new THREE.Shape(polygon.map(([x, y]) => new THREE.Vector2(x, y)));
      const fillMesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0x7c8cff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
      fillMesh.position.z = z0 + 0.1;
      this.stabilityGroup.add(fillMesh);
    }
  }

  setMarkers(markers: MarkerSpec[]) {
    this.markerGroup.clear();
    const s = Math.max(1, this.size * 0.02);
    for (const m of markers) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(s, 16, 12), new THREE.MeshBasicMaterial({ color: m.color, depthTest: false }));
      ball.renderOrder = 10;
      ball.position.set(...m.at);
      const label = makeLabel(m.label, m.color);
      label.position.set(m.at[0], m.at[1], m.at[2] + s * 2.2);
      label.scale.multiplyScalar(Math.max(3, this.size * 0.055));
      this.markerGroup.add(ball, label);
    }
  }

  applyOverlays(o: Overlays) {
    if (this.model) {
      const attr = this.model.geometry.getAttribute("color") as THREE.BufferAttribute;
      const src = o.overhangs && this.overhangColors && !o.stress ? this.overhangColors : this.baseColors!;
      (attr.array as Float32Array).set(src);
      attr.needsUpdate = true;
      const mat = this.model.material as THREE.MeshStandardMaterial;
      mat.transparent = o.stress && this.stressGroup.children.length > 0;
      mat.opacity = mat.transparent ? 0.12 : 1;
      mat.depthWrite = !mat.transparent;
    }
    this.stabilityGroup.visible = o.stability && !o.stress;
    this.markerGroup.visible = o.markers && !o.stress;
    this.stressGroup.visible = o.stress;
    this.bed.visible = o.bed;
  }

  // ------------------------------------------------------------------ stress
  /** voxels in design coordinates → placed with the print rotation + lift */
  setStress(grid: { origin: number[]; size: number; nx: number; ny: number; nz: number }, elements: Int32Array, safety: Float32Array, rotation: number[], lift: number) {
    this.stressGroup.clear();
    const solid = new Map<number, number>();
    elements.forEach((v, e) => solid.set(v, safety[e]));
    const { nx, ny, nz } = grid;
    const surface: [number, number][] = [];
    for (const [v, sf] of solid) {
      const i = v % nx, j = Math.floor(v / nx) % ny, k = Math.floor(v / (nx * ny));
      const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      if (nb.some(([a, b, c]) => { const x = i + a, y = j + b, z = k + c; return x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz || !solid.has(x + nx * (y + ny * z)); }) || sf < 2) surface.push([v, sf]);
    }
    const s = grid.size;
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(s * 0.96, s * 0.96, s * 0.96), new THREE.MeshStandardMaterial({ roughness: 0.6 }), surface.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    surface.forEach(([v, sf], idx) => {
      const i = v % nx, j = Math.floor(v / nx) % ny, k = Math.floor(v / (nx * ny));
      m.makeTranslation(grid.origin[0] + (i + 0.5) * s, grid.origin[1] + (j + 0.5) * s, grid.origin[2] + (k + 0.5) * s);
      inst.setMatrixAt(idx, m);
      inst.setColorAt(idx, col.setRGB(...safetyRGB(sf), THREE.SRGBColorSpace));
    });
    const holder = new THREE.Group();
    holder.add(inst);
    // design → print pose: R = Rz·Ry·Rx, then lift
    holder.rotation.set(...(rotation.map((d) => (d * Math.PI) / 180) as [number, number, number]), "ZYX");
    holder.position.z = lift;
    this.stressGroup.add(holder);
  }

  // ------------------------------------------------------------------ G-code
  setGcode(g: { segments: Float32Array; extruding: Uint8Array; feature: Uint8Array; features: string[]; layers: { start: number; end: number }[] }, flags: Uint8Array | null, opts: { travel: boolean; air: boolean }) {
    this.clearGcode();
    const n = g.extruding.length;
    const keep: number[] = [];
    for (let i = 0; i < n; i++) if (g.extruding[i] || opts.travel) keep.push(i);
    const pos = new Float32Array(keep.length * 6);
    const colors = new Float32Array(keep.length * 6);
    const segIndex = new Uint32Array(keep.length);
    keep.forEach((i, o) => {
      pos.set(g.segments.subarray(i * 6, i * 6 + 6), o * 6);
      const c = !g.extruding[i] ? [0.25, 0.3, 0.4] : opts.air && flags?.[i] ? [1, 0.1, 0.9] : featureColor(g.features[g.feature[i]]);
      colors.set(c, o * 6); colors.set(c, o * 6 + 3);
      segIndex[o] = i;
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.gcodeGroup.add(lines);
    // map layer boundaries (in original segment indices) to kept-segment indices
    const layers = g.layers.map((L) => ({ start: lowerBound(segIndex, L.start), end: lowerBound(segIndex, L.end) }));
    this.gcode = { lines, layers, segIndex, travel: opts.travel };
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    if (!isFinite(min[0])) { min = [0, 0, 0]; max = [PLATE, PLATE, 10]; }
    this.size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 10);
    this.target = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (max[2] - min[2]) / 2);
  }

  /** show layers 1..layer; `fraction` of the current layer drawn (for playback) */
  showLayers(layer: number, fraction = 1) {
    if (!this.gcode) return;
    const L = this.gcode.layers[Math.max(0, Math.min(layer - 1, this.gcode.layers.length - 1))];
    const end = Math.round(L.start + (L.end - L.start) * fraction);
    this.gcode.lines.geometry.setDrawRange(0, end * 2);
  }

  clearGcode() {
    if (this.gcode) { this.gcodeGroup.remove(this.gcode.lines); this.gcode.lines.geometry.dispose(); this.gcode = undefined; }
  }

  // ------------------------------------------------------------------ physics playback
  private simBodies: THREE.Group[] = [];
  private simFloor?: THREE.Mesh;

  /** Show copies of the current model (print pose) as rigid bodies whose origin is the COM. */
  startSim(count: number, com: number[], floorSize = 4000) {
    this.stopSim();
    if (!this.model) return;
    this.modelGroup.visible = false;
    this.bed.visible = false;
    // a finite slab so a tilting table is visible against the background
    const floor = new THREE.Mesh(new THREE.BoxGeometry(floorSize, floorSize, floorSize * 0.02), new THREE.MeshStandardMaterial({ color: 0x3b4250, roughness: 0.9 }));
    floor.position.z = -floorSize * 0.01;
    const grid = new THREE.GridHelper(floorSize, Math.max(4, Math.round(floorSize / 20)), 0x6b7690, 0x4a5262);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.05;
    this.simFloor = floor;
    this.simGroup.add(floor, grid);
    for (let i = 0; i < count; i++) {
      const holder = new THREE.Group();
      const body = this.model.clone();
      body.material = (this.model.material as THREE.Material).clone();
      const m = body.material as THREE.MeshStandardMaterial;
      m.transparent = false; m.opacity = 1; m.depthWrite = true;
      if (i % 2) m.color.setRGB(0.8, 0.85, 1);
      body.position.set(-com[0], -com[1], -com[2]);
      const e = this.edges!.clone();
      e.position.copy(body.position);
      holder.add(body, e);
      this.simGroup.add(holder);
      this.simBodies.push(holder);
    }
  }

  /** Mechanism playback: one body per part, meshes in assembly coordinates, poses = body transforms. */
  startMechanism(parts: { positions: Float32Array; indices: Uint32Array; color: number[] }[], floor: boolean) {
    this.stopSim();
    this.modelGroup.visible = false;
    this.bed.visible = false;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) {
      const n = p.indices.length;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const v = p.indices[i] * 3; pos[i * 3] = p.positions[v]; pos[i * 3 + 1] = p.positions[v + 1]; pos[i * 3 + 2] = p.positions[v + 2]; }
      for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geom.computeVertexNormals();
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color[0] / 255, p.color[1] / 255, p.color[2] / 255), roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 28), new THREE.LineBasicMaterial({ color: 0x0b0d12, transparent: true, opacity: 0.5 }));
      const holder = new THREE.Group();
      holder.add(mesh, edges);
      this.simGroup.add(holder);
      this.simBodies.push(holder);
    }
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 20);
    if (floor) {
      const fs = Math.max(2000, size * 30);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(fs, fs, 2), new THREE.MeshStandardMaterial({ color: 0x3b4250, roughness: 0.9 }));
      slab.position.z = -1;
      const grid = new THREE.GridHelper(fs, Math.round(fs / 20), 0x6b7690, 0x4a5262);
      grid.rotation.x = Math.PI / 2;
      grid.position.z = 0.05;
      this.simGroup.add(slab, grid);
    }
    this.size = size;
    return { center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], size };
  }

  /** keep the camera's offset while its target follows a moving body */
  follow(x: number, y: number, z: number) {
    const t = this.controls.target;
    const d = new THREE.Vector3(x - t.x, y - t.y, z - t.z).multiplyScalar(0.15);
    t.add(d);
    this.camera.position.add(d);
  }

  setSimPose(i: number, p: number[], q: number[]) {
    const b = this.simBodies[i];
    if (!b) return;
    b.position.set(p[0], p[1], p[2]);
    b.quaternion.set(q[0], q[1], q[2], q[3]);
  }

  /** tilt test: rotate the world instead of gravity so it looks like the table tilts */
  setSimTilt(angleDeg: number) { this.simGroup.rotation.y = (angleDeg * Math.PI) / 180; }

  frameSim(center: number[], radius: number) {
    const t = new THREE.Vector3(center[0], center[1], center[2]);
    this.controls.target.copy(t);
    this.camera.position.copy(t).add(new THREE.Vector3(radius * 1.8, -radius * 2.4, radius * 1.4));
  }

  stopSim() {
    this.simGroup.clear();
    this.simGroup.rotation.set(0, 0, 0);
    this.simBodies = [];
    this.simFloor = undefined;
    this.modelGroup.visible = true;
  }

  // ------------------------------------------------------------------ camera + picking
  setView(v: "iso" | "front" | "side" | "top" | "below") {
    const d = this.size * 2.9 + 60;
    const t = this.target;
    const dir = { iso: [1, -1.3, 0.9], front: [0, -1, 0.12], side: [1, 0, 0.12], top: [0, -0.001, 1], below: [0.9, -1.1, -0.7] }[v];
    const l = Math.hypot(...dir);
    this.controls.target.copy(t);
    this.camera.position.set(t.x + (dir[0] / l) * d, t.y + (dir[1] / l) * d, t.z + (dir[2] / l) * d);
    this.controls.update();
  }

  pickOnce(cb: (p: [number, number, number]) => void) { this.onPick = cb; this.renderer.domElement.style.cursor = "crosshair"; }

  showPick(p: [number, number, number] | null) {
    if (this.pickMarker) { this.modelGroup.remove(this.pickMarker); this.pickMarker = undefined; }
    if (!p) return;
    this.pickMarker = new THREE.Mesh(new THREE.SphereGeometry(Math.max(1.5, this.size * 0.03), 16, 12), new THREE.MeshBasicMaterial({ color: 0xff4fd8, transparent: true, opacity: 0.8, depthTest: false }));
    this.pickMarker.renderOrder = 11;
    this.pickMarker.position.set(...p);
    this.modelGroup.add(this.pickMarker);
  }

  private pointerDown(e: PointerEvent) {
    if (!this.onPick || !this.model) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.model)[0];
    if (!hit) return;
    const local = this.modelGroup.worldToLocal(hit.point.clone());
    const cb = this.onPick;
    this.onPick = undefined;
    this.renderer.domElement.style.cursor = "";
    cb([local.x, local.y, local.z]);
  }

  dispose() { cancelAnimationFrame(this.raf); this.renderer.dispose(); }
}

function lowerBound(a: Uint32Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

export function safetyRGB(sf: number): RGB {
  const lerp = (a: RGB, b: RGB, t: number): RGB => { t = Math.max(0, Math.min(1, t)); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
  const c = (r: number, g: number, b: number): RGB => [r / 255, g / 255, b / 255];
  if (sf < 1) return c(220, 40, 40);
  if (sf < 1.5) return lerp(c(230, 90, 30), c(240, 160, 30), (sf - 1) / 0.5);
  if (sf < 2) return lerp(c(240, 160, 30), c(235, 215, 60), (sf - 1.5) / 0.5);
  if (sf < 3) return lerp(c(235, 215, 60), c(110, 190, 90), sf - 2);
  return lerp(c(110, 190, 90), c(120, 160, 200), Math.min(1, (sf - 3) / 5));
}

const FEATURE_COLORS: [RegExp, RGB][] = [
  [/outer wall|external perimeter/i, [1, 0.55, 0.2]],
  [/inner wall|perimeter/i, [1, 0.8, 0.35]],
  [/overhang/i, [0.3, 0.55, 1]],
  [/bridge/i, [0.35, 0.8, 1]],
  [/top surface|top solid/i, [0.9, 0.3, 0.4]],
  [/bottom surface|bottom/i, [0.55, 0.4, 0.9]],
  [/solid infill|internal solid/i, [0.7, 0.35, 0.9]],
  [/sparse infill|infill/i, [0.7, 0.2, 0.2]],
  [/support interface/i, [0.2, 0.9, 0.6]],
  [/support/i, [0.3, 0.75, 0.45]],
  [/skirt|brim|prime|purge|wipe/i, [0.6, 0.6, 0.6]],
  [/gap/i, [1, 1, 1]],
];
export function featureColor(name = ""): RGB {
  for (const [re, c] of FEATURE_COLORS) if (re.test(name)) return c;
  return [0.75, 0.75, 0.8];
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = "600 28px system-ui, sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  c.width = w; c.height = 44;
  ctx.font = font;
  ctx.fillStyle = "rgba(15,17,21,0.85)";
  ctx.beginPath(); ctx.roundRect(0, 0, w, 44, 10); ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 12, 31);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.renderOrder = 12;
  s.scale.set(w / 44, 1, 1);
  s.center.set(0, 0);
  return s;
}
