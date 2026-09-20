// Appel de l'API publique Komoot (v007) et parsing de sa réponse en une
// structure compatible avec `selectWaypoints` (js/waypoints.js), pour
// réutiliser le même algorithme de sélection de points que pour BRouter.
// La construction/le parsing sont purs et testables ; seul fetchKomootTour
// touche au réseau (mockable via globalThis.fetch dans les tests).
import { cumulativeDistances } from './geo.js';
import { RoutingError } from './errors.js';

// Correspondance des types de voie Komoot (`_embedded.way_types.items[].element`)
// vers des tags OSM équivalents, pour réutiliser le bonus "voie cyclable"
// existant de waypoints.js (`hasCyclableBonus`). Volontairement minimale :
// seuls les cas listés dans la spec sont couverts, le reste retombe sur `{}`
// (aucun bonus, mais le candidat reste valide).
const WAY_TYPE_MAP = {
  'wt#cycleway': { highway: 'cycleway' },
  'wt#footway': { highway: 'footway' },
  'wt#minor_road': { highway: 'residential' },
  'wt#street': { highway: 'unclassified' },
  'wt#primary': { highway: 'primary' },
};

// Correspondance des surfaces Komoot (`_embedded.surfaces.items[].element`)
// vers la clé OSM `surface`, uniquement pour les cas simples et non ambigus
// (voir findSurfaceTag ci-dessous) ; le reste est ignoré.
const SURFACE_MAP = {
  'sf#asphalt': 'asphalt',
  'sf#paved': 'paved',
  'sf#concrete': 'concrete',
  'sf#gravel': 'gravel',
  'sf#unpaved': 'unpaved',
  'sf#cobblestone': 'cobblestone',
  'sf#compacted': 'compacted',
  'sf#dirt': 'dirt',
  'sf#sand': 'sand',
  'sf#ground': 'ground',
  'sf#grass': 'grass',
};

// Sports Komoot considérés comme de la marche. Liste non exhaustive et non
// officiellement documentée par Komoot (aucune énumération publique connue
// des valeurs possibles de `sport`) : construite par déduction à partir des
// noms de sport courants, à ajuster si de nouvelles valeurs sont observées.
// Volontairement exclu : `touring` (trop ambigu, à ne pas confondre avec
// `touringbicycle`, un sport vélo). Le reste — vélo route, VTT, gravel,
// ville, avec ou sans assistance électrique... et tout sport inconnu non
// listé ici — est considéré comme du vélo.
const WALK_SPORTS = new Set([
  'hike',
  'nordicwalking',
  'jogging',
  'mountaineering',
  'winterhiking',
  'snowshoe',
  'climbing',
  'skitour',
]);

/** Déduit le mode de déplacement Google Maps (`bicycling`/`walking`) du sport Komoot. */
export function modeForSport(sport) {
  return WALK_SPORTS.has(sport) ? 'walking' : 'bicycling';
}

/** Construit l'URL d'appel de l'API Komoot pour un tour donné. */
export function buildKomootTourUrl(tourId, shareToken) {
  const params = new URLSearchParams({ _embedded: 'coordinates,way_types,surfaces,directions' });
  if (shareToken) params.set('share_token', shareToken);
  return `https://www.komoot.com/api/v007/tours/${encodeURIComponent(tourId)}?${params.toString()}`;
}

/**
 * Cherche, pour l'intervalle [from,to] d'un tronçon `way_types`, un unique
 * élément `surfaces` qui le couvre entièrement. En cas d'ambiguïté (aucune
 * surface ne le couvre entièrement, ou plusieurs surfaces différentes se
 * partagent l'intervalle), on ignore plutôt que de deviner : les limites de
 * `way_types` et `surfaces` ne coïncident pas toujours.
 */
function findSurfaceTag(surfaceItems, from, to) {
  const covering = surfaceItems.filter((s) => s.from <= from && s.to >= to);
  if (covering.length === 0) return {};
  const elements = new Set(covering.map((s) => s.element));
  if (elements.size !== 1) return {};
  const surface = SURFACE_MAP[covering[0].element];
  return surface ? { surface } : {};
}

