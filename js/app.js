// Branchement UI : lit le formulaire, orchestre les modules métier purs et
// met à jour le DOM (résultats, statut, carte).
import { parseGeoveloUrl, GeoveloParseError } from './geovelo-parser.js';
import { parseKomootUrl, KomootParseError } from './komoot-parser.js';
import { buildApiUrl, buildPathUrl, splitIntoSegments, computeCapacity, MAX_POINTS_PER_LINK } from './gmaps-links.js';
import { fetchBrouterRoute, RoutingError } from './router.js';
import { fetchKomootTour, modeForSport, limitAnchors } from './komoot.js';
import { selectWaypoints } from './waypoints.js';
import { buildGpx } from './gpx.js';
import { haversineDistance } from './geo.js';
import { initMap, renderRoute, renderLegend } from './map.js';

const els = {
  form: document.getElementById('convertForm'),
  urlInput: document.getElementById('routeUrlInput'),
  convertBtn: document.getElementById('convertBtn'),
  numLinksSelect: document.getElementById('numLinksSelect'),
  capacityHint: document.getElementById('capacityHint'),
  profileSelect: document.getElementById('profileSelect'),
  profileHint: document.getElementById('profileHint'),
  modeSelect: document.getElementById('modeSelect'),
  status: document.getElementById('statusRegion'),
  results: document.getElementById('resultsSection'),
  resultsTitle: document.getElementById('results-title'),
  tourName: document.getElementById('tourNameText'),
  summary: document.getElementById('summaryText'),
  segmentsList: document.getElementById('segmentsList'),
  exportGpxBtn: document.getElementById('exportGpxBtn'),
  mapSection: document.getElementById('mapSection'),
  legend: document.getElementById('legend'),
};

let mapReady = false;
let lastExport = null; // { track, points, asRoute }
let activeController = null; // AbortController de la conversion en cours
let modeTouchedByUser = false; // true dès que l'utilisateur modifie le sélecteur Mode lui-même
let lastRouteKey = null; // identité de la dernière URL analysée (source + tourId/texte), pour réinitialiser modeTouchedByUser

// Erreur locale : URL syntaxiquement valide mais dont l'hôte ne correspond ni
// à Geovelo ni à Komoot.
class RouteSourceError extends Error {}

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

const PROFILE_KOMOOT_HINT =
  "Ne s'applique pas à un itinéraire Komoot : le tracé est fourni directement par l'API Komoot (pas de second appel de routage).";

function updateProfileHint() {
  els.profileHint.textContent = els.profileSelect.disabled ? PROFILE_KOMOOT_HINT : PROFILE_HINTS[els.profileSelect.value] || '';
}

/**
 * Analyse l'URL saisie et détermine la source. Geovelo est essayé en premier :
 * toute erreur Geovelo autre que `NOT_GEOVELO` (host reconnu, ou saisie
 * générique invalide) est définitive. Seul un hôte non-Geovelo déclenche
 * l'essai Komoot ; si celui-ci échoue aussi avec `NOT_KOMOOT`, l'entrée ne
 * correspond à aucune des deux sources connues.
 */
function parseRouteUrl(rawInput) {
  let geoveloErr;
  try {
    return { source: 'geovelo', geovelo: parseGeoveloUrl(rawInput) };
  } catch (err) {
    if (!(err instanceof GeoveloParseError)) throw err;
    geoveloErr = err;
  }

  if (geoveloErr.code !== 'NOT_GEOVELO') {
    if (geoveloErr.code === 'EMPTY') {
      throw new GeoveloParseError('EMPTY', 'Veuillez saisir une URL Geovelo ou Komoot.');
    }
    throw geoveloErr; // INVALID_URL (générique), SHORT_LINK, INVALID_COORDS : hôte Geovelo reconnu ou saisie générique.
  }

  try {
    return { source: 'komoot', komoot: parseKomootUrl(rawInput) };
  } catch (err) {
    if (!(err instanceof KomootParseError)) throw err;
    if (err.code === 'NOT_KOMOOT') {
      throw new RouteSourceError("Cette URL ne provient ni de Geovelo ni de Komoot.");
    }
    throw err;
  }
}

/**
 * Variante de `parseRouteUrl` qui ne lève jamais : retourne le résultat complet
 * ou `null`. Sert de base commune au retour visuel en temps réel
 * (`updateSourceUI`) pour ne pas dupliquer/diverger de la règle de priorité
 * Geovelo-puis-Komoot déjà encodée dans `parseRouteUrl`.
 */
function tryParseRouteUrl(rawInput) {
  try {
    return parseRouteUrl(rawInput);
  } catch {
    return null;
  }
}

/**
 * Détecte la source (Geovelo/Komoot) d'une saisie, sans lever d'erreur : sert
 * uniquement au retour visuel en temps réel (profil de routage masqué/désactivé
 * pour Komoot). `null` si la saisie est vide, invalide, ou ne correspond à
 * aucune des deux sources.
 */
