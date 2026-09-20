import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKomootUrl, KomootParseError } from '../js/komoot-parser.js';

// Jeton et code factices : seule la FORME d'une URL d'invitation réelle est reproduite
// (paramètres et structure), aucune valeur réelle n'est utilisée ici.
const SAMPLE_URL =
  'https://www.komoot.com/invite-tour/3041888689?code=TEST_CODE&ref=wtd' +
  '&share_token=TEST_SHARE_TOKEN&t_s=referral&t_cid=route_share&t_ref_username=TEST_USER_ID';

test('parses the reference invite-tour URL with its share_token', () => {
  const result = parseKomootUrl(SAMPLE_URL);
  assert.equal(result.tourId, '3041888689');
  assert.equal(result.shareToken, 'TEST_SHARE_TOKEN');
});

test('parses a bare /tour/<id> URL without share_token', () => {
  const result = parseKomootUrl('https://www.komoot.com/tour/108683968');
  assert.equal(result.tourId, '108683968');
  assert.equal(result.shareToken, null);
});

test('accepts the komoot.de domain', () => {
  const result = parseKomootUrl('https://www.komoot.de/tour/108683968');
  assert.equal(result.tourId, '108683968');
});

test('accepts the URL without the https:// scheme', () => {
  const result = parseKomootUrl(SAMPLE_URL.replace('https://', ''));
  assert.equal(result.tourId, '3041888689');
});

test('trims surrounding whitespace', () => {
  const result = parseKomootUrl(`  ${SAMPLE_URL}  \n`);
  assert.equal(result.tourId, '3041888689');
});

test('decodes a percent-encoded URL (https%3A...)', () => {
  const encoded =
    'https%3A%2F%2Fwww.komoot.com%2Ftour%2F108683968%3Fshare_token%3Dabc123';
  const result = parseKomootUrl(encoded);
  assert.equal(result.tourId, '108683968');
  assert.equal(result.shareToken, 'abc123');
});

test('EMPTY error on empty input', () => {
  assert.throws(() => parseKomootUrl(''), (err) => {
    assert.ok(err instanceof KomootParseError);
    assert.equal(err.code, 'EMPTY');
    return true;
  });
  assert.throws(() => parseKomootUrl('   '), (err) => err.code === 'EMPTY');
});

test('INVALID_URL error when the text is not a URL', () => {
  assert.throws(() => parseKomootUrl("ceci n'est pas une url"), (err) => {
    assert.ok(err instanceof KomootParseError);
    assert.equal(err.code, 'INVALID_URL');
    return true;
  });
});

test('INVALID_URL: plain text without "://" and without a dot', () => {
  assert.throws(() => parseKomootUrl('komoot'), (err) => err.code === 'INVALID_URL');
});

test('NOT_KOMOOT error when the host is not Komoot', () => {
  assert.throws(
    () => parseKomootUrl('https://geovelo.app/fr/route/?from=1,1&to=2,2'),
    (err) => {
      assert.ok(err instanceof KomootParseError);
      assert.equal(err.code, 'NOT_KOMOOT');
      return true;
    }
  );
});

test('NOT_KOMOOT: a host that merely contains "komoot" as a substring is rejected', () => {
  assert.throws(
    () => parseKomootUrl('https://komoot.com.evil.com/tour/123'),
    (err) => err.code === 'NOT_KOMOOT'
  );
  assert.throws(
    () => parseKomootUrl('https://evilkomoot.com/tour/123'),
    (err) => err.code === 'NOT_KOMOOT'
  );
});

test('MISSING_TOUR_ID error when the URL has no tour id', () => {
  assert.throws(
    () => parseKomootUrl('https://www.komoot.com/discover'),
    (err) => {
      assert.ok(err instanceof KomootParseError);
      assert.equal(err.code, 'MISSING_TOUR_ID');
      return true;
    }
  );
});
