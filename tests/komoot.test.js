import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildKomootTourUrl,
  parseKomootTour,
  fetchKomootTour,
  modeForSport,
  limitAnchors,
} from '../js/komoot.js';
import { RoutingError } from '../js/errors.js';

test('buildKomootTourUrl requests coordinates/way_types/surfaces/directions embeds', () => {
  const url = buildKomootTourUrl('3041888689');
  assert.match(url, /^https:\/\/www\.komoot\.com\/api\/v007\/tours\/3041888689\?/);
  assert.match(url, /_embedded=coordinates%2Cway_types%2Csurfaces%2Cdirections/);
  assert.doesNotMatch(url, /share_token/);
});

test('buildKomootTourUrl includes share_token when provided', () => {
  const url = buildKomootTourUrl('3041888689', 'TEST_SHARE_TOKEN');
  assert.match(url, /share_token=TEST_SHARE_TOKEN/);
});

test('modeForSport: walking sports map to walking, biking (and unknown) sports map to bicycling', () => {
  assert.equal(modeForSport('hike'), 'walking');
  assert.equal(modeForSport('nordicwalking'), 'walking');
  assert.equal(modeForSport('jogging'), 'walking');
  assert.equal(modeForSport('mountaineering'), 'walking');
  assert.equal(modeForSport('winterhiking'), 'walking');
  assert.equal(modeForSport('snowshoe'), 'walking');
  assert.equal(modeForSport('climbing'), 'walking');
  assert.equal(modeForSport('skitour'), 'walking');
  assert.equal(modeForSport('racebike'), 'bicycling');
  assert.equal(modeForSport('touringbicycle'), 'bicycling');
  assert.equal(modeForSport('mtb'), 'bicycling');
  assert.equal(modeForSport('e_mtb'), 'bicycling');
  assert.equal(modeForSport('e_racebike'), 'bicycling');
  assert.equal(modeForSport('citybike'), 'bicycling');
  assert.equal(modeForSport('gravel'), 'bicycling');
  // 'touring' est volontairement exclu de WALK_SPORTS (trop ambigu, à ne pas
  // confondre avec 'touringbicycle') : il retombe donc sur le vélo, comme
  // tout sport inconnu.
  assert.equal(modeForSport('touring'), 'bicycling');
  assert.equal(modeForSport('unknown_sport'), 'bicycling');
});

const fixturePath = fileURLToPath(new URL('./fixtures/komoot-tour-3041888689.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('parseKomootTour: extracts coords, sections, anchors, name and sport from the real fixture', () => {
  const result = parseKomootTour(fixture);

  assert.equal(result.coords.length, 464);
  assert.deepEqual(result.coords[0], { lat: 43.602482, lng: 1.408251 });
  assert.equal(result.name, 'Cruising Rose Ride 2026');
  assert.equal(result.sport, 'hike');
  assert.ok(Math.abs(result.lengthM - fixture.distance) < 1);

  // 19 étapes posées par l'auteur, index croissants et dans les bornes.
  assert.equal(result.anchors.length, 19);
  assert.equal(result.anchors[0].idx, 0);
  assert.equal(result.anchors[result.anchors.length - 1].idx, result.coords.length - 1);
  for (let i = 1; i < result.anchors.length; i++) {
    assert.ok(result.anchors[i].idx > result.anchors[i - 1].idx, 'anchor indices must be strictly increasing');
  }

  // Les sections doivent couvrir tout le tracé sans trou.
  assert.equal(result.sections[0].startIdx, 0);
  assert.equal(result.sections[result.sections.length - 1].endIdx, result.coords.length - 1);
  for (let i = 1; i < result.sections.length; i++) {
    assert.equal(result.sections[i].startIdx, result.sections[i - 1].endIdx);
  }
  for (const section of result.sections) {
    assert.deepEqual(section.nodeTags, {});
  }
});

test('parseKomootTour: converts way_types elements to OSM-like wayTags', () => {
  const result = parseKomootTour(fixture);
  const highways = new Set(result.sections.map((s) => s.wayTags.highway).filter(Boolean));
  // La fixture contient au moins des tronçons "wt#street" (highway=unclassified) et "wt#footway".
  assert.ok(highways.has('unclassified') || highways.has('footway') || highways.has('residential'));
});

