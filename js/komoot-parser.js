// Analyse une URL d'itinéraire Komoot et en extrait l'identifiant de tour et
// le jeton de partage éventuel. Module pur : aucune dépendance au DOM,
// entièrement testable sous Node. Mêmes conventions d'erreurs que
// geovelo-parser.js (classe dédiée avec un `code` exploitable par l'UI).

export class KomootParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KomootParseError';
    this.code = code;
  }
}

// Domaines Komoot exacts (et sous-domaines), pas une simple recherche de
// sous-chaîne (qui laisserait passer un hôte du type komoot.com.evil.com).
const KOMOOT_HOSTNAME_RE = /(^|\.)komoot\.(com|de)$/i;

// Un tour Komoot est référencé par un id numérique dans le chemin, sous
// /tour/<id> ou /invite-tour/<id> (lien de partage), quel que soit le préfixe
// de langue éventuel (ex. /en-us/tour/123456789).
const TOUR_ID_RE = /\/(?:invite-)?tour\/(\d+)/;

/**
 * @param {string} input URL Komoot (ex: https://www.komoot.com/tour/<id> ou
 *   https://www.komoot.com/invite-tour/<id>?share_token=...)
 * @returns {{tourId:string, shareToken:string|null}}
 */
export function parseKomootUrl(input) {
  let trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) {
    throw new KomootParseError('EMPTY', 'Veuillez saisir une URL Komoot.');
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
    throw new KomootParseError('INVALID_URL', "Le texte saisi n'est pas une URL valide.");
  }

  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new KomootParseError('INVALID_URL', "Le texte saisi n'est pas une URL valide.");
  }

  if (!KOMOOT_HOSTNAME_RE.test(url.hostname)) {
    throw new KomootParseError('NOT_KOMOOT', "Cette URL ne provient pas de Komoot.");
  }

  const match = url.pathname.match(TOUR_ID_RE);
  if (!match) {
    throw new KomootParseError(
      'MISSING_TOUR_ID',
      "Ce lien Komoot ne contient pas d'identifiant de tour exploitable (attendu : /tour/<id> ou /invite-tour/<id>)."
    );
  }

  const tourId = match[1];
  const shareToken = url.searchParams.get('share_token') || null;

  return { tourId, shareToken };
}