function detectSource(rawInput) {
  const result = tryParseRouteUrl(rawInput);
  return result ? result.source : null;
}

/**
 * Le profil de routage Geovelo (BRouter) ne s'applique pas à Komoot (le tracé
 * vient directement de l'API Komoot, pas d'un second appel de routage) : le
 * sélecteur est désactivé dès que l'URL saisie est reconnue comme un lien
 * Komoot. Mis à jour en temps réel (saisie) et avant chaque conversion.
 *
 * Réinitialise aussi `modeTouchedByUser` dès que la source change, ou que
 * l'identifiant de tour Komoot change (nouvelle URL Komoot) : le choix de
 * mode d'un précédent itinéraire ne doit pas s'appliquer silencieusement à un
 * itinéraire complètement différent.
 */
function updateSourceUI() {
  const rawInput = els.urlInput.value;
  const source = detectSource(rawInput);

  els.profileSelect.disabled = source === 'komoot';
  updateProfileHint();

  const result = tryParseRouteUrl(rawInput);
  const routeKey = !result ? null : source === 'komoot' ? `komoot:${result.komoot.tourId}` : `geovelo:${rawInput.trim()}`;
  if (routeKey !== lastRouteKey) {
    modeTouchedByUser = false;
    lastRouteKey = routeKey;
  }
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

function buildSegmentCard(segment, index, total, mode) {
  const apiUrl = buildApiUrl(segment, mode);
  const pathUrl = buildPathUrl(segment, mode);
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
function renderResults({ points, segments, lengthM, track, dashed, asRoute, mode, tourName }) {
  if (tourName) {
    els.tourName.textContent = tourName;
    els.tourName.hidden = false;
  } else {
    els.tourName.hidden = true;
  }

  const km = (lengthM / 1000).toFixed(1);
  els.summary.textContent =
    `${km} km · ${points.length} point${points.length > 1 ? 's' : ''} envoyé${points.length > 1 ? 's' : ''} à Google Maps ` +
    `réparti${segments.length > 1 ? 's' : ''} sur ${segments.length} segment${segments.length > 1 ? 's' : ''}.`;

  els.segmentsList.innerHTML = '';
  segments.forEach((segment, i) => {
    els.segmentsList.appendChild(buildSegmentCard(segment, i, segments.length, mode));
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

/**
 * Calcule la capacité (nombre de liens/points) nécessaire pour un nombre
 * d'ancres donné, en ajustant automatiquement `numLinksSelect` si besoin.
 * @returns {{error:string}|{extraBudget:number, forcedNoticePrefix:string}}
 */
function computeCapacityAndBudget(anchorsCount) {
  let numLinks = Number(els.numLinksSelect.value);
  let capacity = computeCapacity(numLinks);
  let forcedNoticePrefix = '';
  if (anchorsCount > capacity) {
    const minLinks = Math.ceil((anchorsCount - 1) / (MAX_POINTS_PER_LINK - 1));
    if (minLinks > 6) {
      return {
        error:
          `Cet itinéraire compte ${anchorsCount} points (départ, étapes, arrivée), soit plus que le maximum ` +
          `géré (${computeCapacity(6)} points avec 6 liens). Réduisez le nombre d'étapes.`,
      };
    }
    numLinks = minLinks;
    els.numLinksSelect.value = String(numLinks);
    capacity = computeCapacity(numLinks);
    forcedNoticePrefix = `Nombre de liens ajusté automatiquement à ${numLinks} pour contenir les ${anchorsCount} points de l'itinéraire. `;
  }
  updateCapacityHint();
  return { extraBudget: Math.max(0, capacity - anchorsCount), forcedNoticePrefix };
}

/**
 * Sélection des points, découpage en segments, rendu des résultats/carte.
 * Commun à Geovelo (niveau 1 ou 2) et Komoot (toujours niveau 2, pas de repli
 * niveau 1 : sans coordonnées Komoot il n'y a rien à afficher).
 */
function finishConversion({ anchors, route, levelUsed, fallbackNotice, forcedNoticePrefix, mode, tourName, extraBudget }) {
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
      mode,
      tourName,
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
}

/**
 * Conversion d'un itinéraire Geovelo : BRouter (niveau 2, tracé cyclable) est
 * toujours tenté en premier ; en cas d'échec, repli automatique et
 * transparent sur le niveau 1 (liens directs entre les points Geovelo).
 * Le mode par défaut est "vélo" (cohérent avec Geovelo, un site cyclable),
 * mais reste modifiable via le sélecteur Mode : il ne module que le
 * `travelmode`/suffixe envoyés à Google Maps, jamais le moteur de routage
 * utilisé pour choisir le tracé (BRouter reste interrogé en mode vélo).
 */
async function convertGeovelo(parsed, controller) {
  const anchors = [parsed.from, ...parsed.steps, parsed.to];
  const capacityResult = computeCapacityAndBudget(anchors.length);
  if (capacityResult.error) {
    setStatus(capacityResult.error, 'error');
    return;
  }
  const { extraBudget, forcedNoticePrefix } = capacityResult;
  const profile = els.profileSelect.value;

  if (!modeTouchedByUser) els.modeSelect.value = 'bicycling';
  const mode = els.modeSelect.value;

  setStatus(`${forcedNoticePrefix}Calcul de l'itinéraire en cours…`, 'loading');

  let route = null;
  let levelUsed = 2;
  let fallbackNotice = '';
  try {
    route = await fetchBrouterRoute(anchors, { profile, signal: controller.signal });
  } catch (err) {
    if (err instanceof RoutingError && err.code === 'ABORTED') return; // conversion supplantée par une plus récente
    levelUsed = 1;
    fallbackNotice = fallbackMessageFor(err instanceof RoutingError ? err.code : 'BROUTER_ERROR');
  }

  finishConversion({ anchors, route, levelUsed, fallbackNotice, forcedNoticePrefix, mode, tourName: null, extraBudget });
}

/**
 * Conversion d'un itinéraire Komoot : l'API Komoot fournit directement la
 * géométrie et les étapes (pas d'appel BRouter). Pas de repli niveau 1
 * silencieux : sans coordonnées Komoot, il n'y a rien à afficher, donc tout
 * échec de l'API est signalé clairement (avec des messages dédiés pour
 * 403/404, voir komoot.js).
 */
async function convertKomoot(parsed, controller) {
  setStatus('Récupération du tour Komoot en cours…', 'loading');

  let route;
  try {
    route = await fetchKomootTour(parsed.tourId, parsed.shareToken, { signal: controller.signal });
  } catch (err) {
    if (err instanceof RoutingError && err.code === 'ABORTED') return; // conversion supplantée par une plus récente
    const message =
      err instanceof RoutingError
        ? err.message
        : `Erreur inattendue lors de la récupération du tour Komoot : ${err.message}`;
    setStatus(message, 'error');
    return;
  }

  // Contrairement à Geovelo (où l'utilisateur choisit lui-même ses étapes),
  // un tour Komoot peut compter bien plus d'étapes que ce que l'app peut
  // gérer, sans que l'utilisateur maîtrise ce nombre (ce n'est pas forcément
  // son propre tour) : on dégrade (sous-échantillonnage réparti, départ et
  // arrivée toujours conservés) plutôt que d'échouer sèchement.
  const MAX_KOMOOT_ANCHORS = computeCapacity(6);
  let anchors = route.anchors;
  let subsampleNotice = '';
  if (anchors.length > MAX_KOMOOT_ANCHORS) {
    subsampleNotice =
      `Ce tour Komoot compte ${anchors.length} étapes, plus que le maximum géré (${MAX_KOMOOT_ANCHORS}) : ` +
      `${MAX_KOMOOT_ANCHORS} étapes réparties sur le parcours (dont le départ et l'arrivée) ont été conservées. `;
    anchors = limitAnchors(anchors, MAX_KOMOOT_ANCHORS);
  }

  const capacityResult = computeCapacityAndBudget(anchors.length);
  if (capacityResult.error) {
    setStatus(capacityResult.error, 'error');
    return;
  }
  const { extraBudget, forcedNoticePrefix } = capacityResult;

  const detectedMode = modeForSport(route.sport);
  if (!modeTouchedByUser) els.modeSelect.value = detectedMode;
  const mode = els.modeSelect.value;

  finishConversion({
    anchors,
    route,
    levelUsed: 2,
    fallbackNotice: '',
    forcedNoticePrefix: subsampleNotice + forcedNoticePrefix,
    mode,
    tourName: route.name || null,
    extraBudget,
  });
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
    let source;
    let geoveloParsed;
    let komootParsed;
    try {
      const result = parseRouteUrl(els.urlInput.value);
      source = result.source;
      geoveloParsed = result.geovelo;
      komootParsed = result.komoot;
    } catch (err) {
      els.urlInput.setAttribute('aria-invalid', 'true');
      if (err instanceof GeoveloParseError || err instanceof KomootParseError || err instanceof RouteSourceError) {
        setStatus(err.message, 'error');
      } else {
        setStatus(`Erreur inattendue lors de l'analyse de l'URL : ${err.message}`, 'error');
      }
      els.urlInput.focus();
      return;
    }

    updateSourceUI();

    if (source === 'geovelo') {
      await convertGeovelo(geoveloParsed, controller);
    } else {
      await convertKomoot(komootParsed, controller);
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
  a.download = 'itineraire.gpx';
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
  updateSourceUI();
  els.numLinksSelect.addEventListener('change', updateCapacityHint);
  els.profileSelect.addEventListener('change', updateProfileHint);
  els.modeSelect.addEventListener('change', () => {
    modeTouchedByUser = true;
  });
  els.urlInput.addEventListener('input', updateSourceUI);
  els.form.addEventListener('submit', handleConvert);
  els.exportGpxBtn.addEventListener('click', handleExportGpx);
}

init();