test('parseKomootTour: throws RoutingError on missing coordinates', () => {
  assert.throws(
    () => parseKomootTour({ _embedded: {} }),
    (err) => err instanceof RoutingError && err.code === 'INVALID_RESPONSE'
  );
});

test('parseKomootTour: throws RoutingError when fewer than two path anchors are present', () => {
  const broken = {
    ...fixture,
    path: [fixture.path[0]],
  };
  assert.throws(
    () => parseKomootTour(broken),
    (err) => err instanceof RoutingError && err.code === 'INVALID_RESPONSE'
  );
});

test('parseKomootTour: throws RoutingError on a null entry in coordinates.items', () => {
  const broken = {
    ...fixture,
    _embedded: { ...fixture._embedded, coordinates: { items: [null, { lat: 0, lng: 0 }] } },
  };
  assert.throws(
    () => parseKomootTour(broken),
    (err) => err instanceof RoutingError && err.code === 'INVALID_RESPONSE'
  );
});

function minimalSynthetic({ path, coordinates, wayTypes = [], surfaces = [] }) {
  return {
    name: 'Test',
    sport: 'hike',
    distance: 100,
    path,
    _embedded: {
      coordinates: { items: coordinates },
      way_types: { items: wayTypes },
      surfaces: { items: surfaces },
    },
  };
}

test('parseKomootTour: way_types items with invalid from/to (missing, non-integer, to<=from) are ignored without crashing; interior gaps are filled', () => {
  const synthetic = minimalSynthetic({
    path: [
      { location: { lat: 0, lng: 0 }, index: 0 },
      { location: { lat: 0, lng: 0.003 }, index: 3 },
    ],
    coordinates: [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
      { lat: 0, lng: 0.002 },
      { lat: 0, lng: 0.003 },
    ],
    wayTypes: [
      { from: 0, to: 1, element: 'wt#cycleway' },
      { from: null, to: 5, element: 'wt#street' }, // invalide : from non entier
      { from: 2, to: 1, element: 'wt#footway' }, // invalide : to <= from
      { from: 2, to: 3, element: 'wt#footway' },
    ],
  });

  const result = parseKomootTour(synthetic);
  // Les 2 items invalides sont ignorés ; le trou intérieur [1,2] (non décrit
  // par way_types) est comblé par une section sans tags.
  assert.equal(result.sections.length, 3);
  assert.equal(result.sections[0].startIdx, 0);
  assert.equal(result.sections[0].endIdx, 1);
  assert.deepEqual(result.sections[0].wayTags, { highway: 'cycleway' });
  assert.equal(result.sections[1].startIdx, 1);
  assert.equal(result.sections[1].endIdx, 2);
  assert.deepEqual(result.sections[1].wayTags, {});
  assert.equal(result.sections[2].startIdx, 2);
  assert.equal(result.sections[2].endIdx, 3);
  assert.deepEqual(result.sections[2].wayTags, { highway: 'footway' });
});

test('parseKomootTour: an ambiguous surface (no single element fully covering the section) is ignored', () => {
  const synthetic = minimalSynthetic({
    path: [
      { location: { lat: 0, lng: 0 }, index: 0 },
      { location: { lat: 0, lng: 0.003 }, index: 3 },
    ],
    coordinates: [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
      { lat: 0, lng: 0.002 },
      { lat: 0, lng: 0.003 },
    ],
    wayTypes: [{ from: 0, to: 3, element: 'wt#street' }],
    surfaces: [
      { from: 0, to: 1, element: 'sf#asphalt' },
      { from: 1, to: 3, element: 'sf#gravel' },
    ], // aucune ne couvre [0,3] entièrement : ambigu
  });

  const result = parseKomootTour(synthetic);
  assert.deepEqual(result.sections[0].wayTags, { highway: 'unclassified' }); // pas de `surface` ajoutée
});

test('parseKomootTour: out-of-bounds path indices fall back to anchors without idx (projectAnchors in waypoints.js)', () => {
  const synthetic = minimalSynthetic({
    path: [
      { location: { lat: 0, lng: 0 }, index: 0 },
      { location: { lat: 0, lng: 0.003 }, index: 999 }, // hors bornes (coords.length=4, lastIdx=3)
    ],
    coordinates: [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
      { lat: 0, lng: 0.002 },
      { lat: 0, lng: 0.003 },
    ],
  });

  const result = parseKomootTour(synthetic);
  assert.ok(result.anchors.every((a) => !('idx' in a)), 'no anchor should carry an idx when one index is out of bounds');
});

