// Sélection des points intermédiaires à envoyer à Google Maps, pour que le
// tracé recalculé colle au mieux à la géométrie réelle (voies cyclables).
// Module pur : aucune dépendance au DOM.
import {
  haversineDistance,
  distancePointToSegmentMeters,
  cumulativeDistances,
  pointAtCumulativeDistance,
  sequentialNearestIndex,
} from './geo.js';

const MIN_SECTION_LENGTH_M = 60;
const MIN_EDGE_MARGIN_M = 30;
const MIN_ANCHOR_DISTANCE_M = 40;
const MIN_DEVIATION_STOP_M = 25;
const INVALID_HIGHWAYS = new Set(['steps', 'elevator', 'platform']);
const ROUNDABOUT_JUNCTIONS = new Set(['roundabout', 'circular']);
const HAZARD_NODE_HIGHWAYS = new Set([
  'traffic_signals',
  'crossing',
  'stop',
  'give_way',
  'mini_roundabout',
  'turning_circle',
]);
// Décalages essayés le long d'une section si le point milieu (50 %) tombe
// trop près d'une extrémité de section ou d'un nœud dangereux.
const CANDIDATE_OFFSETS = [0.5, 0.35, 0.65];

function isRoundabout(wayTags) {
  return !!wayTags && ROUNDABOUT_JUNCTIONS.has(wayTags.junction);
}

function isInvalidHighway(wayTags) {
  return !!wayTags && INVALID_HIGHWAYS.has(wayTags.highway);
}

/** Bonus "voie cyclable" d'après les tags OSM du tronçon (voir spec §3). */
function hasCyclableBonus(wayTags) {
  if (!wayTags) return false;
  const { highway, bicycle, bicycle_road, cyclestreet } = wayTags;
  if (highway === 'cycleway') return true;
  if ((highway === 'path' || highway === 'track') && (bicycle === 'designated' || bicycle === 'yes')) {
    return true;
  }
  if (bicycle_road === 'yes') return true;
  if (cyclestreet === 'yes') return true;
  if (
    (highway === 'living_street' || highway === 'pedestrian') &&
    (bicycle === 'yes' || bicycle === 'designated')
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(wayTags)) {
    if (key.startsWith('cycleway') && (value === 'track' || value === 'lane' || value === 'separate')) {
      return true;
    }
  }
  return false;
}

/** Nœuds "dangereux" (carrefours, feux, passages piétons...) : coords des extrémités de section tagguées. */
function collectHazardPoints(coords, sections) {
  const points = [];
  for (const section of sections) {
    const tag = section.nodeTags && section.nodeTags.highway;
    if (tag && HAZARD_NODE_HIGHWAYS.has(tag) && coords[section.endIdx]) {
      points.push(coords[section.endIdx]);
    }
  }
  return points;
}

/**
 * Tente de placer un candidat à la fraction `t` de la section [startIdx,endIdx].
 * Rejette (retourne null) si le point réel (distance à vol d'oiseau, pas
 * distance le long du tracé) tombe à moins de 30 m d'une extrémité de la
 * section ou d'un nœud dangereux.
 */
function tryCandidateOffset(coords, cumDist, section, hazardPoints, t) {
  const { startIdx, endIdx, lengthM } = section;
  const targetDist = cumDist[startIdx] + lengthM * t;
  const point = pointAtCumulativeDistance(coords, cumDist, targetDist);

  if (haversineDistance(point, coords[startIdx]) < MIN_EDGE_MARGIN_M) return null;
  if (haversineDistance(point, coords[endIdx]) < MIN_EDGE_MARGIN_M) return null;
  for (const hazard of hazardPoints) {
    if (haversineDistance(point, hazard) < MIN_EDGE_MARGIN_M) return null;
  }
  return point;
}

/** Un candidat par section valide : le point milieu en distance, décalé si besoin (35 %/65 %). */
function buildCandidates(coords, sections, cumDist) {
  const hazardPoints = collectHazardPoints(coords, sections);
  const candidates = [];
  sections.forEach((section, sectionIndex) => {
    const { lengthM, wayTags } = section;
    if (lengthM < MIN_SECTION_LENGTH_M) return;
    if (isRoundabout(wayTags) || isInvalidHighway(wayTags)) return;

    let point = null;
    for (const t of CANDIDATE_OFFSETS) {
      point = tryCandidateOffset(coords, cumDist, section, hazardPoints, t);
      if (point) break;
    }
    if (!point) return;

    candidates.push({
      lat: point.lat,
      lng: point.lng,
      idx: point.idx,
      sectionIndex,
      bonus: hasCyclableBonus(wayTags) ? 1 : 0,
    });
  });
  return candidates;
}