/**
 * Construit les sections à partir de `_embedded.way_types.items` : `from`/`to`
 * sont déjà des index de géométrie (pas de projection à refaire, contrairement
 * à BRouter). `nodeTags` reste toujours `{}` : Komoot ne fournit aucune
 * information sur les nœuds (carrefours, feux, passages piétons...), donc la
 * règle "nœud dangereux" de waypoints.js ne s'applique jamais ici — seules
 * restent actives la longueur minimale de section, l'exclusion des
 * ronds-points et la distance minimale aux ancres.
 *
 * Robuste à une réponse imparfaite : les items sans `from`/`to` entiers (ou
 * avec `to <= from`) sont ignorés plutôt que de produire des index `NaN`
 * (qui casseraient `cumDist[NaN]` et, en aval, `waypoints.js`). Les trous
 * — en fin de tracé, mais aussi ENTRE deux items (`way_types` peut ne pas
 * couvrir 100 % de la géométrie) — sont comblés par une section sans tags,
 * jamais choisie comme candidat cyclable faute de tags (comme pour BRouter).
 */
function buildSections(wayTypeItems, surfaceItems, coords, cumDist) {
  const lastIdx = coords.length - 1;
  const sections = [];

  const validItems = (Array.isArray(wayTypeItems) ? wayTypeItems : [])
    .filter((item) => item && Number.isInteger(item.from) && Number.isInteger(item.to) && item.to > item.from)
    .map((item) => ({
      element: item.element,
      from: Math.max(0, Math.min(item.from, lastIdx)),
      to: Math.max(0, Math.min(item.to, lastIdx)),
    }))
    .filter((item) => item.to > item.from)
    .sort((a, b) => a.from - b.from);

  let prevEnd = 0;
  for (const item of validItems) {
    if (item.from > prevEnd) {
      // Trou intérieur non décrit par way_types : section sans tags.
      sections.push({
        startIdx: prevEnd,
        endIdx: item.from,
        wayTags: {},
        nodeTags: {},
        lengthM: cumDist[item.from] - cumDist[prevEnd],
      });
      prevEnd = item.from;
    }
    const startIdx = Math.max(item.from, prevEnd);
    if (item.to <= startIdx) continue; // entièrement recouvert par ce qui précède (chevauchement)

    const wayTags = { ...(WAY_TYPE_MAP[item.element] || {}), ...findSurfaceTag(surfaceItems, startIdx, item.to) };
    sections.push({
      startIdx,
      endIdx: item.to,
      wayTags,
      nodeTags: {},
      lengthM: cumDist[item.to] - cumDist[startIdx],
    });
    prevEnd = item.to;
  }

  // La toute fin du tracé peut ne pas être décrite : section finale sans tags.
  if (prevEnd < lastIdx) {
    sections.push({
      startIdx: prevEnd,
      endIdx: lastIdx,
      wayTags: {},
      nodeTags: {},
      lengthM: cumDist[lastIdx] - cumDist[prevEnd],
    });
  }

  return sections;
}

/**
 * Transforme la réponse de l'API Komoot en structure exploitable par
 * `selectWaypoints`, au même format que `parseBrouterResponse` :
 * { coords, sections, lengthM, anchors, name, sport }.
 *
 * `anchors` vient de `path` : chaque étape posée par l'auteur du tour
 * ({location:{lat,lng}, index}) où `index` pointe DIRECTEMENT dans la
 * géométrie — aucune projection à refaire, contrairement aux ancres Geovelo.
 */
export function parseKomootTour(json) {
  const embedded = json && json._embedded;
  const coordItems = embedded && embedded.coordinates && embedded.coordinates.items;
  if (!Array.isArray(coordItems) || coordItems.length < 2) {
    throw new RoutingError('INVALID_RESPONSE', 'Réponse Komoot inattendue (géométrie manquante).');
  }

  const coords = coordItems.map((c) => {
    if (!c || typeof c !== 'object' || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
      throw new RoutingError('INVALID_RESPONSE', 'Réponse Komoot inattendue (coordonnées invalides).');
    }
    return { lat: c.lat, lng: c.lng };
  });

  const cumDist = cumulativeDistances(coords);
  const lengthM = Number(json.distance) || cumDist[cumDist.length - 1];

  const wayTypeItems = (embedded.way_types && embedded.way_types.items) || [];
  const surfaceItems = (embedded.surfaces && embedded.surfaces.items) || [];
  const sections = buildSections(wayTypeItems, surfaceItems, coords, cumDist);

  const pathItems = Array.isArray(json.path) ? json.path : [];
  const rawAnchors = pathItems
    .filter((p) => p && p.location && Number.isFinite(p.location.lat) && Number.isFinite(p.location.lng) && Number.isInteger(p.index))
    .map((p) => ({ lat: p.location.lat, lng: p.location.lng, idx: p.index }));

  if (rawAnchors.length < 2) {
    throw new RoutingError('INVALID_RESPONSE', "Réponse Komoot inattendue (moins de deux étapes dans le tracé).");
  }

  // Les index `path[].index` ne sont utilisables tels quels (voir
  // waypoints.js, ancres pré-indexées) que s'ils sont TOUS dans les bornes de
  // la géométrie et strictement croissants. Sinon, on retire `idx` de
  // TOUTES les ancres plutôt que de trafiquer des valeurs incohérentes :
  // `selectWaypoints` retombe alors sur la projection par recherche
  // (`projectAnchors`), comme pour Geovelo.
  const lastIdx = coords.length - 1;
  const indicesUsable =
    rawAnchors.every((a) => a.idx >= 0 && a.idx <= lastIdx) &&
    rawAnchors.every((a, i) => i === 0 || a.idx > rawAnchors[i - 1].idx);
  const anchors = indicesUsable ? rawAnchors : rawAnchors.map(({ lat, lng }) => ({ lat, lng }));

  return { coords, sections, lengthM, anchors, name: json.name || '', sport: json.sport || '' };
}

