// Génération d'un fichier GPX (tracé + points envoyés à Google Maps).
// Module pur : aucune dépendance au DOM.

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));
}

function formatCoord(n) {
  return Number(n).toFixed(6);
}

function labelFor(point, index) {
  if (point.name) return point.name;
  if (point.kind === 'anchor') return `Point Geovelo ${index + 1}`;
  if (point.kind === 'added') return `Point ajouté ${index + 1}`;
  return `Point ${index + 1}`;
}

/**
 * @param {Array<{lat,lng}>} track Tracé complet (géométrie BRouter), ou liste de points en niveau 1.
 * @param {Array<{lat,lng,kind?,name?}>} waypoints Points envoyés à Google Maps.
 * @param {object} [options]
 * @param {boolean} [options.asRoute] En niveau 1 (pas de géométrie réelle, juste des points reliés
 *   en ligne droite), on génère un `<rte>` (route, suite d'étapes) plutôt qu'un `<trk>` (trace
 *   d'un tracé effectivement suivi) — plus fidèle au sens GPX de ces deux éléments.
 * @returns {string} Document GPX 1.1 valide.
 */
export function buildGpx(track, waypoints = [], options = {}) {
  if (!Array.isArray(track) || track.length === 0) {
    throw new Error('Le tracé est vide, impossible de générer le GPX.');
  }
  const { asRoute = false } = options;

  const wpts = waypoints
    .map((p, i) => {
      const name = escapeXml(labelFor(p, i));
      return `  <wpt lat="${formatCoord(p.lat)}" lon="${formatCoord(p.lng)}"><name>${name}</name></wpt>`;
    })
    .join('\n');

  let body;
  if (asRoute) {
    const rtepts = track
      .map((p, i) => {
        const name = escapeXml(labelFor(p, i));
        return `      <rtept lat="${formatCoord(p.lat)}" lon="${formatCoord(p.lng)}"><name>${name}</name></rtept>`;
      })
      .join('\n');
    body = `  <rte>
    <name>Itinéraire Geovelo (mode simple)</name>
${rtepts}
  </rte>`;
  } else {
    const trkpts = track
      .map((p) => `      <trkpt lat="${formatCoord(p.lat)}" lon="${formatCoord(p.lng)}"></trkpt>`)
      .join('\n');
    body = `  <trk>
    <name>Itinéraire Geovelo</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="geovelo-to-maps" xmlns="http://www.topografix.com/GPX/1/1">
${wpts ? wpts + '\n' : ''}${body}
</gpx>
`;
}
