// Small 2D helpers for footprint / support-polygon math.

export type P2 = [number, number];

/** Andrew's monotone chain; returns CCW hull without repeating the first point. */
export function convexHull(points: P2[]): P2[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polygonArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * Signed distance from p to the boundary of a CCW convex polygon:
 * positive inside, negative outside. Also returns the closest edge's outward normal.
 */
export function signedDistanceToHull(p: P2, hull: P2[]): { distance: number; normal: P2 } {
  if (hull.length < 3) {
    // degenerate footprint (point or line): treat as zero-width support
    let best = Infinity;
    for (const q of hull) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
    return { distance: -(isFinite(best) ? best : 0), normal: [1, 0] };
  }
  let minInside = Infinity;
  let normal: P2 = [1, 0];
  let inside = true;
  let outsideDist = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    const nx = ey / len, ny = -ex / len; // outward for CCW
    const d = (p[0] - a[0]) * nx + (p[1] - a[1]) * ny; // >0 outside this edge
    if (d > 0) inside = false;
    if (-d < minInside) { minInside = -d; normal = [nx, ny]; }
    // distance to segment for the outside case
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (len * len)));
    const dist = Math.hypot(p[0] - (a[0] + t * ex), p[1] - (a[1] + t * ey));
    if (dist < outsideDist) outsideDist = dist;
  }
  return inside ? { distance: minInside, normal } : { distance: -outsideDist, normal };
}

/** Minimum width of a convex polygon (rotating calipers, O(n²) is fine for footprints). */
export function minWidth(hull: P2[]): number {
  if (hull.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    let far = 0;
    for (const p of hull) far = Math.max(far, Math.abs((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / len);
    best = Math.min(best, far);
  }
  return isFinite(best) ? best : 0;
}
