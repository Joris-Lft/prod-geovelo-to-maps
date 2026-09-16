// Analyse une URL d'itinéraire Geovelo et en extrait départ / étapes / arrivée.
// Module pur : aucune dépendance au DOM, entièrement testable sous Node.

export class GeoveloParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GeoveloParseError';
    this.code = code;
  }
}

// Nombre décimal strict : rejette les chaînes vides, l'hexadécimal (0x1) et
// la notation scientifique (1e1), que `Number()` accepterait à tort.
const STRICT_DECIMAL_RE = /^-?\d+(\.\d+)?$/;

// Domaines Geovelo exacts (et sous-domaines), pas une simple recherche de
// sous-chaîne (qui laisserait passer un hôte du type geovelo.app.evil.com).
const GEOVELO_HOSTNAME_RE = /(^|\.)geovelo\.(app|fr)$/i;

function parseCoordNumber(str, label) {
  if (!STRICT_DECIMAL_RE.test(str)) {
    throw new GeoveloParseError('INVALID_COORDS', `Coordonnées invalides pour ${label} : « ${str} ».`);
  }
  return Number(str);
}

function parseLonLat(raw, label) {
  const parts = raw.split(',');
  if (parts.length !== 2) {
    throw new GeoveloParseError(
      'INVALID_COORDS',
      `Coordonnées invalides pour ${label} : « ${raw} ».`
    );
  }
  const [lonStr, latStr] = parts;
  const lng = parseCoordNumber(lonStr, label);
  const lat = parseCoordNumber(latStr, label);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new GeoveloParseError(
      'INVALID_COORDS',
      `Coordonnées hors limites pour ${label} : latitude ${lat}, longitude ${lng}.`
    );
  }
  return { lat, lng };
}

/**
 * @param {string} input URL Geovelo (ex: https://geovelo.app/fr/route/?from=...&to=...&steps=...)
 * @returns {{from:{lat:number,lng:number}, steps:Array<{lat:number,lng:number}>, to:{lat:number,lng:number}}}
 */
export function parseGeoveloUrl(input) {
  let trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) {
    throw new GeoveloParseError('EMPTY', 'Veuillez saisir une URL Geovelo.');
  }

  // Entrée déjà percent-encodée (ex. copiée depuis une barre d'adresse ou un
  // partage) : on la décode avant de continuer.
  if (/^https%3a/i.test(trimmed)) {
    try {
      trimmed = decodeURIComponent(trimmed);
    } catch {
      // Décodage impossible : on retente l'analyse avec le texte original.
    }
  }

  // Texte manifestement pas une URL (ni schéma, ni nom de domaine).
  if (!/:\/\//.test(trimmed) && !trimmed.includes('.')) {
    throw new GeoveloParseError('INVALID_URL', "Le texte saisi n'est pas une URL valide.");
  }

  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new GeoveloParseError('INVALID_URL', "Le texte saisi n'est pas une URL valide.");
  }

  if (!GEOVELO_HOSTNAME_RE.test(url.hostname)) {
    throw new GeoveloParseError('NOT_GEOVELO', "Cette URL ne provient pas de Geovelo.");
  }

  const params = url.searchParams;
  const fromRaw = params.get('from');
  const toRaw = params.get('to');

  if (!fromRaw || !toRaw) {
    throw new GeoveloParseError(
      'SHORT_LINK',
      "Ce lien Geovelo ne contient pas l'itinéraire complet (probablement un lien court ou de partage). " +
        'Ouvrez-le dans votre navigateur, puis collez ici l’URL complète de la page itinéraire ' +
        '(un navigateur ne peut pas suivre cette redirection automatiquement à cause du CORS).'
    );
  }

  const from = parseLonLat(fromRaw, 'from');
  const to = parseLonLat(toRaw, 'to');

  const stepsRaw = params.get('steps');
  const steps = stepsRaw
    ? stepsRaw
        .split(';')
        .filter((s) => s.length > 0)
        .map((s, i) => parseLonLat(s, `steps[${i}]`))
    : [];

  return { from, steps, to };
}
