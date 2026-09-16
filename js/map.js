// Aperçu Leaflet de l'itinéraire. Seul module (avec app.js) à toucher au DOM.
// Attend que `L` (Leaflet, chargé via CDN dans index.html) soit disponible sur `window`.

// Couleurs vives ("400" façon Tailwind), choisies pour bien ressortir sur le
// fond sombre du thème et sur les tuiles OSM filtrées (voir .leaflet-tile-pane
// dans css/style.css) : seul le fond de carte est assombri, marqueurs et
// tracé gardent leurs couleurs réelles.
const LEGEND = [
  { key: 'anchorStart', color: '#4ade80', label: 'Départ' },
  { key: 'anchorEnd', color: '#fb7185', label: 'Arrivée' },
  { key: 'anchorStep', color: '#60a5fa', label: 'Étape Geovelo' },
  { key: 'added', color: '#fbbf24', label: 'Point ajouté' },
  { key: 'boundary', color: '#c084fc', label: 'Limite de segment' },
];
const TRACK_COLOR = '#34d399';
const MARKER_STROKE = '#0b0f14'; // liseré sombre (fond de page) pour détacher les points de la carte

let mapInstance = null;
let layerGroup = null;

export function initMap(containerId) {
  mapInstance = L.map(containerId, { scrollWheelZoom: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapInstance);
  mapInstance.setView([46.6, 2.5], 6); // vue par défaut : France
  layerGroup = L.layerGroup().addTo(mapInstance);
  return mapInstance;
}

function marker(point, color, radius, labelText) {
  const m = L.circleMarker([point.lat, point.lng], {
    radius,
    color: MARKER_STROKE,
    weight: 1.5,
    fillColor: color,
    fillOpacity: 0.95,
  });
  if (labelText) m.bindTooltip(labelText, { direction: 'top' });
  return m;
}

/**
 * @param {object} params
 * @param {Array<{lat,lng}>} params.track Géométrie du tracé (niveau 2) ou liste de points (niveau 1).
 * @param {Array<{lat,lng,kind:'anchor'|'added'}>} params.points Points envoyés à Google Maps.
 * @param {boolean} params.dashed true en niveau 1 (pas de tracé réel, ligne pointillée entre points).
 * @param {Set<number>|Array<number>} params.segmentBoundaryIndices Index (dans `points`) des
 *   points de jonction entre segments Google Maps (comparaison par position, pas par coordonnées).
 */
export function renderRoute({ track, points, dashed = false, segmentBoundaryIndices = [] }) {
  if (!mapInstance || !layerGroup) return;
  layerGroup.clearLayers();

  const boundaries = segmentBoundaryIndices instanceof Set ? segmentBoundaryIndices : new Set(segmentBoundaryIndices);

  if (track && track.length > 1) {
    const latlngs = track.map((p) => [p.lat, p.lng]);
    L.polyline(latlngs, {
      color: TRACK_COLOR,
      weight: 4,
      opacity: 0.85,
      dashArray: dashed ? '8 8' : null,
    }).addTo(layerGroup);
  }

  const byKey = Object.fromEntries(LEGEND.map((item) => [item.key, item.color]));

  points.forEach((p, i) => {
    let color = byKey.anchorStep;
    let radius = 6;
    if (i === 0) color = byKey.anchorStart;
    else if (i === points.length - 1) color = byKey.anchorEnd;
    else if (p.kind === 'added') color = byKey.added;

    if (boundaries.has(i)) {
      color = byKey.boundary;
      radius = 8;
    }

    marker(p, color, radius, `Point ${i + 1}${p.kind === 'added' ? ' (ajouté)' : ''}`).addTo(layerGroup);
  });

  const bounds = L.latLngBounds((track && track.length > 1 ? track : points).map((p) => [p.lat, p.lng]));
  if (bounds.isValid()) {
    // La taille du conteneur a pu changer depuis la dernière conversion (section masquée, rotation…).
    mapInstance.invalidateSize();
    mapInstance.fitBounds(bounds, { padding: [24, 24] });
  }
}

/** Construit dynamiquement la légende (couleurs des marqueurs) dans un élément <ul> donné. */
export function renderLegend(listEl) {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const item of LEGEND) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = item.color;
    li.appendChild(dot);
    li.appendChild(document.createTextNode(` ${item.label}`));
    listEl.appendChild(li);
  }
  const lineLi = document.createElement('li');
  const line = document.createElement('span');
  line.className = 'legend-line';
  lineLi.appendChild(line);
  lineLi.appendChild(document.createTextNode(' Tracé cyclable (pointillé = mode simple)'));
  listEl.appendChild(lineLi);
}
