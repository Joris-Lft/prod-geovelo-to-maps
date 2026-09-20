// Construction des liens Google Maps (mode vélo) et découpage en segments.
// Module pur : aucune dépendance au DOM.

// Limites Google (voir README) : la doc officielle des Maps URLs annonce
// jusqu'à 9 waypoints (+ origine/destination) sur navigateur non mobile,
// mais l'interface web/app de Google Maps plafonne en pratique à 10 points
// au total (origine + destination + waypoints). On cible un usage "ordinateur
// puis envoi vers le téléphone", donc on retient cette limite de 10.
export const MAX_POINTS_PER_LINK = 10;
export const GOOGLE_MAPS_URL_MAX_LENGTH = 2048;

function roundCoord(n) {
  return Math.round(n * 1e6) / 1e6;
}

function formatLatLng(p) {
  return `${roundCoord(p.lat)},${roundCoord(p.lng)}`;
}

function assertPoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('Au moins deux points (départ et arrivée) sont nécessaires.');
  }
}

const VALID_MODES = new Set(['bicycling', 'walking']);

function assertMode(mode) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Mode de déplacement invalide : « ${mode} » (attendu bicycling ou walking).`);
  }
}

/**
 * Lien Google Maps au format "API" (?api=1&origin=...&destination=...&waypoints=...&travelmode=...).
 */
export function buildApiUrl(points, mode = 'bicycling') {
  assertPoints(points);
  assertMode(mode);
  const origin = points[0];
  const destination = points[points.length - 1];
  const middle = points.slice(1, -1);

  const params = new URLSearchParams();
  params.set('api', '1');
  params.set('origin', formatLatLng(origin));
  params.set('destination', formatLatLng(destination));
  if (middle.length > 0) {
    params.set('waypoints', middle.map(formatLatLng).join('|'));
  }
  params.set('travelmode', mode);

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

// Suffixe "data=" du format chemin par mode : non documenté officiellement
// par Google, mais vérifié empiriquement (Chrome headless, voir README) :
// !3e1 sélectionne bien le mode vélo, !3e2 le mode marche (à ne pas confondre
// avec !3e3, qui sélectionne les transports en commun).
const PATH_MODE_SUFFIX = {
  bicycling: '!4m2!4m1!3e1',
  walking: '!4m2!4m1!3e2',
};

/**
 * Lien Google Maps au format "chemin" (/maps/dir/lat,lng/lat,lng/.../data=!4m2!4m1!3eN).
 * Le suffixe `data=` force le mode de déplacement dans ce format ; il n'est
 * pas documenté officiellement par Google mais a été vérifié empiriquement
 * pour le vélo et la marche (voir README).
 */
export function buildPathUrl(points, mode = 'bicycling') {
  assertPoints(points);
  assertMode(mode);
  const path = points.map(formatLatLng).join('/');
  return `https://www.google.com/maps/dir/${path}/data=${PATH_MODE_SUFFIX[mode]}`;
}

/**
 * Capacité totale de points transportables par une suite de `numLinks` liens
 * enchaînés (chaque lien reprend en premier point le dernier du précédent).
 */
export function computeCapacity(numLinks) {
  return 9 * numLinks + 1;
}

/**
 * Découpe une liste de points en segments d'au plus `maxPerLink` points,
 * chaque segment commençant par le dernier point du précédent (enchaînement).
 */
export function splitIntoSegments(points, maxPerLink = MAX_POINTS_PER_LINK) {
  assertPoints(points);
  if (maxPerLink < 2) {
    throw new Error('maxPerLink doit être au moins 2.');
  }
  if (points.length <= maxPerLink) {
    return [points.slice()];
  }

  const segments = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(start + maxPerLink, points.length);
    segments.push(points.slice(start, end));
    if (end === points.length) break;
    start = end - 1;
  }
  return segments;
}
