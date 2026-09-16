// Branchement UI : lit le formulaire, orchestre les modules métier purs et
// met à jour le DOM (résultats, statut, carte).
import { parseGeoveloUrl, GeoveloParseError } from './geovelo-parser.js';
import { buildApiUrl, buildPathUrl, splitIntoSegments, computeCapacity, MAX_POINTS_PER_LINK } from './gmaps-links.js';
import { fetchBrouterRoute, RoutingError } from './router.js';
import { selectWaypoints } from './waypoints.js';
import { buildGpx } from './gpx.js';
import { haversineDistance } from './geo.js';
import { initMap, renderRoute, renderLegend } from './map.js';

const els = {
  form: document.getElementById('convertForm'),
  urlInput: document.getElementById('geoveloUrlInput'),
  convertBtn: document.getElementById('convertBtn'),
  numLinksSelect: document.getElementById('numLinksSelect'),
  capacityHint: document.getElementById('capacityHint'),
  profileSelect: document.getElementById('profileSelect'),
  profileHint: document.getElementById('profileHint'),
  status: document.getElementById('statusRegion'),
  results: document.getElementById('resultsSection'),
  resultsTitle: document.getElementById('results-title'),
  summary: document.getElementById('summaryText'),
  segmentsList: document.getElementById('segmentsList'),
  exportGpxBtn: document.getElementById('exportGpxBtn'),
  mapSection: document.getElementById('mapSection'),
  legend: document.getElementById('legend'),
};

let mapReady = false;
let lastExport = null; // { track, points, asRoute }
let activeController = null; // AbortController de la conversion en cours

function setStatus(message, type = 'info') {
  els.status.textContent = message;
  els.status.dataset.type = type;
}

function setButtonBusy(busy) {
  els.convertBtn.disabled = busy;
  els.convertBtn.setAttribute('aria-busy', String(busy));
}

function updateCapacityHint() {
  const numLinks = Number(els.numLinksSelect.value);
  const capacity = computeCapacity(numLinks);
  els.capacityHint.textContent = `≈ ${capacity} points au total envoyés à Google Maps (départ, arrivée et étapes inclus, segments enchaînés).`;
}

const PROFILE_HINTS = {
  safety: 'Privilégie pistes et bandes cyclables et rues calmes, quitte à faire un détour. Recommandé.',
  trekking:
    'Compromis plus direct : aménagements cyclables et petites routes, tolère davantage les axes et les chemins non revêtus.',
};

function updateProfileHint() {
  els.profileHint.textContent = PROFILE_HINTS[els.profileSelect.value] || '';
}

function prefillFromQueryString() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  if (url) els.urlInput.value = url;
}

function fallbackCopy(text) {
  const input = document.createElement('input');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(input);
  }
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // repli ci-dessous
    }
  }
  fallbackCopy(text);
}

function flashCopied(button) {
  const original = button.dataset.originalLabel || button.textContent;
  button.dataset.originalLabel = original;
  button.textContent = 'Copié !';
  button.classList.add('copied');
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove('copied');
  }, 1500);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function buildSegmentCard(segment, index, total) {
  const apiUrl = buildApiUrl(segment);
  const pathUrl = buildPathUrl(segment);
  const n = index + 1;

  const openBtn = el('a', {
    href: apiUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    class: 'btn btn-primary',
    text: 'Ouvrir dans Google Maps',
    'aria-label': `Ouvrir le segment ${n} dans Google Maps`,
  });

  const copyApiBtn = el('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: 'Copier le lien',
    'aria-label': `Copier le lien du segment ${n}`,
  });
  copyApiBtn.addEventListener('click', async () => {
    await copyToClipboard(apiUrl);
    flashCopied(copyApiBtn);
  });

  const pathLink = el('a', {
    href: pathUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    class: 'link-secondary',
    text: 'Lien « format chemin »',
    'aria-label': `Lien « format chemin » du segment ${n}`,
  });

  const copyPathBtn = el('button', {
    type: 'button',
    class: 'btn btn-link',
    text: 'Copier',
    'aria-label': `Copier le lien « format chemin » du segment ${n}`,
  });
  copyPathBtn.addEventListener('click', async () => {
    await copyToClipboard(pathUrl);
    flashCopied(copyPathBtn);
  });

  const card = el('li', { class: 'segment-card' }, [
    el('h3', { text: `Segment ${n}/${total}` }),
    el('p', { class: 'segment-count', text: `${segment.length} points` }),
    el('div', { class: 'segment-actions' }, [openBtn, copyApiBtn]),
    el('div', { class: 'segment-actions segment-actions-secondary' }, [pathLink, copyPathBtn]),
  ]);

  if (index < total - 1) {
    card.appendChild(
      el('p', {
        class: 'segment-note',
        text: `Ouvrez le segment ${n + 1} une fois arrivé au dernier point de ce segment.`,
      })
    );
  }

  return card;
}

