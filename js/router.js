// Appel du service de routage BRouter (niveau 2) et parsing de sa réponse.
// La construction/le parsing sont purs et testables ; seul fetchBrouterRoute
// touche au réseau (mockable via globalThis.fetch dans les tests).
import { cumulativeDistances } from './geo.js';
import { RoutingError } from './errors.js';

// Réexporté pour compatibilité (code existant et tests important RoutingError
// depuis router.js) ; la définition vit dans errors.js, partagée avec komoot.js.
export { RoutingError };

/** Construit l'URL de requête BRouter pour une liste ordonnée de points {lat,lng}. */
export function buildBrouterUrl(points, profile = 'safety', alternativeidx = 0) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('Au moins deux points sont nécessaires pour appeler BRouter.');
  }
  const lonlats = points.map((p) => `${p.lng},${p.lat}`).join('|');
  const params = new URLSearchParams({
    lonlats,
    profile,
    alternativeidx: String(alternativeidx),
    format: 'geojson',
  });
  return `https://brouter.de/brouter?${params.toString()}`;
}

function parseTags(str) {
  const tags = {};
  if (!str) return tags;
  for (const pair of str.trim().split(/\s+/)) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    tags[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return tags;
}

// Demi-largeur (en mètres, le long du tracé) de la fenêtre de repli utilisée
// quand aucune correspondance exacte n'est trouvée pour une ligne
// `messages` : on cherche alors le sommet le plus proche autour de la
// position attendue (cumDist[fromIdx] + Distance du tronçon), à ±100 m.
const FALLBACK_WINDOW_M = 100;

function buildSections(messages, coords, cumDist) {
  const sections = [];
  if (!Array.isArray(messages) || messages.length < 2) return sections;
  const header = messages[0];
  const lonIdx = header.indexOf('Longitude');
  const latIdx = header.indexOf('Latitude');
  const distIdx = header.indexOf('Distance');
  const wayTagsIdx = header.indexOf('WayTags');
  const nodeTagsIdx = header.indexOf('NodeTags');
  if (lonIdx === -1 || latIdx === -1) return sections;

  let prevIdx = 0;
  let searchFrom = 0;
  for (let i = 1; i < messages.length; i++) {
    const row = messages[i];
    const lon = Number(row[lonIdx]) / 1e6;
    const lat = Number(row[latIdx]) / 1e6;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const distanceM = distIdx !== -1 ? Number(row[distIdx]) : NaN;

    const endIdx = findMatchingIndex(coords, cumDist, lat, lon, searchFrom, distanceM);
    if (endIdx <= prevIdx) {
      // Ligne dégénérée (aucun déplacement) : on l'ignore plutôt que de créer
      // une section de longueur nulle/négative.
      continue;
    }
    sections.push({
      startIdx: prevIdx,
      endIdx,
      wayTags: parseTags(row[wayTagsIdx]),
      nodeTags: parseTags(row[nodeTagsIdx]),
      lengthM: cumDist[endIdx] - cumDist[prevIdx],
    });
    prevIdx = endIdx;
    searchFrom = endIdx;
  }

  // BRouter ne décrit pas toujours la toute fin du tracé dans `messages` :
  // on ajoute une section finale sans tags pour ne pas perdre ce morceau
  // (utile pour la longueur totale et l'affichage, jamais choisi comme
  // candidat cyclable faute de tags).
  const lastIdx = coords.length - 1;
  if (prevIdx < lastIdx) {
    sections.push({
      startIdx: prevIdx,
      endIdx: lastIdx,
      wayTags: {},
      nodeTags: {},
      lengthM: cumDist[lastIdx] - cumDist[prevIdx],
    });
  }

  return sections;
}

// Les coordonnées des messages BRouter sont des entiers ×1e6 correspondant au
// point de FIN de chaque tronçon.
//
// 1. On cherche d'abord une correspondance EXACTE (arrondie), sur tout le
//    reste du tracé (pas de fenêtre : un tronçon peut dépasser largement
//    n'importe quelle borne raisonnable — ex. une longue ligne droite —, et
//    une fenêtre bornée ferait rater la correspondance exacte, fusionnant ou
//    perdant des tronçons suivants). Le coût total reste linéaire sur
//    l'ensemble d'un tracé puisque `fromIdx` avance à chaque ligne.
// 2. À défaut seulement, on retombe sur le point le plus proche, mais en
//    bornant la recherche à ±FALLBACK_WINDOW_M autour de la position attendue
//    le long du tracé (cumDist[fromIdx] + Distance du tronçon, colonne
//    "Distance" des messages), pour éviter tout saut aberrant sur un tracé
//    qui repasse près de lui-même. Si la distance du tronçon est absente ou
//    invalide, on cherche sur tout le reste du tracé.
export function findMatchingIndex(coords, cumDist, lat, lon, fromIdx, distanceM) {
  const targetLat = Math.round(lat * 1e6);
  const targetLon = Math.round(lon * 1e6);

  for (let i = fromIdx; i < coords.length; i++) {
    if (Math.round(coords[i].lat * 1e6) === targetLat && Math.round(coords[i].lng * 1e6) === targetLon) {
      return i;
    }
  }

  let searchStart = fromIdx;
  let searchEnd = coords.length - 1;
  if (Number.isFinite(distanceM) && distanceM >= 0) {
    const expected = cumDist[fromIdx] + distanceM;
    const lowerBound = expected - FALLBACK_WINDOW_M;
    const upperBound = expected + FALLBACK_WINDOW_M;
    let start = fromIdx;
    while (start < coords.length - 1 && cumDist[start] < lowerBound) start++;
    let end = start;
    while (end + 1 < coords.length && cumDist[end + 1] <= upperBound) end++;
    // Le sommet qui précède la fenêtre peut être le plus proche si une longue
    // arête l'enjambe : on l'inclut.
    searchStart = Math.max(fromIdx, start - 1);
    searchEnd = end;
  }

  let bestIdx = searchStart;
  let bestDist = Infinity;
  for (let i = searchStart; i <= searchEnd; i++) {
    const dLat = coords[i].lat - lat;
    const dLng = coords[i].lng - lon;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Transforme la réponse GeoJSON de BRouter en structure exploitable :
 * { coords:[{lat,lng}], sections:[{startIdx,endIdx,wayTags,nodeTags,lengthM}], lengthM }
 */
export function parseBrouterResponse(json) {
  const feature = json && json.features && json.features[0];
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
    throw new RoutingError('BROUTER_ERROR', 'Réponse BRouter inattendue (géométrie manquante).');
  }
  const coords = feature.geometry.coordinates.map((c) => {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
      throw new RoutingError('BROUTER_ERROR', 'Réponse BRouter inattendue (coordonnées invalides).');
    }
    return { lat: c[1], lng: c[0] };
  });
  if (coords.length < 2) {
    throw new RoutingError('BROUTER_ERROR', 'Réponse BRouter inattendue (tracé trop court).');
  }
  const cumDist = cumulativeDistances(coords);
  const props = feature.properties || {};
  const lengthM = Number(props['track-length']) || cumDist[cumDist.length - 1];
  const sections = buildSections(props.messages, coords, cumDist);

  return { coords, sections, lengthM };
}

/**
 * Appelle BRouter pour l'ensemble des points Geovelo (départ, étapes,
 * arrivée) en une seule requête, avec timeout.
 *
 * Le timeout couvre toute la requête, y compris la lecture du corps de la
 * réponse (pas seulement l'obtention des en-têtes). Un abandon déclenché par
 * l'appelant via `options.signal` (ex. nouvelle conversion lancée avant que
 * la précédente n'aboutisse) est distingué d'un dépassement du délai interne
 * via le code `ABORTED` (vs `TIMEOUT`) : l'appelant peut alors l'ignorer
 * silencieusement plutôt que d'afficher un message de repli.
 */
export async function fetchBrouterRoute(points, options = {}) {
  const { profile = 'safety', signal, timeoutMs = 20000 } = options;
  const url = buildBrouterUrl(points, profile);

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
      : new RoutingError('TIMEOUT', "Le service de routage BRouter n'a pas répondu à temps.");
  }

  try {
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw translateAbortError();
      throw new RoutingError('NETWORK', 'Impossible de contacter le service de routage BRouter.');
    }

    if (!response.ok) {
      let text = '';
      try {
        text = await response.text();
      } catch (err) {
        if (err && err.name === 'AbortError') throw translateAbortError();
        // Corps illisible : on garde un texte vide, l'erreur HTTP reste exploitable telle quelle.
      }
      throw new RoutingError(
        'HTTP',
        `BRouter a renvoyé une erreur (HTTP ${response.status})${text ? ' : ' + text.slice(0, 200) : ''}`
      );
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      if (err && err.name === 'AbortError') throw translateAbortError();
      throw new RoutingError('BROUTER_ERROR', 'Réponse BRouter invalide (JSON illisible).');
    }

    return parseBrouterResponse(json);
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}
