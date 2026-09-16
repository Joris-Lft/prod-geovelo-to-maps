import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeoveloUrl, GeoveloParseError } from '../js/geovelo-parser.js';

const SAMPLE_URL =
  'https://geovelo.app/fr/route/?bike-type=own&c=1.366207%2C43.585644&e-bike=false' +
  '&from=1.396755%2C43.590853' +
  '&steps=1.385408%2C43.608432%3B1.379080%2C43.603898%3B1.343532%2C43.577797%3B' +
  '1.330469%2C43.573911%3B1.345917%2C43.564907%3B1.359535%2C43.578102%3B1.367015%2C43.577088' +
  '&to=1.397171%2C43.590369&z=13.17&zone=toulouse';

test('parse the reference example: from/to inversion lon,lat -> {lat,lng}', () => {
  const result = parseGeoveloUrl(SAMPLE_URL);

  assert.deepEqual(result.from, { lat: 43.590853, lng: 1.396755 });
  assert.deepEqual(result.to, { lat: 43.590369, lng: 1.397171 });
  assert.equal(result.steps.length, 7);
  assert.deepEqual(result.steps[0], { lat: 43.608432, lng: 1.385408 });
  assert.deepEqual(result.steps[6], { lat: 43.577088, lng: 1.367015 });
});

test('accepts the URL without the https:// scheme', () => {
  const withoutScheme = SAMPLE_URL.replace('https://', '');
  const result = parseGeoveloUrl(withoutScheme);
  assert.deepEqual(result.from, { lat: 43.590853, lng: 1.396755 });
});

test('trims surrounding whitespace', () => {
  const result = parseGeoveloUrl(`  ${SAMPLE_URL}  \n`);
  assert.deepEqual(result.from, { lat: 43.590853, lng: 1.396755 });
});

test('steps is optional', () => {
  const url = 'https://geovelo.app/fr/route/?from=1.1,43.1&to=1.2,43.2';
  const result = parseGeoveloUrl(url);
  assert.deepEqual(result.steps, []);
});

test('accepts an unencoded URL (literal ; and ,)', () => {
  const url =
    'https://geovelo.app/fr/route/?from=1.396755,43.590853&steps=1.385408,43.608432;1.379080,43.603898&to=1.397171,43.590369';
  const result = parseGeoveloUrl(url);
  assert.deepEqual(result.from, { lat: 43.590853, lng: 1.396755 });
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps[1], { lat: 43.603898, lng: 1.37908 });
  assert.deepEqual(result.to, { lat: 43.590369, lng: 1.397171 });
});

test('EMPTY error on empty input', () => {
  assert.throws(() => parseGeoveloUrl(''), (err) => {
    assert.ok(err instanceof GeoveloParseError);
    assert.equal(err.code, 'EMPTY');
    return true;
  });
  assert.throws(() => parseGeoveloUrl('   '), (err) => err.code === 'EMPTY');
});

test('INVALID_URL error when the text is not a URL', () => {
  assert.throws(() => parseGeoveloUrl('ceci n\'est pas une url'), (err) => {
    assert.ok(err instanceof GeoveloParseError);
    assert.equal(err.code, 'INVALID_URL');
    return true;
  });
});

test('NOT_GEOVELO error when the host is not Geovelo', () => {
  assert.throws(
    () => parseGeoveloUrl('https://www.google.com/maps?from=1,1&to=2,2'),
    (err) => {
      assert.equal(err.code, 'NOT_GEOVELO');
      return true;
    }
  );
});

test('SHORT_LINK error when from/to are missing on a Geovelo host', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app/s/abc123'),
    (err) => {
      assert.ok(err instanceof GeoveloParseError);
      assert.equal(err.code, 'SHORT_LINK');
      assert.match(err.message, /lien court/i);
      return true;
    }
  );
});

test('INVALID_COORDS error on NaN coordinates', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app/fr/route/?from=abc,def&to=1,1'),
    (err) => err.code === 'INVALID_COORDS'
  );
});

test('INVALID_COORDS error on out-of-range latitude', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app/fr/route/?from=1,95&to=1,1'),
    (err) => err.code === 'INVALID_COORDS'
  );
});

test('INVALID_COORDS error on out-of-range longitude', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app/fr/route/?from=200,1&to=1,1'),
    (err) => err.code === 'INVALID_COORDS'
  );
});

test('INVALID_COORDS: empty coordinate component (from=,)', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app/fr/route/?from=,&to=1,1'),
    (err) => err.code === 'INVALID_COORDS'
  );
});

test('INVALID_COORDS: missing latitude after the comma (from=1.3,)', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app/fr/route/?from=1.3,&to=1,1'),
    (err) => err.code === 'INVALID_COORDS'
  );
});

test('INVALID_COORDS: hexadecimal is not a valid coordinate (Number("0x1") would wrongly accept it)', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app/fr/route/?from=0x1,43&to=1,1'),
    (err) => err.code === 'INVALID_COORDS'
  );
});

test('INVALID_COORDS: scientific notation is not a valid coordinate (Number("1e1") would wrongly accept it)', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app/fr/route/?from=1e1,43&to=1,1'),
    (err) => err.code === 'INVALID_COORDS'
  );
});

test('NOT_GEOVELO: a host that merely contains "geovelo" as a substring is rejected', () => {
  assert.throws(
    () => parseGeoveloUrl('https://geovelo.app.evil.com/fr/route/?from=1,1&to=2,2'),
    (err) => err.code === 'NOT_GEOVELO'
  );
  assert.throws(
    () => parseGeoveloUrl('https://evilgeovelo.app/fr/route/?from=1,1&to=2,2'),
    (err) => err.code === 'NOT_GEOVELO'
  );
});

test('accepts geovelo.fr and subdomains', () => {
  const result = parseGeoveloUrl('https://www.geovelo.fr/fr/route/?from=1.1,43.1&to=1.2,43.2');
  assert.deepEqual(result.from, { lat: 43.1, lng: 1.1 });
});

test('INVALID_URL: plain text without "://" and without a dot', () => {
  assert.throws(() => parseGeoveloUrl('geovelo'), (err) => err.code === 'INVALID_URL');
});

test('decodes a percent-encoded URL (https%3A...)', () => {
  const encoded =
    'https%3A%2F%2Fgeovelo.app%2Ffr%2Froute%2F%3Ffrom%3D1.396755%2C43.590853%26to%3D1.397171%2C43.590369';
  const result = parseGeoveloUrl(encoded);
  assert.deepEqual(result.from, { lat: 43.590853, lng: 1.396755 });
  assert.deepEqual(result.to, { lat: 43.590369, lng: 1.397171 });
});