/** @returns {boolean} true si la carte a pu être affichée (Leaflet chargé). */
function renderResults({ points, segments, lengthM, track, dashed, asRoute }) {
  const km = (lengthM / 1000).toFixed(1);
  els.summary.textContent =
    `${km} km · ${points.length} point${points.length > 1 ? 's' : ''} envoyé${points.length > 1 ? 's' : ''} à Google Maps ` +
    `réparti${segments.length > 1 ? 's' : ''} sur ${segments.length} segment${segments.length > 1 ? 's' : ''}.`;

  els.segmentsList.innerHTML = '';
  segments.forEach((segment, i) => {
    els.segmentsList.appendChild(buildSegmentCard(segment, i, segments.length));
  });

  els.results.hidden = false;
  lastExport = { track, points, asRoute };

  // La carte est optionnelle : si Leaflet (CDN) n'a pas pu être chargé, on
  // affiche quand même les liens et on prévient plutôt que de planter.
  const mapAvailable = typeof window.L !== 'undefined';
  if (!mapAvailable) {
    els.mapSection.hidden = true;
    return false;
  }

  // Afficher la section AVANT d'initialiser/cadrer la carte : Leaflet mesure
  // son conteneur, qui fait 0 px tant qu'il est masqué.
  els.mapSection.hidden = false;
  if (!mapReady) {
    initMap('map');
    renderLegend(els.legend);
    mapReady = true;
  }
  const segmentBoundaryIndices = segments.slice(0, -1).map((seg) => points.indexOf(seg[seg.length - 1]));
  renderRoute({ track, points, dashed, segmentBoundaryIndices });
  return true;
}

function sequentialLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineDistance(points[i - 1], points[i]);
  return total;
}

function fallbackMessageFor(code) {
  if (code === 'TIMEOUT') {
    return "Le service de routage BRouter n'a pas répondu à temps — liens générés en mode simple (niveau 1). ";
  }
  if (code === 'HTTP') {
    return 'BRouter a rejeté la requête (itinéraire hors zone couverte, ou erreur serveur) — liens générés en mode simple (niveau 1). ';
  }
  return 'Service de routage indisponible — liens générés en mode simple (niveau 1). ';
}

