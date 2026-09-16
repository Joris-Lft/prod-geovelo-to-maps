import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGpx } from '../js/gpx.js';

test('buildGpx produces a well-formed GPX with N trkpt in lat/lon order', () => {
  const track = [
    { lat: 43.590853, lng: 1.396755 },
    { lat: 43.6, lng: 1.4 },
    { lat: 43.608432, lng: 1.385408 },
  ];
  const gpx = buildGpx(track, []);

  assert.match(gpx, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1.1"/);

  const trkptMatches = [...gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)">/g)];
  assert.equal(trkptMatches.length, track.length);
  trkptMatches.forEach((m, i) => {
    assert.equal(Number(m[1]), track[i].lat);
    assert.equal(Number(m[2]), track[i].lng);
  });

  // Balises correctement fermées (comptage égal ouverture/fermeture).
  assert.equal((gpx.match(/<trkpt /g) || []).length, (gpx.match(/<\/trkpt>/g) || []).length);
  assert.match(gpx, /<trkseg>[\s\S]*<\/trkseg>/);
  assert.match(gpx, /<trk>[\s\S]*<\/trk>/);
  assert.match(gpx, /<\/gpx>\s*$/);
});

test('buildGpx includes waypoints with escaped names', () => {
  const track = [
    { lat: 43.0, lng: 1.0 },
    { lat: 43.1, lng: 1.1 },
  ];
  const waypoints = [
    { lat: 43.0, lng: 1.0, kind: 'anchor' },
    { lat: 43.05, lng: 1.05, kind: 'added', name: 'Rue <Test> & "Co"' },
  ];
  const gpx = buildGpx(track, waypoints);

  const wptMatches = [...gpx.matchAll(/<wpt lat="([^"]+)" lon="([^"]+)">/g)];
  assert.equal(wptMatches.length, 2);
  assert.match(gpx, /<name>Point Geovelo 1<\/name>/);
  assert.match(gpx, /Rue &lt;Test&gt; &amp; &quot;Co&quot;/);
});

test('buildGpx throws when the track is empty', () => {
  assert.throws(() => buildGpx([], []));
});

test('buildGpx with asRoute produces a <rte> with <rtept>, no <trk>', () => {
  const track = [
    { lat: 43.0, lng: 1.0, kind: 'anchor' },
    { lat: 43.1, lng: 1.1, kind: 'anchor' },
  ];
  const gpx = buildGpx(track, track, { asRoute: true });

  assert.doesNotMatch(gpx, /<trk>/);
  assert.doesNotMatch(gpx, /<trkpt/);
  assert.match(gpx, /<rte>[\s\S]*<\/rte>/);

  const rteptMatches = [...gpx.matchAll(/<rtept lat="([^"]+)" lon="([^"]+)">/g)];
  assert.equal(rteptMatches.length, track.length);
  rteptMatches.forEach((m, i) => {
    assert.equal(Number(m[1]), track[i].lat);
    assert.equal(Number(m[2]), track[i].lng);
  });
});
