import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApiUrl,
  buildPathUrl,
  splitIntoSegments,
  computeCapacity,
  MAX_POINTS_PER_LINK,
  GOOGLE_MAPS_URL_MAX_LENGTH,
} from '../js/gmaps-links.js';

const p = (lat, lng) => ({ lat, lng });

test('buildApiUrl builds an origin/destination/waypoints/travelmode URL', () => {
  const points = [p(43.1, 1.1), p(43.2, 1.2), p(43.3, 1.3)];
  const url = buildApiUrl(points);
  assert.match(url, /^https:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.match(url, /origin=43\.1%2C1\.1/);
  assert.match(url, /destination=43\.3%2C1\.3/);
  assert.match(url, /waypoints=43\.2%2C1\.2/);
  assert.match(url, /travelmode=bicycling/);
});

test('buildApiUrl without intermediate waypoints', () => {
  const url = buildApiUrl([p(43.1, 1.1), p(43.2, 1.2)]);
  assert.doesNotMatch(url, /waypoints=/);
});

test('buildApiUrl rounds coordinates to 6 decimals', () => {
  const url = buildApiUrl([p(43.123456789, 1.987654321), p(43.2, 1.2)]);
  assert.match(url, /origin=43\.123457%2C1\.987654/);
});

test('buildPathUrl builds a path with the bicycling data suffix', () => {
  const points = [p(43.1, 1.1), p(43.2, 1.2), p(43.3, 1.3)];
  const url = buildPathUrl(points);
  assert.equal(url, 'https://www.google.com/maps/dir/43.1,1.1/43.2,1.2/43.3,1.3/data=!4m2!4m1!3e1');
});

test('buildApiUrl/buildPathUrl require at least 2 points', () => {
  assert.throws(() => buildApiUrl([p(1, 1)]));
  assert.throws(() => buildPathUrl([]));
});

test('buildApiUrl defaults to bicycling travelmode', () => {
  const url = buildApiUrl([p(43.1, 1.1), p(43.2, 1.2)]);
  assert.match(url, /travelmode=bicycling/);
});

test('buildApiUrl accepts walking travelmode', () => {
  const url = buildApiUrl([p(43.1, 1.1), p(43.2, 1.2)], 'walking');
  assert.match(url, /travelmode=walking/);
});

test('buildPathUrl uses the !3e2 suffix for walking (verified empirically, see README)', () => {
  const url = buildPathUrl([p(43.1, 1.1), p(43.2, 1.2)], 'walking');
  assert.equal(url, 'https://www.google.com/maps/dir/43.1,1.1/43.2,1.2/data=!4m2!4m1!3e2');
});

test('buildPathUrl still uses the !3e1 suffix for bicycling (default)', () => {
  const url = buildPathUrl([p(43.1, 1.1), p(43.2, 1.2)]);
  assert.match(url, /!3e1$/);
});

test('buildApiUrl/buildPathUrl reject an invalid mode', () => {
  assert.throws(() => buildApiUrl([p(1, 1), p(2, 2)], 'driving'));
  assert.throws(() => buildPathUrl([p(1, 1), p(2, 2)], 'driving'));
});

test('computeCapacity follows 9*numLinks + 1', () => {
  assert.equal(computeCapacity(1), 10);
  assert.equal(computeCapacity(2), 19);
  assert.equal(computeCapacity(6), 55);
});

test('splitIntoSegments: <= max -> a single segment', () => {
  const points = Array.from({ length: 9 }, (_, i) => p(i, i));
  assert.equal(splitIntoSegments(points).length, 1);
});

test('splitIntoSegments: exactly max -> a single segment', () => {
  const points = Array.from({ length: 10 }, (_, i) => p(i, i));
  assert.equal(splitIntoSegments(points).length, 1);
});

test('splitIntoSegments: 11 points -> 2 segments chained on the last point', () => {
  const points = Array.from({ length: 11 }, (_, i) => p(i, i));
  const segments = splitIntoSegments(points);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].length, 10);
  assert.equal(segments[1].length, 2);
  assert.deepEqual(segments[0][9], segments[1][0]);
  assert.deepEqual(segments[0][0], points[0]);
  assert.deepEqual(segments[1][1], points[10]);
});

test('splitIntoSegments: 19 points -> 2 segments', () => {
  const points = Array.from({ length: 19 }, (_, i) => p(i, i));
  const segments = splitIntoSegments(points);
  assert.equal(segments.length, 2);
});

test('splitIntoSegments: 20 points -> 3 segments', () => {
  const points = Array.from({ length: 20 }, (_, i) => p(i, i));
  const segments = splitIntoSegments(points);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[2][segments[2].length - 1], points[19]);
});

test('splitIntoSegments: every segment is chained and has >= 2 points', () => {
  const points = Array.from({ length: 37 }, (_, i) => p(i * 0.01, i * 0.01));
  const segments = splitIntoSegments(points, MAX_POINTS_PER_LINK);
  for (const seg of segments) {
    assert.ok(seg.length >= 2);
    assert.ok(seg.length <= MAX_POINTS_PER_LINK);
  }
  for (let i = 1; i < segments.length; i++) {
    assert.deepEqual(segments[i][0], segments[i - 1][segments[i - 1].length - 1]);
  }
});

test('generated URLs stay under the 2048-character Google Maps limit', () => {
  const points = Array.from({ length: MAX_POINTS_PER_LINK }, (_, i) => p(43 + i * 0.001, 1 + i * 0.001));
  assert.ok(buildApiUrl(points).length < GOOGLE_MAPS_URL_MAX_LENGTH);
  assert.ok(buildPathUrl(points).length < GOOGLE_MAPS_URL_MAX_LENGTH);
});

test('security: buildApiUrl/buildPathUrl only serialize lat/lng, never leaking extra point properties (e.g. a Komoot share token)', () => {
  const points = [
    { lat: 43.1, lng: 1.1, shareToken: 'SECRET_TOKEN', name: 'leak me' },
    { lat: 43.2, lng: 1.2, shareToken: 'SECRET_TOKEN', name: 'leak me' },
  ];
  assert.doesNotMatch(buildApiUrl(points), /SECRET_TOKEN|leak me/);
  assert.doesNotMatch(buildPathUrl(points), /SECRET_TOKEN|leak me/);
});
