// Erreur typée partagée par les modules de récupération d'itinéraire
// (router.js pour BRouter, komoot.js pour l'API Komoot), pour éviter que
// komoot.js dépende de router.js (deux services indépendants).
export class RoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
  }
}
