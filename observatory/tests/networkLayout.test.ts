import assert from "node:assert/strict";
import test from "node:test";
import { layoutNetwork, networkPosition } from "../src/networkLayout.ts";

test("layout is deterministic, finite and bounded for 404 assets, without mutating measurements", () => {
  const ids = Array.from({ length: 404 }, (_, i) => `COIN-${i}`);
  const edges = ids.slice(1, 68).map((id, i) => ({ a: ids[i], b: id, r: 0.8 }));
  const before = JSON.stringify(edges);
  const points = layoutNetwork(ids, edges);
  assert.deepEqual(points, layoutNetwork([...ids].reverse(), edges));
  assert.equal(JSON.stringify(edges), before);
  assert.equal(points.length, 404);
  for (const p of points)
    for (const t of [0, 20, 300, 5000]) {
      const [x, y] = networkPosition(p, t);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(Math.abs(x) < 0.9 && Math.abs(y) < 0.9);
    }
});

test("measured links change the arrangement; magnitude gives positive and negative links equal spring strength", () => {
  const ids = ["A", "B", "C", "D", "E", "F"];
  const edges = [
    { a: "A", b: "E", r: 0.9 },
    { a: "C", b: "F", r: 0.8 },
  ];
  assert.notDeepEqual(layoutNetwork(ids, edges), layoutNetwork(ids, []));
  assert.deepEqual(
    layoutNetwork(ids, edges),
    layoutNetwork(
      ids,
      edges.map((e) => ({ ...e, r: -e.r })),
    ),
  );
});

test("motion is continuous, individual and reproducible at a frozen time", () => {
  const points = layoutNetwork(["A", "B", "C"], []);
  const offsets = points.map((p) =>
    networkPosition(p, 5).map((v, i) => v - [p.x, p.y][i]),
  );
  assert.notDeepEqual(offsets[0], offsets[1]);
  for (const p of points) {
    assert.deepEqual(networkPosition(p, 0), [p.x, p.y]);
    assert.deepEqual(networkPosition(p, 5), networkPosition(p, 5));
    const a = networkPosition(p, 5),
      b = networkPosition(p, 5.016);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.001);
  }
});

test("empty and single-node graphs do not produce invalid coordinates", () => {
  assert.deepEqual(layoutNetwork([], []), []);
  const [p] = layoutNetwork(["A"], [{ a: "A", b: "missing", r: 0.9 }]);
  assert.equal(p.x, 0);
  assert.equal(p.y, 0);
});
