import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildBrouterUrl,
  parseBrouterResponse,
  fetchBrouterRoute,
  findMatchingIndex,
  RoutingError,
} from '../js/router.js';
import { cumulativeDistances } from '../js/geo.js';

test('buildBrouterUrl encodes lon,lat pairs separated by | and sets the profile', () => {
  const url = buildBrouterUrl(
    [
      { lat: 43.590853, lng: 1.396755 },
      { lat: 43.608432, lng: 1.385408 },
    ],
    'safety'
  );
  assert.match(url, /^https:\/\/brouter\.de\/brouter\?/);
  assert.match(url, /lonlats=1\.396755%2C43\.590853%7C1\.385408%2C43\.608432/);
  assert.match(url, /profile=safety/);
  assert.match(url, /format=geojson/);
});

function sampleGeojson() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [1.0, 43.0, 100],
            [1.001, 43.0, 101],
            [1.002, 43.0, 102],
            [1.003, 43.0, 103],
          ],
        },
        properties: {
          'track-length': '250',
          messages: [
            [
              'Longitude',
              'Latitude',
              'Elevation',
              'Distance',
              'CostPerKm',
              'ElevCost',
              'TurnCost',
              'NodeCost',
              'InitialCost',
              'WayTags',
              'NodeTags',
              'Time',
              'Energy',
            ],
            ['1001000', '43000000', '101', '80', '', '', '', '', '', 'highway=cycleway', '', '', ''],
            [
              '1003000',
              '43000000',
              '103',
              '170',
              '',
              '',
              '',
              '',
              '',
              'highway=secondary surface=asphalt',
              '',
              '',
              '',
            ],
          ],
        },
      },
    ],
  };
}

test('parseBrouterResponse extracts coords, sections and total length', () => {
  const result = parseBrouterResponse(sampleGeojson());

  assert.equal(result.coords.length, 4);
  assert.deepEqual(result.coords[0], { lat: 43.0, lng: 1.0 });
  assert.equal(result.lengthM, 250);

  assert.equal(result.sections.length, 2);
  assert.deepEqual(result.sections[0], {
    startIdx: 0,
    endIdx: 1,
    wayTags: { highway: 'cycleway' },
    nodeTags: {},
    lengthM: result.sections[0].lengthM,
  });
  assert.equal(result.sections[1].startIdx, 1);
  assert.equal(result.sections[1].endIdx, 3);
  assert.deepEqual(result.sections[1].wayTags, { highway: 'secondary', surface: 'asphalt' });
});

test('parseBrouterResponse throws RoutingError on missing geometry', () => {
  assert.throws(
    () => parseBrouterResponse({ features: [{}] }),
    (err) => err instanceof RoutingError && err.code === 'BROUTER_ERROR'
  );
});

