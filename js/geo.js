// Utilitaires géométriques purs (sans DOM), réutilisés par router.js, waypoints.js et app.js.

const EARTH_RADIUS_M = 6371000;

export function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** Distance grand cercle entre deux points {lat,lng}, en mètres. */
export function haversineDistance(a, b) {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Projection plane locale (équirectangulaire) centrée sur une latitude de
// référence : suffisante pour des distances courtes (quelques dizaines de km).
function toPlanar(point, refLatRad) {
  return {
    x: toRadians(point.lng) * EARTH_RADIUS_M * Math.cos(refLatRad),
    y: toRadians(point.lat) * EARTH_RADIUS_M,
  };
}

/** Distance d'un point {lat,lng} au segment [a,b], en mètres (projection plane locale). */
export function distancePointToSegmentMeters(p, a, b) {
  const refLatRad = toRadians((a.lat + b.lat) / 2);
  const P = toPlanar(p, refLatRad);
  const A = toPlanar(a, refLatRad);
  const B = toPlanar(b, refLatRad);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const closestX = A.x + t * dx;
  const closestY = A.y + t * dy;
  return Math.hypot(P.x - closestX, P.y - closestY);
}

/** Distances cumulées (en mètres) le long d'une polyligne [{lat,lng}, ...]. */
export function cumulativeDistances(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineDistance(coords[i - 1], coords[i]));
  }
  return cum;
}

/** Longueur totale d'une polyligne, en mètres. */
export function pathLength(coords) {
  const cum = cumulativeDistances(coords);
  return cum[cum.length - 1] || 0;
}

/**
 * Point situé à `targetDist` mètres du début de la polyligne (interpolation
 * linéaire entre les deux sommets encadrants). Retourne aussi `idx`, l'index
 * fractionnaire sur la géométrie (ex. 3.4 = 40% entre les sommets 3 et 4).
 */
export function pointAtCumulativeDistance(coords, cumDist, targetDist) {
  if (coords.length === 1 || targetDist <= 0) {
    return { lat: coords[0].lat, lng: coords[0].lng, idx: 0 };
  }
  const last = cumDist[cumDist.length - 1];
  if (targetDist >= last) {
    const li = coords.length - 1;
    return { lat: coords[li].lat, lng: coords[li].lng, idx: li };
  }
  let lo = 0;
  let hi = cumDist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] < targetDist) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const segStart = cumDist[i - 1];
  const segEnd = cumDist[i];
  const segLen = segEnd - segStart;
  const t = segLen === 0 ? 0 : (targetDist - segStart) / segLen;
  const a = coords[i - 1];
  const b = coords[i];
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
    idx: i - 1 + t,
  };
}

/**
 * Index du sommet le plus proche de `point`, en cherchant uniquement à partir
 * de `fromIdx` (recherche "monotone" : utile pour projeter des ancres dans
 * l'ordre du trajet sans revenir en arrière).
 */
export function nearestVertexIndex(coords, point, fromIdx = 0) {
  let bestIdx = fromIdx;
  let bestDist = Infinity;
  for (let i = fromIdx; i < coords.length; i++) {
    const d = haversineDistance(coords[i], point);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

const ANCHOR_PASS_TOLERANCE_M = 10;

/**
 * Index correspondant à `point`, en avançant STRICTEMENT depuis `fromIdx`
 * (jamais en arrière, jamais au-delà de `toIdx`). Contrairement à
 * `nearestVertexIndex` (minimum global, sujet aux boucles/allers-retours où
 * la géométrie repasse plus près du point plus tard sur le trajet),
 * cette fonction retient le PREMIER passage de la géométrie sous le seuil
 * minimumGlobalRestant + 10 m et renvoie le sommet le plus proche de ce
 * passage. BRouter fait réellement passer le tracé par chaque étape (point
 * recalé sur la voie), donc ce minimum est quasi nul : un seuil serré évite
 * de retenir une rue voisine longée plus tôt, tout en restant robuste aux
 * allers-retours (les deux passages sont alors à distance quasi égale).
 */
export function sequentialNearestIndex(coords, point, fromIdx, toIdx = coords.length - 1) {
  const start = Math.max(0, Math.min(fromIdx, coords.length - 1));
  const end = Math.max(start, Math.min(toIdx, coords.length - 1));

  let globalMinDist = Infinity;
  let globalMinIdx = start;
  for (let i = start; i <= end; i++) {
    const d = haversineDistance(coords[i], point);
    if (d < globalMinDist) {
      globalMinDist = d;
      globalMinIdx = i;
    }
  }
  const threshold = globalMinDist + ANCHOR_PASS_TOLERANCE_M;

  // Premier passage sous le seuil : on garde le meilleur sommet de toute la
  // portion continue sous le seuil (un simple minimum local serait sensible
  // au bruit de la géométrie).
  let passMinIdx = -1;
  let passMinDist = Infinity;
  for (let i = start; i <= end; i++) {
    const d = haversineDistance(coords[i], point);
    if (d < threshold) {
      if (d < passMinDist) {
        passMinDist = d;
        passMinIdx = i;
      }
    } else if (passMinIdx !== -1) {
      return passMinIdx;
    }
  }
  if (passMinIdx !== -1) return passMinIdx;

  // Plage vide ou dégénérée : minimum global (garanti dans [start, end]).
  return globalMinIdx;
}
