/** Layout coordinates are presentation only: never market measurements. */
export type NetworkEdge = { a: string; b: string; r: number };
export type NetworkPoint = { id: string; x: number; y: number; phase: number };

export function phaseFor(id: string): number {
  let hash = 2166136261;
  for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

/** Deterministic force-directed equilibrium, computed off the render thread.
 * Absolute correlation supplies spring strength. Its sign remains in the links.
 * Sorting IDs makes the result independent of feed ordering and selection.
 */
export function layoutNetwork(
  ids: string[],
  edges: NetworkEdge[],
): NetworkPoint[] {
  const points = [...new Set(ids)].sort().map((id, i, all) => {
    const angle = i * 2.399963229728653;
    const radius = 0.8 * Math.sqrt((i + 0.5) / all.length);
    return {
      id,
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      phase: phaseFor(id),
    };
  });
  if (points.length < 2) return points.map((p) => ({ ...p, x: 0, y: 0 }));
  const indices = new Map(points.map((p, i) => [p.id, i]));
  const springs = edges
    .filter((e) => indices.has(e.a) && indices.has(e.b) && e.a !== e.b)
    .map((e) => ({
      a: indices.get(e.a)!,
      b: indices.get(e.b)!,
      strength: Math.min(1, Math.abs(e.r)),
    }));
  const fx = new Float64Array(points.length),
    fy = new Float64Array(points.length);
  const k = Math.sqrt(2.1 / points.length);
  for (let step = 0; step < 180; step++) {
    fx.fill(0);
    fy.fill(0);
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].x - points[j].x,
          dy = points[i].y - points[j].y;
        const d2 = Math.max(0.00001, dx * dx + dy * dy);
        const force = (k * k) / d2;
        fx[i] += dx * force;
        fy[i] += dy * force;
        fx[j] -= dx * force;
        fy[j] -= dy * force;
      }
    }
    for (const e of springs) {
      const dx = points[e.a].x - points[e.b].x,
        dy = points[e.a].y - points[e.b].y;
      const force = (Math.hypot(dx, dy) / k) * e.strength * 1.4;
      fx[e.a] -= dx * force;
      fy[e.a] -= dy * force;
      fx[e.b] += dx * force;
      fy[e.b] += dy * force;
    }
    const temperature = 0.06 * (1 - step / 180) ** 1.5 + 0.0008;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      fx[i] -= p.x * 1.2;
      fy[i] -= p.y * 1.2;
      const length = Math.hypot(fx[i], fy[i]) || 1;
      const scale = Math.min(temperature, length) / length;
      p.x += fx[i] * scale;
      p.y += fy[i] * scale;
    }
  }
  const connected = new Set(springs.flatMap((e) => [e.a, e.b]));
  const cluster = points.filter((_, i) => connected.has(i));
  const extent = cluster.length > 1 ? cluster : points;
  const minX = Math.min(...extent.map((p) => p.x)),
    maxX = Math.max(...extent.map((p) => p.x));
  const minY = Math.min(...extent.map((p) => p.y)),
    maxY = Math.max(...extent.map((p) => p.y));
  const isolates = points.filter((_, i) => !connected.has(i));
  const isolatedIndex = new Map(isolates.map((p, i) => [p.id, i]));
  return points.map((p, i) => {
    if (cluster.length > 1 && !connected.has(i)) {
      const angle =
        (isolatedIndex.get(p.id)! / isolates.length) * Math.PI * 2 + 0.23;
      const radius = 0.8 + 0.02 * Math.sin(p.phase);
      return { ...p, x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    }
    // Fit the connected component to the available plane; disconnected assets
    // sit outside it, without forcing the measured relationships into a knot.
    return {
      ...p,
      x: ((p.x - (minX + maxX) / 2) * 1.4) / Math.max(maxX - minX, 0.01),
      y: ((p.y - (minY + maxY) / 2) * 1.4) / Math.max(maxY - minY, 0.01),
    };
  });
}

/** Smooth shared deformation plus individual drift; no directional flow claim.
 * Zero time is the settled position, so pausing/resuming never jumps.
 */
export function networkPosition(
  p: NetworkPoint,
  seconds: number,
): [number, number] {
  const wave = (rate: number, phase: number) =>
    Math.sin(seconds * rate + phase) - Math.sin(phase);
  return [
    p.x + 0.021 * wave(0.24, p.y * 2) + 0.012 * wave(0.37, p.phase),
    p.y + 0.021 * wave(0.21, p.x * 2) + 0.012 * wave(0.31, p.phase + 1.3),
  ];
}
