import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineDistance,
  distancePointToSegmentMeters,
  cumulativeDistances,
  pointAtCumulativeDistance,
  nearestVertexIndex,
} from '../js/geo.js';

test('haversineDistance: known distance Paris-London ~ 344 km', () => {
  const paris = { lat: 48.8566, lng: 2.3522 };
  const london = { lat: 51.5074, lng: -0.1278 };
  const d = haversineDistance(paris, london);
  assert.ok(d > 340000 && d < 350000, `distance was ${d}`);
});

test('haversineDistance: identical point is 0', () => {
  const p = { lat: 43.6, lng: 1.4 };
  assert.equal(haversineDistance(p, p), 0);
});

test('distancePointToSegmentMeters: point on the segment is ~0', () => {
  const a = { lat: 43.6, lng: 1.4 };
  const b = { lat: 43.61, lng: 1.4 };
  const mid = { lat: 43.605, lng: 1.4 };
  assert.ok(distancePointToSegmentMeters(mid, a, b) < 1);
});

test('distancePointToSegmentMeters: perpendicular offset is close to the offset distance', () => {
  const a = { lat: 43.6, lng: 1.4 };
  const b = { lat: 43.6, lng: 1.41 };
  // ~0.001 deg latitude north of the segment's midpoint
  const p = { lat: 43.601, lng: 1.405 };
  const d = distancePointToSegmentMeters(p, a, b);
  assert.ok(d > 100 && d < 120, `distance was ${d}`);
});

test('cumulativeDistances is monotonically increasing and starts at 0', () => {
  const coords = [
    { lat: 43.6, lng: 1.4 },
    { lat: 43.61, lng: 1.41 },
    { lat: 43.62, lng: 1.42 },
  ];
  const cum = cumulativeDistances(coords);
  assert.equal(cum[0], 0);
  assert.ok(cum[1] > 0 && cum[2] > cum[1]);
});

test('pointAtCumulativeDistance interpolates between vertices', () => {
  const coords = [
    { lat: 43.6, lng: 1.4 },
    { lat: 43.6, lng: 1.5 },
  ];
  const cum = cumulativeDistances(coords);
  const half = pointAtCumulativeDistance(coords, cum, cum[1] / 2);
  assert.ok(Math.abs(half.lng - 1.45) < 1e-6);
  assert.ok(Math.abs(half.idx - 0.5) < 1e-6);
});

test('nearestVertexIndex finds the closest vertex, searching forward only', () => {
  const coords = [
    { lat: 0, lng: 5 }, // very close to the target, but before fromIdx=1
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 0, lng: 2 },
  ];
  const target = { lat: 0, lng: 5.001 };
  assert.equal(nearestVertexIndex(coords, target, 0), 0);
  // Starting the search at index 1 must ignore index 0 even though it is closer overall.
  assert.equal(nearestVertexIndex(coords, target, 1), 3);
});

test('sequentialNearestIndex: keeps the closest vertex of the first pass, not a noisy local minimum (real example)', async () => {
  const { readFileSync } = await import('node:fs');
  const { sequentialNearestIndex } = await import('../js/geo.js');
  const json = JSON.parse(readFileSync(new URL('./fixtures/brouter-full-example.geojson', import.meta.url)));
  const coords = json.features[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  // Étape 1 de l'URL d'exemple : la géométrie passe à ~1 m à l'idx 127,
  // après un minimum local bruité à ~25 m (idx 112).
  assert.equal(sequentialNearestIndex(coords, { lat: 43.608432, lng: 1.385408 }, 1), 127);
});

test('sequentialNearestIndex: a nearby street passed earlier (~40 m) does not capture the step reached later', async () => {
  const { sequentialNearestIndex } = await import('../js/geo.js');
  const m = 1 / 111320;
  const k = 1 / (111320 * Math.cos((48.85 * Math.PI) / 180));
  const pt = (x, y) => ({ lat: 48.85 + y * m, lng: 2.35 + x * k });
  // Est jusqu'à x=400, nord, ouest jusqu'à x=200, sud jusqu'à l'étape (200,40), puis repart.
  const poly = [[0, 0], [200, 0], [400, 0], [400, 200], [200, 200], [200, 40], [200, 200], [600, 200], [600, 0]];
  const coords = [];
  for (let i = 0; i < poly.length - 1; i++) {
    const [a, b] = [poly[i], poly[i + 1]];
    for (let s = 0; s < 10; s++) coords.push(pt(a[0] + ((b[0] - a[0]) * s) / 10, a[1] + ((b[1] - a[1]) * s) / 10));
  }
  coords.push(pt(600, 0));
  assert.equal(sequentialNearestIndex(coords, pt(200, 40), 1), 50);
});