async function handleConvert(event) {
  event.preventDefault();

  // Une nouvelle conversion annule toute conversion précédente encore en cours.
  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;

  els.results.hidden = true;
  els.mapSection.hidden = true;
  els.urlInput.setAttribute('aria-invalid', 'false');
  setButtonBusy(true);

  try {
    let parsed;
    try {
      parsed = parseGeoveloUrl(els.urlInput.value);
    } catch (err) {
      els.urlInput.setAttribute('aria-invalid', 'true');
      if (err instanceof GeoveloParseError) {
        setStatus(err.message, 'error');
      } else {
        setStatus(`Erreur inattendue lors de l'analyse de l'URL : ${err.message}`, 'error');
      }
      els.urlInput.focus();
      return;
    }

    const anchors = [parsed.from, ...parsed.steps, parsed.to];

    let numLinks = Number(els.numLinksSelect.value);
    let capacity = computeCapacity(numLinks);
    let forcedNoticePrefix = '';
    if (anchors.length > capacity) {
      const minLinks = Math.ceil((anchors.length - 1) / (MAX_POINTS_PER_LINK - 1));
      if (minLinks > 6) {
        setStatus(
          `Cet itinéraire compte ${anchors.length} points (départ, étapes, arrivée), soit plus que le maximum ` +
            `géré (${computeCapacity(6)} points avec 6 liens). Réduisez le nombre d'étapes côté Geovelo.`,
          'error'
        );
        return;
      }
      numLinks = minLinks;
      els.numLinksSelect.value = String(numLinks);
      capacity = computeCapacity(numLinks);
      forcedNoticePrefix = `Nombre de liens ajusté automatiquement à ${numLinks} pour contenir les ${anchors.length} points de l'itinéraire. `;
    }
    updateCapacityHint();

    const extraBudget = Math.max(0, capacity - anchors.length);
    const profile = els.profileSelect.value;

    setStatus(`${forcedNoticePrefix}Calcul de l'itinéraire en cours…`, 'loading');

    // BRouter (niveau 2, tracé cyclable) est toujours tenté en premier ; en
    // cas d'échec, repli automatique et transparent sur le niveau 1 (liens
    // directs entre les points Geovelo).
    let route = null;
    let levelUsed = 2;
    let fallbackNotice = '';

    try {
      route = await fetchBrouterRoute(anchors, { profile, signal: controller.signal });
    } catch (err) {
      if (err instanceof RoutingError && err.code === 'ABORTED') return; // conversion supplantée par une plus récente
      // Toute autre erreur (réseau, réponse inattendue…) : repli sur le niveau 1.
      levelUsed = 1;
      fallbackNotice = fallbackMessageFor(err instanceof RoutingError ? err.code : 'BROUTER_ERROR');
    }

    // Filet de sécurité générique pour la suite (sélection des points,
    // découpage en segments, rendu des résultats et de la carte) : toute
    // erreur inattendue à ce stade est affichée proprement plutôt que de
    // planter silencieusement, et les résultats ne sont montrés qu'en cas
    // de succès complet.
    try {
      let points;
      let track;
      let lengthM;

      if (levelUsed === 2 && route) {
        points = selectWaypoints({ route, anchors, extraBudget });
        track = route.coords;
        lengthM = route.lengthM;
      } else {
        points = anchors.map((a) => ({ lat: a.lat, lng: a.lng, kind: 'anchor' }));
        track = points;
        lengthM = sequentialLengthM(points);
      }

      const segments = splitIntoSegments(points, MAX_POINTS_PER_LINK);

      const mapAvailable = renderResults({
        points,
        segments,
        lengthM,
        track,
        dashed: levelUsed === 1,
        asRoute: levelUsed === 1,
      });

      const mapNotice = mapAvailable ? '' : ' Carte indisponible (bibliothèque cartographique non chargée) : les liens restent utilisables.';
      setStatus(
        `${forcedNoticePrefix}${fallbackNotice}Itinéraire converti avec succès.${mapNotice}`,
        fallbackNotice ? 'warning' : 'success'
      );
      els.resultsTitle.focus();
    } catch (err) {
      els.results.hidden = true;
      els.mapSection.hidden = true;
      lastExport = null;
      setStatus(`Erreur inattendue lors de la génération des résultats : ${err.message}`, 'error');
    }
  } finally {
    if (activeController === controller) setButtonBusy(false);
  }
}

function handleExportGpx() {
  if (!lastExport) return;
  const xml = buildGpx(lastExport.track, lastExport.points, { asRoute: lastExport.asRoute });
  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'itineraire-geovelo.gpx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Repli différé : certains navigateurs (Safari) annulent le téléchargement
  // si l'URL blob est révoquée immédiatement.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function init() {
  prefillFromQueryString();
  updateCapacityHint();
  updateProfileHint();
  els.numLinksSelect.addEventListener('change', updateCapacityHint);
  els.profileSelect.addEventListener('change', updateProfileHint);
  els.form.addEventListener('submit', handleConvert);
  els.exportGpxBtn.addEventListener('click', handleExportGpx);
}

init();