function tooCloseToAny(point, others, minDist) {
  return others.some((o) => haversineDistance(point, o) < minDist);
}

/**
 * Projette les ancres Geovelo sur la géométrie de la route, dans l'ordre :
 * - départ → toujours l'index 0, arrivée → toujours le dernier index
 *   (pas de recherche : sur une boucle, départ ≈ arrivée, une recherche par
 *   plus-proche-voisin se tromperait facilement d'extrémité).
 * - étapes intermédiaires → recherche séquentielle (voir geo.sequentialNearestIndex),
 *   qui avance depuis l'ancre précédente et retient le premier passage du
 *   tracé au plus près de l'étape, robuste aux boucles et allers-retours.
 * Index croissants (strictement dès que la géométrie compte plus de sommets
 * que d'ancres, ce qui est toujours le cas avec une réponse BRouter).
 */
function projectAnchors(coords, anchors) {
  const lastIdx = coords.length - 1;
  const selected = [{ lat: anchors[0].lat, lng: anchors[0].lng, kind: 'anchor', idx: 0 }];

  let searchFrom = 1;
  for (let i = 1; i < anchors.length - 1; i++) {
    const anchor = anchors[i];
    const upperBound = Math.max(searchFrom, lastIdx - 1);
    let idx = sequentialNearestIndex(coords, anchor, searchFrom, upperBound);
    const prevIdx = selected[selected.length - 1].idx;
    if (idx <= prevIdx) idx = prevIdx + 1; // garde-fou : strictement croissant
    idx = Math.min(idx, lastIdx - 1);
    selected.push({ lat: anchor.lat, lng: anchor.lng, kind: 'anchor', idx });
    searchFrom = idx + 1;
  }

  const last = anchors[anchors.length - 1];
  selected.push({ lat: last.lat, lng: last.lng, kind: 'anchor', idx: lastIdx });
  return selected;
}

/**
 * Vrai si toutes les ancres portent déjà un index numérique de géométrie
 * (cas Komoot : `path[].index` pointe directement dans `_embedded.coordinates`,
 * aucune projection à refaire). Les ancres Geovelo n'ont pas de champ `idx`.
 */
function hasPreIndexedAnchors(anchors) {
  return anchors.every((a) => Number.isFinite(a.idx));
}

/**
 * Utilise directement les index fournis (normalement déjà croissants et dans
 * les bornes, comme les étapes `path` d'un tour Komoot) plutôt que de les
 * projeter par recherche : contrairement à Geovelo, ces index sont exacts et
 * fiables. Vérifie tout de même la cohérence et corrige a minima les écarts
 * (garde-fous) sans lever d'erreur :
 * 1. Départ → index 0, arrivée → dernier index, comme pour Geovelo — posés
 *    AVANT la correction de croissance, pour que celle-ci parte de bornes
 *    déjà correctes plutôt que d'un `idx` d'origine potentiellement aberrant.
 * 2. Passe avant (depuis le départ) : chaque index est ramené à au moins
 *    `précédent + 1`, sans jamais dépasser `lastIdx - 1` (réservé à l'arrivée).
 * 3. Passe arrière (depuis l'arrivée) : élimine les doublons résiduels que la
 *    passe avant peut créer en fin de tracé si trop d'ancres se pressent près
 *    de `lastIdx` (ex. 3 sommets, ancres `idx` [0, 999, 1000] → [0, 1, 2] et
 *    non [0, 2, 2]).
 */
function usePreIndexedAnchors(coords, anchors) {
  const lastIdx = coords.length - 1;
  const idx = anchors.map((a) => Math.max(0, Math.min(Math.round(a.idx), lastIdx)));

  idx[0] = 0;
  idx[idx.length - 1] = lastIdx;

  for (let i = 1; i < idx.length - 1; i++) {
    if (idx[i] <= idx[i - 1]) idx[i] = idx[i - 1] + 1;
    idx[i] = Math.min(idx[i], lastIdx - 1);
  }
  for (let i = idx.length - 2; i >= 1; i--) {
    if (idx[i] >= idx[i + 1]) idx[i] = idx[i + 1] - 1;
  }

  return anchors.map((anchor, i) => ({ lat: anchor.lat, lng: anchor.lng, kind: 'anchor', idx: idx[i] }));
}