test('parseKomootTour: non strictly increasing path indices fall back to anchors without idx', () => {
  const synthetic = minimalSynthetic({
    path: [
      { location: { lat: 0, lng: 0 }, index: 0 },
      { location: { lat: 0, lng: 0.001 }, index: 2 },
      { location: { lat: 0, lng: 0.002 }, index: 1 }, // recule : non strictement croissant
    ],
    coordinates: [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
      { lat: 0, lng: 0.002 },
      { lat: 0, lng: 0.003 },
    ],
  });

  const result = parseKomootTour(synthetic);
  assert.ok(result.anchors.every((a) => !('idx' in a)), 'no anchor should carry an idx when indices are not strictly increasing');
});

test('security: parseKomootTour never carries over extra/unknown fields (e.g. a leaked share token) from raw API items', () => {
  const synthetic = {
    name: 'Test',
    sport: 'hike',
    distance: 300,
    path: [
      { location: { lat: 0, lng: 0 }, index: 0, leaked: 'SECRET_TOKEN' },
      { location: { lat: 0, lng: 0.002 }, index: 2, leaked: 'SECRET_TOKEN' },
    ],
    _embedded: {
      coordinates: {
        items: [
          { lat: 0, lng: 0, leaked: 'SECRET_TOKEN' },
          { lat: 0, lng: 0.001, leaked: 'SECRET_TOKEN' },
          { lat: 0, lng: 0.002, leaked: 'SECRET_TOKEN' },
        ],
      },
      way_types: { items: [] },
      surfaces: { items: [] },
    },
  };
  const result = parseKomootTour(synthetic);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN/);
});

test('limitAnchors: no-op when anchors already within maxCount', () => {
  const anchors = [
    { lat: 0, lng: 0 },
    { lat: 1, lng: 1 },
  ];
  assert.equal(limitAnchors(anchors, 5), anchors);
});

test('limitAnchors: keeps first/last and evenly distributes the rest, without duplicates, when exceeding maxCount', () => {
  const anchors = Array.from({ length: 20 }, (_, i) => ({ lat: i, lng: i }));
  const limited = limitAnchors(anchors, 5);
  assert.equal(limited.length, 5);
  assert.deepEqual(limited[0], anchors[0]);
  assert.deepEqual(limited[limited.length - 1], anchors[anchors.length - 1]);
  const originalPositions = limited.map((a) => anchors.indexOf(a));
  for (let i = 1; i < originalPositions.length; i++) {
    assert.ok(originalPositions[i] > originalPositions[i - 1], 'no duplicate, strictly increasing original positions');
  }
});

test('fetchKomootTour resolves with the parsed tour on HTTP 200', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => fixture,
  });
  try {
    const route = await fetchKomootTour('3041888689', null);
    assert.equal(route.coords.length, 464);
    assert.equal(route.anchors.length, 19);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchKomootTour throws RoutingError FORBIDDEN on HTTP 403 with a dedicated message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ status: 403, error: 'AccessDenied' }) });
  try {
    await assert.rejects(
      fetchKomootTour('3041888689', null),
      (err) => err instanceof RoutingError && err.code === 'FORBIDDEN' && /lien de partage/.test(err.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchKomootTour throws RoutingError NOT_FOUND on HTTP 404', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ status: 404, error: 'NotFound' }) });
  try {
    await assert.rejects(
      fetchKomootTour('0', null),
      (err) => err instanceof RoutingError && err.code === 'NOT_FOUND' && /introuvable/.test(err.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchKomootTour throws RoutingError NETWORK when fetch rejects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('boom');
  };
  try {
    await assert.rejects(
      fetchKomootTour('3041888689', null),
      (err) => err instanceof RoutingError && err.code === 'NETWORK'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchKomootTour throws RoutingError TIMEOUT when the request is aborted internally', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  try {
    await assert.rejects(
      fetchKomootTour('3041888689', null, { timeoutMs: 10 }),
      (err) => err instanceof RoutingError && err.code === 'TIMEOUT'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchKomootTour throws RoutingError ABORTED (not TIMEOUT) when cancelled externally', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const controller = new AbortController();
  try {
    const promise = fetchKomootTour('3041888689', null, { timeoutMs: 20000, signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, (err) => err instanceof RoutingError && err.code === 'ABORTED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
