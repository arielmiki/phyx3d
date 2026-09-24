// Common result format for every check — designed to be read by both people and AI agents.

export type Status = "pass" | "warn" | "fail" | "info";

/** How far to trust a number: geometry is exact, physics is a simulation, strength/warp are guides. */
export type Accuracy = "exact" | "simulated" | "estimate" | "rough-guide";

export interface Finding {
  status: Status;
  message: string;
  /** where on the part (mm, printer coordinates) */
  at?: [number, number, number];
}

export interface CheckResult<D = Record<string, unknown>> {
  id: string;
  title: string;
  status: Status;
  /** one-line human/agent-readable verdict */
  summary: string;
  accuracy: Accuracy;
  findings: Finding[];
  /** concrete design changes that would fix the problem */
  fixes: string[];
  data: D;
}

export function worst(statuses: Status[]): Status {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("pass")) return "pass";
  return "info";
}

export const r1 = (x: number) => Math.round(x * 10) / 10;
export const r2 = (x: number) => Math.round(x * 100) / 100;
export const r3 = (v: ArrayLike<number>): [number, number, number] => [r1(v[0]), r1(v[1]), r1(v[2])];