/**
 * @param {object} params
 * @param {{coords:Array<{lat,lng}>, sections:Array}} params.route Sortie de router.parseBrouterResponse
 *   (ou komoot.parseKomootTour, même structure).
 * @param {Array<{lat,lng,idx?:number}>} params.anchors Points, dans l'ordre (from, steps..., to).
 *   Si chaque ancre porte un `idx` numérique (ex. étapes Komoot déjà indexées
 *   dans la géométrie), la projection par recherche est sautée (voir
 *   `usePreIndexedAnchors`) ; sinon, comportement Geovelo inchangé (`projectAnchors`).
 * @param {number} params.extraBudget Nombre de points intermédiaires supplémentaires autorisés.
 * @returns {Array<{lat,lng,kind:'anchor'|'added',idx:number}>} Points triés par position sur la géométrie.
 */
export function selectWaypoints({ route, anchors, extraBudget = 0 }) {
  if (!route || !Array.isArray(route.coords) || route.coords.length < 2) {
    throw new Error('Itinéraire invalide (géométrie manquante).');
  }
  if (!Array.isArray(anchors) || anchors.length < 2) {
    throw new Error('Au moins deux ancres (départ et arrivée) sont nécessaires.');
  }

  const { coords, sections = [] } = route;
  const cumDist = cumulativeDistances(coords);

  // 1. Projection des ancres (voir projectAnchors ci-dessus), ou reprise
  // directe des index déjà fournis (voir usePreIndexedAnchors ci-dessus).
  const selected = hasPreIndexedAnchors(anchors)
    ? usePreIndexedAnchors(coords, anchors)
    : projectAnchors(coords, anchors);

  const budget = Math.max(0, Math.floor(extraBudget) || 0);
  if (budget === 0) return selected;

  // 2. Candidats issus des sections valides, hors voisinage immédiat des ancres.
  let candidates = buildCandidates(coords, sections, cumDist).filter(
    (c) => !tooCloseToAny(c, selected, MIN_ANCHOR_DISTANCE_M)
  );

  // 3-4. Sélection gloutonne type Douglas-Peucker sous budget.
  for (let iteration = 0; iteration < budget; iteration++) {
    if (candidates.length === 0) break;

    // Écart de la géométrie réelle à la corde, pour chaque intervalle entre
    // deux points consécutifs déjà retenus.
    const intervals = [];
    for (let i = 0; i < selected.length - 1; i++) {
      const a = selected[i];
      const b = selected[i + 1];
      let maxDev = 0;
      for (let vi = Math.ceil(a.idx); vi <= Math.floor(b.idx); vi++) {
        const dev = distancePointToSegmentMeters(coords[vi], a, b);
        if (dev > maxDev) maxDev = dev;
      }
      intervals.push({ position: i, a, b, maxDev });
    }
    intervals.sort((x, y) => y.maxDev - x.maxDev);

    if (intervals.length === 0 || intervals[0].maxDev < MIN_DEVIATION_STOP_M) break;

    let chosen = null;
    let chosenPosition = -1;
    for (const interval of intervals) {
      if (interval.maxDev < MIN_DEVIATION_STOP_M) break;
      const inRange = candidates.filter(
        (c) =>
          c.idx > interval.a.idx &&
          c.idx < interval.b.idx &&
          !tooCloseToAny(c, selected, MIN_ANCHOR_DISTANCE_M)
      );
      if (inRange.length === 0) continue; // aucun candidat ici : intervalle suivant

      let best = null;
      let bestScore = -Infinity;
      for (const c of inRange) {
        const dev = distancePointToSegmentMeters(c, interval.a, interval.b);
        if (dev < MIN_DEVIATION_STOP_M) continue; // écart à la corde négligeable : inutile
        const score = dev * (1 + 0.5 * c.bonus);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) continue; // tous les candidats de cet intervalle sont négligeables

      chosen = best;
      chosenPosition = interval.position;
      break;
    }

    if (!chosen) break;

    selected.splice(chosenPosition + 1, 0, {
      lat: chosen.lat,
      lng: chosen.lng,
      kind: 'added',
      idx: chosen.idx,
    });
    candidates = candidates.filter((c) => c !== chosen);
  }

  selected.sort((a, b) => a.idx - b.idx);
  return selected;
}