/**
 * Sous-échantillonne une liste d'ancres à `maxCount` éléments au maximum,
 * en conservant toujours la première (départ) et la dernière (arrivée), et
 * en répartissant les autres aussi régulièrement que possible le long de la
 * liste d'origine. Utilisée quand un tour Komoot dépasse le nombre d'étapes
 * gérable (plus de points que la capacité maximale, voir gmaps-links.js) :
 * contrairement à Geovelo, l'utilisateur ne maîtrise pas forcément le nombre
 * d'étapes du tour, donc on dégrade plutôt que d'échouer.
 */
export function limitAnchors(anchors, maxCount) {
  if (!Array.isArray(anchors)) return anchors;
  if (!Number.isInteger(maxCount) || maxCount < 2) {
    throw new Error('maxCount doit être un entier >= 2.');
  }
  if (anchors.length <= maxCount) return anchors;

  const n = anchors.length;
  const chosen = new Set([0, n - 1]);
  const innerCount = maxCount - 2;
  for (let i = 1; i <= innerCount && chosen.size < maxCount; i++) {
    let pos = Math.round((i * (n - 1)) / (innerCount + 1));
    pos = Math.min(Math.max(pos, 1), n - 2);
    while (chosen.has(pos) && pos < n - 2) pos++;
    while (chosen.has(pos) && pos > 1) pos--;
    chosen.add(pos);
  }

  return [...chosen].sort((a, b) => a - b).map((i) => anchors[i]);
}

/**
 * Appelle l'API publique Komoot (v007) pour un tour donné, avec timeout.
 * Même logique d'abandon/timeout que `fetchBrouterRoute` (voir router.js) :
 * un abandon déclenché par l'appelant (`options.signal`) est distingué d'un
 * dépassement de délai interne via le code `ABORTED` (vs `TIMEOUT`).
 *
 * `share_token` est optionnel pour un tour public, mais obligatoire pour un
 * tour partagé en privé (403 sans lui) : on l'envoie toujours quand il est
 * fourni.
 */
export async function fetchKomootTour(tourId, shareToken, options = {}) {
  const { signal, timeoutMs = 20000 } = options;
  const url = buildKomootTourUrl(tourId, shareToken);

  const controller = new AbortController();
  let externallyAborted = false;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort);
  }

  function translateAbortError() {
    return externallyAborted
      ? new RoutingError('ABORTED', 'Conversion annulée.')
      : new RoutingError('TIMEOUT', "L'API Komoot n'a pas répondu à temps.");
  }

  try {
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw translateAbortError();
      throw new RoutingError('NETWORK', "Impossible de contacter l'API Komoot.");
    }

    if (response.status === 403) {
      throw new RoutingError(
        'FORBIDDEN',
        "Ce tour Komoot n'est pas public : utilisez le lien de partage (bouton Partager dans Komoot)."
      );
    }
    if (response.status === 404) {
      throw new RoutingError('NOT_FOUND', 'Tour Komoot introuvable.');
    }
    if (!response.ok) {
      let text = '';
      try {
        text = await response.text();
      } catch (err) {
        if (err && err.name === 'AbortError') throw translateAbortError();
      }
      throw new RoutingError(
        'HTTP',
        `L'API Komoot a renvoyé une erreur (HTTP ${response.status})${text ? ' : ' + text.slice(0, 200) : ''}`
      );
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      if (err && err.name === 'AbortError') throw translateAbortError();
      throw new RoutingError('INVALID_RESPONSE', 'Réponse Komoot invalide (JSON illisible).');
    }

    return parseKomootTour(json);
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}