test('fetchBrouterRoute resolves with the parsed route on HTTP 200', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleGeojson(),
  });
  try {
    const route = await fetchBrouterRoute([
      { lat: 43.0, lng: 1.0 },
      { lat: 43.0, lng: 1.003 },
    ]);
    assert.equal(route.coords.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBrouterRoute throws RoutingError HTTP on non-200 responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'internal error',
  });
  try {
    await assert.rejects(
      fetchBrouterRoute([
        { lat: 43.0, lng: 1.0 },
        { lat: 43.0, lng: 1.003 },
      ]),
      (err) => err instanceof RoutingError && err.code === 'HTTP'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBrouterRoute throws RoutingError NETWORK when fetch rejects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('boom');
  };
  try {
    await assert.rejects(
      fetchBrouterRoute([
        { lat: 43.0, lng: 1.0 },
        { lat: 43.0, lng: 1.003 },
      ]),
      (err) => err instanceof RoutingError && err.code === 'NETWORK'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBrouterRoute throws RoutingError TIMEOUT when the request is aborted internally', async () => {
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
      fetchBrouterRoute(
        [
          { lat: 43.0, lng: 1.0 },
          { lat: 43.0, lng: 1.003 },
        ],
        { timeoutMs: 10 }
      ),
      (err) => err instanceof RoutingError && err.code === 'TIMEOUT'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBrouterRoute throws RoutingError ABORTED (not TIMEOUT) when cancelled externally', async () => {
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
    const promise = fetchBrouterRoute(
      [
        { lat: 43.0, lng: 1.0 },
        { lat: 43.0, lng: 1.003 },
      ],
      { timeoutMs: 20000, signal: controller.signal }
    );
    controller.abort();
    await assert.rejects(promise, (err) => err instanceof RoutingError && err.code === 'ABORTED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBrouterRoute timeout also covers reading the response body (not just headers)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, { signal }) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          // Le corps ne se lit jamais : seul le timeout (abort du signal) peut débloquer la promesse.
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
  try {
    await assert.rejects(
      fetchBrouterRoute(
        [
          { lat: 43.0, lng: 1.0 },
          { lat: 43.0, lng: 1.003 },
        ],
        { timeoutMs: 15 }
      ),
      (err) => err instanceof RoutingError && err.code === 'TIMEOUT'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a section longer than any fixed window (800 m) keeps its exact match, preserving junction=roundabout', () => {
  // Régression : une fenêtre bornée en distance-depuis-fromIdx (ex. 300 m)
  // ferait rater la correspondance exacte d'un tronçon plus long que la
  // fenêtre, fusionnant/perdant les tronçons suivants (et leurs tags, dont
  // junction=roundabout). La recherche exacte doit porter sur tout le reste
  // du tracé, sans fenêtre.
  const coords = [];
  for (let i = 0; i <= 900; i++) coords.push({ lat: 0, lng: i * 0.00001 }); // ~1,1 m de pas -> ~889 m à idx800

  const geojson = {
    features: [
      {
        geometry: { coordinates: coords.map((c) => [c.lng, c.lat]) },
        properties: {
          messages: [
            ['Longitude', 'Latitude', 'Distance', 'WayTags', 'NodeTags'],
            [
              String(Math.round(coords[800].lng * 1e6)),
              String(Math.round(coords[800].lat * 1e6)),
              '889',
              'junction=roundabout highway=service',
              '',
            ],
            [
              String(Math.round(coords[850].lng * 1e6)),
              String(Math.round(coords[850].lat * 1e6)),
              '56',
              'highway=residential',
              '',
            ],
          ],
        },
      },
    ],
  };

  const result = parseBrouterResponse(geojson);
  assert.equal(result.sections.length, 3); // 2 lignes messages + la section finale (idx850 -> idx900)
  assert.equal(result.sections[0].startIdx, 0);
  assert.equal(result.sections[0].endIdx, 800);
  assert.deepEqual(result.sections[0].wayTags, { junction: 'roundabout', highway: 'service' });
  assert.equal(result.sections[1].startIdx, 800);
  assert.equal(result.sections[1].endIdx, 850);
  assert.deepEqual(result.sections[1].wayTags, { highway: 'residential' });
});

test('fallback (no exact match) uses the Distance column to bound the search to ~expected position ± 100 m', () => {
  // Ligne droite de 1000 sommets espacés d'environ 10 m.
  const coords = [];
  for (let i = 0; i < 1000; i++) coords.push({ lat: 0, lng: i * 0.00009 });
  // Un "leurre" géométriquement très proche de la cible mais à ~900 m du
  // départ (donc hors fenêtre ±100 m autour des ~500 m attendus via Distance).
  coords[90] = { lat: 0.0000005, lng: 50 * 0.00009 + 0.00001 };
  const cumDist = cumulativeDistances(coords);

  // Cible proche du sommet 50 (~500 m, cohérent avec Distance=500), mais
  // encore plus proche numériquement du leurre à l'index 90.
  const target = { lat: 0.000005, lng: 50 * 0.00009 + 0.000012 };
  const idx = findMatchingIndex(coords, cumDist, target.lat, target.lng, 0, 500);

  assert.ok(idx >= 40 && idx <= 60, `expected a match near idx 50 (Distance-based window), got idx ${idx}`);
});

test('fallback searches the whole remainder when Distance is missing or invalid', () => {
  const coords = [];
  for (let i = 0; i < 50; i++) coords.push({ lat: 0, lng: i * 0.0001 });
  const cumDist = cumulativeDistances(coords);
  // Longitude exacte du dernier sommet, mais latitude légèrement décalée : pas de correspondance exacte.
  const target = { lat: 0.00005, lng: 49 * 0.0001 };

  assert.equal(findMatchingIndex(coords, cumDist, target.lat, target.lng, 0, NaN), 49);
  assert.equal(findMatchingIndex(coords, cumDist, target.lat, target.lng, 0, undefined), 49);
  assert.equal(findMatchingIndex(coords, cumDist, target.lat, target.lng, 0, -5), 49);
});

test('parses a section without exact rounded coordinate match (fallback to nearest within window)', () => {
  const geojson = {
    features: [
      {
        geometry: {
          coordinates: [
            [1.0, 43.0],
            [1.0005, 43.0],
            [1.001, 43.0],
          ],
        },
        properties: {
          messages: [
            ['Longitude', 'Latitude', 'WayTags', 'NodeTags'],
            // Coordonnée légèrement décalée (pas de correspondance exacte ×1e6).
            ['1000600', '43000003', 'highway=cycleway', ''],
          ],
        },
      },
    ],
  };
  const result = parseBrouterResponse(geojson);
  assert.equal(result.sections.length, 2); // la section décrite + la section finale sans tags
  assert.equal(result.sections[0].endIdx, 1);
  assert.equal(result.sections[1].startIdx, 1);
  assert.equal(result.sections[1].endIdx, 2);
  assert.deepEqual(result.sections[1].wayTags, {});
});

function assertFixtureSectionsMatchMessages(raw, result) {
  const messagesRows = raw.features[0].properties.messages.length - 1;
  const hasFinalSection = result.sections[result.sections.length - 1].endIdx === result.coords.length - 1;
  const expected = hasFinalSection && result.sections.length > messagesRows ? messagesRows + 1 : messagesRows;
  assert.equal(
    result.sections.length,
    expected,
    `expected ${expected} sections (${messagesRows} messages rows${hasFinalSection && result.sections.length > messagesRows ? ' + 1 final section' : ''}), got ${result.sections.length}`
  );
}

const fixturePath = fileURLToPath(new URL('./fixtures/brouter-sample.geojson', import.meta.url));

test('real BRouter fixture: sections cover the whole track and their lengths sum to ~track-length', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const result = parseBrouterResponse(raw);

  assert.ok(result.sections.length > 0);
  assert.equal(result.sections[0].startIdx, 0);
  assert.equal(result.sections[result.sections.length - 1].endIdx, result.coords.length - 1);
  assertFixtureSectionsMatchMessages(raw, result);

  const sum = result.sections.reduce((total, s) => total + s.lengthM, 0);
  const relativeError = Math.abs(sum - result.lengthM) / result.lengthM;
  assert.ok(relativeError < 0.01, `sections length sum (${sum}) should be within 1% of track-length (${result.lengthM})`);
});

// Réponse BRouter complète pour l'URL Geovelo d'exemple (9 points, ~1000
// sommets, ~100 Ko) : sert de test de non-régression hors ligne pour le bug
// diagnostiqué en itération 3 (fenêtre de repli trop courte faisant perdre
// des tronçons, dont des ronds-points, sur un tracé réel). Pas d'accès
// réseau ici : la fixture a été enregistrée au préalable.
const fullExampleFixturePath = fileURLToPath(new URL('./fixtures/brouter-full-example.geojson', import.meta.url));

test('real BRouter fixture (full 9-point example route): number of sections matches number of messages rows', () => {
  const raw = JSON.parse(readFileSync(fullExampleFixturePath, 'utf8'));
  const result = parseBrouterResponse(raw);

  assertFixtureSectionsMatchMessages(raw, result);

  const sum = result.sections.reduce((total, s) => total + s.lengthM, 0);
  const relativeError = Math.abs(sum - result.lengthM) / result.lengthM;
  assert.ok(relativeError < 0.01, `sections length sum (${sum}) should be within 1% of track-length (${result.lengthM})`);
});

test('findMatchingIndex fallback: includes the vertex just before the window when a long edge spans it', async () => {
  const { findMatchingIndex } = await import('../js/router.js');
  const { cumulativeDistances } = await import('../js/geo.js');
  const m = 1 / 111320;
  const k = 1 / (111320 * Math.cos((48.85 * Math.PI) / 180));
  const pt = (x, y) => ({ lat: 48.85 + y * m, lng: 2.35 + x * k });
  const coords = [pt(0, 0), pt(10, 0), pt(1000, 0), pt(1010, 0)];
  const target = pt(15, 5);
  assert.equal(findMatchingIndex(coords, cumulativeDistances(coords), target.lat, target.lng, 0, 15), 1);
});

test('parseBrouterResponse: malformed coordinates raise a RoutingError (level 1 fallback)', async () => {
  const { parseBrouterResponse, RoutingError } = await import('../js/router.js');
  const json = { features: [{ geometry: { coordinates: [[1, 2], 'oops'] }, properties: {} }] };
  assert.throws(() => parseBrouterResponse(json), RoutingError);
});
