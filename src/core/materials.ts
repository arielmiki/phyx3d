// Filament and printer presets. Values are typical datasheet numbers for FDM-printed
// specimens (not raw resin), rounded. Z = across layers, which is always the weak direction.

export interface Material {
  id: string;
  name: string;
  /** g/cm³ */
  density: number;
  /** Young's modulus, MPa */
  youngsModulus: number;
  poisson: number;
  /** tensile strength along the layers (XY), MPa */
  tensileXY: number;
  /** tensile strength across layers (Z, layer adhesion), MPa */
  tensileZ: number;
  /** glass transition, °C — above this the part softens */
  glassTransition: number;
  /** 0 (never warps) … 1 (warps badly) */
  warpTendency: number;
  /** needs an enclosure to print reliably */
  needsEnclosure: boolean;
  /** coefficient of friction on a wooden/plastic table (for physics) */
  friction: number;
  restitution: number;
  /** typical nozzle / bed °C for P1S */
  nozzleTemp: number;
  bedTemp: number;
}

export const MATERIALS: Record<string, Material> = {
  PLA: { id: "PLA", name: "PLA", density: 1.24, youngsModulus: 2600, poisson: 0.36, tensileXY: 50, tensileZ: 28, glassTransition: 57, warpTendency: 0.15, needsEnclosure: false, friction: 0.45, restitution: 0.35, nozzleTemp: 220, bedTemp: 55 },
  PETG: { id: "PETG", name: "PETG", density: 1.27, youngsModulus: 2000, poisson: 0.38, tensileXY: 45, tensileZ: 30, glassTransition: 80, warpTendency: 0.3, needsEnclosure: false, friction: 0.5, restitution: 0.3, nozzleTemp: 250, bedTemp: 70 },
  ABS: { id: "ABS", name: "ABS", density: 1.04, youngsModulus: 1900, poisson: 0.35, tensileXY: 36, tensileZ: 20, glassTransition: 100, warpTendency: 0.8, needsEnclosure: true, friction: 0.45, restitution: 0.35, nozzleTemp: 260, bedTemp: 100 },
  ASA: { id: "ASA", name: "ASA", density: 1.07, youngsModulus: 1900, poisson: 0.35, tensileXY: 38, tensileZ: 22, glassTransition: 100, warpTendency: 0.7, needsEnclosure: true, friction: 0.45, restitution: 0.35, nozzleTemp: 260, bedTemp: 100 },
  TPU: { id: "TPU", name: "TPU 95A", density: 1.22, youngsModulus: 26, poisson: 0.45, tensileXY: 30, tensileZ: 20, glassTransition: -30, warpTendency: 0.05, needsEnclosure: false, friction: 0.9, restitution: 0.6, nozzleTemp: 230, bedTemp: 35 },
  "PLA-CF": { id: "PLA-CF", name: "PLA-CF", density: 1.22, youngsModulus: 3900, poisson: 0.35, tensileXY: 40, tensileZ: 18, glassTransition: 60, warpTendency: 0.1, needsEnclosure: false, friction: 0.45, restitution: 0.3, nozzleTemp: 220, bedTemp: 55 },
  "PETG-CF": { id: "PETG-CF", name: "PETG-CF", density: 1.25, youngsModulus: 3500, poisson: 0.36, tensileXY: 42, tensileZ: 22, glassTransition: 80, warpTendency: 0.25, needsEnclosure: false, friction: 0.5, restitution: 0.3, nozzleTemp: 260, bedTemp: 70 },
  PC: { id: "PC", name: "PC", density: 1.2, youngsModulus: 2300, poisson: 0.37, tensileXY: 55, tensileZ: 30, glassTransition: 113, warpTendency: 0.9, needsEnclosure: true, friction: 0.4, restitution: 0.35, nozzleTemp: 270, bedTemp: 110 },
};

export function getMaterial(id: string | undefined): Material {
  if (!id) return MATERIALS.PLA;
  const key = Object.keys(MATERIALS).find((k) => k.toLowerCase() === id.toLowerCase());
  if (!key) throw new Error(`Unknown material "${id}". Known: ${Object.keys(MATERIALS).join(", ")}`);
  return MATERIALS[key];
}

export interface Printer {
  id: string;
  name: string;
  /** build volume mm */
  volume: [number, number, number];
  nozzle: number;
  enclosed: boolean;
  /** practical max volumetric flow for PLA, mm³/s (for time estimates) */
  maxFlow: number;
}

export const PRINTERS: Record<string, Printer> = {
  P1S: { id: "P1S", name: "Bambu Lab P1S", volume: [256, 256, 256], nozzle: 0.4, enclosed: true, maxFlow: 21 },
  P1P: { id: "P1P", name: "Bambu Lab P1P", volume: [256, 256, 256], nozzle: 0.4, enclosed: false, maxFlow: 21 },
  P2S: { id: "P2S", name: "Bambu Lab P2S", volume: [256, 256, 256], nozzle: 0.4, enclosed: true, maxFlow: 32 },
  X1C: { id: "X1C", name: "Bambu Lab X1 Carbon", volume: [256, 256, 256], nozzle: 0.4, enclosed: true, maxFlow: 21 },
  A1: { id: "A1", name: "Bambu Lab A1", volume: [256, 256, 256], nozzle: 0.4, enclosed: false, maxFlow: 21 },
  "A1-MINI": { id: "A1-MINI", name: "Bambu Lab A1 mini", volume: [180, 180, 180], nozzle: 0.4, enclosed: false, maxFlow: 21 },
  H2D: { id: "H2D", name: "Bambu Lab H2D (single nozzle area)", volume: [325, 320, 325], nozzle: 0.4, enclosed: true, maxFlow: 40 },
};

export function getPrinter(id: string | undefined): Printer {
  if (!id) return PRINTERS.P1S;
  const key = Object.keys(PRINTERS).find((k) => k.toLowerCase() === id.toLowerCase().replace(/\s+/g, "-"));
  if (!key) throw new Error(`Unknown printer "${id}". Known: ${Object.keys(PRINTERS).join(", ")}`);
  return PRINTERS[key];
}

/** Bambu Studio defaults (0.20mm Standard @ 0.4 nozzle) */
export interface PrintSettings {
  layerHeight: number;
  /** wall loops */
  walls: number;
  lineWidth: number;
  topLayers: number;
  bottomLayers: number;
  /** 0..1 */
  infill: number;
}

export const DEFAULT_SETTINGS: PrintSettings = {
  layerHeight: 0.2,
  walls: 2,
  lineWidth: 0.42,
  topLayers: 5,
  bottomLayers: 3,
  infill: 0.15,
};
