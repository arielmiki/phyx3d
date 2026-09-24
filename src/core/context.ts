// Shared, lazily computed data for all checks on one part.
//
// Coordinates: `designMesh` is the model exactly as designed. `mesh` is the print pose: rotated by
// `rotate` (if any) and lifted so its lowest point is at z = 0. X/Y are NOT moved, so for an
// unrotated model that already sits on z = 0, print coordinates equal the CAD coordinates.
import { type Mesh, type Vec3, bbox, faceNormals, massProps, meshHealth, rotateDeg, flipWinding, translate, type BBox, type MassProps, type MeshHealth } from "./mesh.js";
import { type Material, type Printer, type PrintSettings, getMaterial, getPrinter, DEFAULT_SETTINGS } from "./materials.js";
import { type VoxelGrid, voxelize, autoVoxelSize } from "./voxel.js";

export interface PartOptions {
  material?: string;
  printer?: string;
  settings?: Partial<PrintSettings>;
  /** print orientation: rotate the design by these Euler degrees (X, then Y, then Z) */
  rotate?: [number, number, number];
}

export class Part {
  /** print pose (rotated, resting on z = 0) — used by printability, stability, physics */
  readonly mesh: Mesh;
  /** original design coordinates — used by the strength test so loads stay attached to the design */
  readonly designMesh: Mesh;
  /** build (layer-stacking) direction expressed in design coordinates */
  readonly buildDir: Vec3;
  readonly rotation: [number, number, number];
  /** z lift applied after rotation */
  readonly lift: number;
  readonly material: Material;
  readonly printer: Printer;
  readonly settings: PrintSettings;
  private _normals?: { normals: Float32Array; areas: Float32Array };
  private _mass?: MassProps;
  private _health?: MeshHealth;
  private _bbox?: BBox;
  private _voxels = new Map<number, VoxelGrid>();

  constructor(mesh: Mesh, opts: PartOptions = {}) {
    this.material = getMaterial(opts.material);
    this.printer = getPrinter(opts.printer);
    this.settings = { ...DEFAULT_SETTINGS, ...opts.settings };
    // inside-out meshes are common from some CAD exports; fix silently, report in health
    const h0 = meshHealth(mesh);
    this.designMesh = h0.inverted ? flipWinding(mesh) : mesh;
    this.rotation = opts.rotate ?? [0, 0, 0];
    const rotated = this.rotation.some((a) => a) ? rotateDeg(this.designMesh, ...this.rotation) : this.designMesh;
    this.lift = -bbox(rotated).min[2];
    this.mesh = translate(rotated, [0, 0, this.lift]);
    this.buildDir = this.dirToDesign([0, 0, 1]);
    this._health = { ...meshHealth(this.mesh), inverted: h0.inverted };
  }

  get normals() { return (this._normals ??= faceNormals(this.mesh)); }
  get mass() { return (this._mass ??= massProps(this.mesh)); }
  get health() { return (this._health ??= meshHealth(this.mesh)); }
  get bbox() { return (this._bbox ??= bbox(this.mesh)); }

  /** print-pose direction → design direction */
  dirToDesign(v: Vec3): Vec3 {
    const [rx, ry, rz] = this.rotation.map((d) => (-d * Math.PI) / 180);
    let [x, y, z] = v;
    // undo Z, then Y, then X
    [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    return [x, y, z];
  }

  /** print-pose point → design point */
  toDesign(p: Vec3): Vec3 {
    return this.dirToDesign([p[0], p[1], p[2] - this.lift]);
  }

  /** Voxel grid of the print pose with at most ~`budget` voxels in the bounding box. */
  voxels(budget = 1_500_000, minSize?: number): VoxelGrid {
    const size = +autoVoxelSize(this.mesh, budget, minSize ?? Math.min(0.4, this.settings.layerHeight * 2)).toFixed(4);
    let g = this._voxels.get(size);
    if (!g) { g = voxelize(this.mesh, size); this._voxels.set(size, g); }
    return g;
  }

  /** grams at the chosen infill (walls/top/bottom solid, rest at infill %) */
  estimateGrams(): { grams: number; solidFraction: number } {
    const { volume, surfaceArea } = this.mass;
    const s = this.settings;
    const shell = Math.min(volume, surfaceArea * s.walls * s.lineWidth);
    const core = Math.max(0, volume - shell);
    const printedVol = shell + core * s.infill;
    return { grams: (printedVol / 1000) * this.material.density, solidFraction: volume ? printedVol / volume : 1 };
  }
}
