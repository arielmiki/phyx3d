// Tiny, safe math-expression compiler for motion programs, e.g. "30*sin(2*pi*1.5*t + pi/2)".
// No eval: a Pratt parser builds a closure tree. Variables: t (seconds), pi, e, plus any passed in.

type Fn = (vars: Record<string, number>) => number;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, min: Math.min, max: Math.max, floor: Math.floor,
  ceil: Math.ceil, round: Math.round, sign: Math.sign, pow: Math.pow,
  mod: (a, b) => ((a % b) + b) % b,
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  /** 1 when x >= 0 */
  step: (x) => (x >= 0 ? 1 : 0),
  /** square wave with period 2π, like sin */
  square: (x) => (Math.sin(x) >= 0 ? 1 : -1),
  /** triangle wave with period 2π, range −1…1 */
  tri: (x) => (2 / Math.PI) * Math.asin(Math.sin(x)),
  /** sawtooth with period 2π, range −1…1 */
  saw: (x) => 2 * (x / (2 * Math.PI) - Math.floor(x / (2 * Math.PI) + 0.5)),
  /** 0 before t0, ramps to 1 at t1 */
  ramp: (x, t0, t1) => Math.min(1, Math.max(0, (x - t0) / (t1 - t0))),
  /** smooth 0→1 between t0 and t1 */
  smoothstep: (x, t0, t1) => { const u = Math.min(1, Math.max(0, (x - t0) / (t1 - t0))); return u * u * (3 - 2 * u); },
  lerp: (a, b, u) => a + (b - a) * u,
};

export function compileExpr(src: string): Fn {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (v: string) => { const t = next(); if (!t || t.v !== v) throw new Error(`Expected "${v}" in "${src}"`); };

  const BP: Record<string, number> = { "?": 1, "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 5, ">": 5, "<=": 5, ">=": 5, "+": 6, "-": 6, "*": 7, "/": 7, "%": 7, "^": 9 };

  function parse(rbp: number): Fn {
    let left = nud(next());
    while (peek() && peek().k === "op" && (BP[peek().v] ?? 0) > rbp) left = led(next(), left);
    return left;
  }
  function nud(t: Tok | undefined): Fn {
    if (!t) throw new Error(`Unexpected end of "${src}"`);
    if (t.k === "num") { const v = t.n!; return () => v; }
    if (t.k === "op" && t.v === "-") { const f = parse(8); return (s) => -f(s); }
    if (t.k === "op" && t.v === "+") return parse(8);
    if (t.k === "op" && t.v === "!") { const f = parse(8); return (s) => (f(s) ? 0 : 1); }
    if (t.k === "op" && t.v === "(") { const f = parse(0); expect(")"); return f; }
    if (t.k === "id") {
      const name = t.v;
      if (peek()?.v === "(") {
        next();
        const fn = FUNCS[name];
        if (!fn) throw new Error(`Unknown function "${name}" in "${src}". Known: ${Object.keys(FUNCS).join(", ")}`);
        const args: Fn[] = [];
        if (peek()?.v !== ")") { args.push(parse(0)); while (peek()?.v === ",") { next(); args.push(parse(0)); } }
        expect(")");
        return (s) => fn(...args.map((a) => a(s)));
      }
      if (name === "pi" || name === "PI") return () => Math.PI;
      if (name === "e") return () => Math.E;
      return (s) => {
        const v = s[name];
        if (v === undefined) throw new Error(`Unknown variable "${name}" in "${src}" (use t for time in seconds)`);
        return v;
      };
    }
    throw new Error(`Unexpected "${t.v}" in "${src}"`);
  }
  function led(t: Tok, left: Fn): Fn {
    const op = t.v;
    if (op === "?") {
      const a = parse(0); expect(":"); const b = parse(0);
      return (s) => (left(s) ? a(s) : b(s));
    }
    const right = parse(op === "^" ? BP[op] - 1 : BP[op]); // ^ is right-associative
    switch (op) {
      case "+": return (s) => left(s) + right(s);
      case "-": return (s) => left(s) - right(s);
      case "*": return (s) => left(s) * right(s);
      case "/": return (s) => left(s) / right(s);
      case "%": return (s) => left(s) % right(s);
      case "^": return (s) => Math.pow(left(s), right(s));
      case "<": return (s) => +(left(s) < right(s));
      case ">": return (s) => +(left(s) > right(s));
      case "<=": return (s) => +(left(s) <= right(s));
      case ">=": return (s) => +(left(s) >= right(s));
      case "==": return (s) => +(left(s) === right(s));
      case "!=": return (s) => +(left(s) !== right(s));
      case "&&": return (s) => +(!!left(s) && !!right(s));
      case "||": return (s) => +(!!left(s) || !!right(s));
    }
    throw new Error(`Bad operator ${op}`);
  }
  const f = parse(0);
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}" in "${src}"`);
  return f;
}

interface Tok { k: "num" | "id" | "op"; v: string; n?: number }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\||[-+*/%^(),?:<>!]))/y;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    m = re.exec(src);
    if (!m) throw new Error(`Can't read "${src.slice(pos, pos + 10)}" in "${src}"`);
    if (m[1] !== undefined) out.push({ k: "num", v: m[1], n: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ k: "id", v: m[2] });
    else out.push({ k: "op", v: m[3] });
    pos = re.lastIndex;
  }
  return out;
}

/** A motion signal: constant, expression string, or keyframes [[t, value], ...]. */
export type Signal = number | string | { keyframes: [number, number][]; loop?: boolean; smooth?: boolean };

/**
 * `scope` is shared and live: the simulator updates sensor variables (yaw, x, …) in it every step,
 * so expressions can do closed-loop control, e.g. "(20 + 0.8*yaw)*sin(2*pi*t)".
 */
export function compileSignal(s: Signal | undefined, scope: Record<string, number> = {}): (t: number) => number {
  if (s === undefined) return () => 0;
  if (typeof s === "number") return () => s;
  if (typeof s === "string") {
    const f = compileExpr(s);
    scope.t ??= 0;
    f(scope); // validate variables now, not mid-simulation
    return (t) => { scope.t = t; return f(scope); };
  }
  const k = [...s.keyframes].sort((a, b) => a[0] - b[0]);
  if (!k.length) return () => 0;
  const period = k[k.length - 1][0];
  return (t) => {
    if (s.loop && period > 0) t = ((t % period) + period) % period;
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (t <= k[i][0]) {
        let u = (t - k[i - 1][0]) / (k[i][0] - k[i - 1][0] || 1);
        if (s.smooth) u = u * u * (3 - 2 * u);
        return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * u;
      }
    }
    return k[k.length - 1][1];
  };
}
