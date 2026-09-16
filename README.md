# Geovelo → Google Maps vélo

Site statique (HTML/CSS/JS vanilla, modules ES, aucun build) qui convertit une URL d'itinéraire
Geovelo en un ou plusieurs liens Google Maps en mode vélo, en essayant de coller au maximum aux
voies cyclables réelles.

## Fonctionnement

### 1. Parseur d'URL Geovelo (`js/geovelo-parser.js`)

Une URL Geovelo contient les paramètres `from`, `to` et (optionnel) `steps`, au format
**`longitude,latitude`** — c'est l'inverse de l'ordre `{lat, lng}` utilisé partout ailleurs dans
l'app. Le parseur convertit donc systématiquement `lon,lat` → `{lat, lng}`. Les paramètres `c`
(centre carte), `z` (zoom), `zone`, `bike-type` et `e-bike` sont ignorés.

Erreurs typées (`GeoveloParseError`, avec un `code` exploitable par l'UI) :

| code | cas |
|---|---|
| `EMPTY` | champ vide |
| `INVALID_URL` | texte qui n'est pas une URL (ni `://`, ni point dans le texte) |
| `NOT_GEOVELO` | hôte différent de `geovelo.app`/`geovelo.fr` (ou un sous-domaine) — comparaison exacte, pas une simple recherche de sous-chaîne |
| `SHORT_LINK` | hôte Geovelo mais `from`/`to` absents (lien court/partage) |
| `INVALID_COORDS` | composante non conforme à `/^-?\d+(\.\d+)?$/` (rejette la chaîne vide, l'hexadécimal `0x1` et la notation scientifique `1e1`, que `Number()` accepterait à tort) ou hors limites (`lat` ∉ [-90,90], `lng` ∉ [-180,180]) |

Cas particuliers gérés : une entrée déjà percent-encodée (commençant par `https%3A`) est décodée
avant analyse.

**Lien court non résolvable côté client** : un lien de partage Geovelo (`/s/...`) redirige vers
la page itinéraire complète, mais un navigateur ne peut pas suivre cette redirection depuis du
JavaScript côté client à cause de la politique CORS (le serveur Geovelo ne renvoie pas les en-têtes
nécessaires pour une requête cross-origin en `fetch`). L'app affiche donc un message invitant à
ouvrir le lien dans un onglet puis à copier l'URL complète de la barre d'adresse.

**Pourquoi pas l'API Geovelo ?** Geovelo expose une API de calcul d'itinéraire, mais elle est
privée et nécessite une clé (pas d'endpoint public documenté pour un usage anonyme côté client).
On se limite donc à parser l'URL publique générée par leur interface web.

### 2. Niveau 1 — liens Google Maps simples (`js/gmaps-links.js`)

Construit deux formats de lien, en mode vélo :

- **Format API** : `https://www.google.com/maps/dir/?api=1&origin=lat,lng&destination=lat,lng&waypoints=lat,lng|lat,lng&travelmode=bicycling`
  (format documenté officiellement).
- **Format « chemin »** : `https://www.google.com/maps/dir/lat,lng/lat,lng/.../data=!4m2!4m1!3e1`.
  Le suffixe `data=!4m2!4m1!3e1` force le mode vélo dans ce format ; **il n'est pas documenté
  officiellement par Google** mais a été vérifié empiriquement (repris par de nombreux projets
  communautaires). À utiliser avec cette réserve.

Les coordonnées sont arrondies à 6 décimales (précision centimétrique, largement suffisante et
plus lisible).

**Limites Google Maps (sources et arbitrage) :**

- La documentation officielle des [Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)
  indique : *« up to three waypoints supported on mobile browsers, and a maximum of nine
  waypoints supported otherwise »* (donc jusqu'à 9 waypoints + origine + destination = 11 points
  sur navigateur non mobile), une longueur d'URL ≤ 2048 caractères, et `travelmode=bicycling`
  pour le mode vélo.
- En pratique, **l'interface web et l'application Google Maps plafonnent à 10 points au total**
  (origine + destination + waypoints intermédiaires), ce qui est plus restrictif que les 9
  waypoints de la doc (soit 11 points théoriques). Il y a donc un écart entre la doc (9
  waypoints, 11 points) et le comportement observé de l'UI (10 points) — on retient la limite la
  plus basse et vérifiée : **`MAX_POINTS_PER_LINK = 10`** (8 waypoints), exportée depuis
  `js/gmaps-links.js`.
- Usage cible : ouvrir le lien sur **ordinateur**, puis utiliser « Envoyer vers votre téléphone »
  pour naviguer en mobilité — d'où le choix d'optimiser pour la limite desktop plutôt que la
  limite mobile (3 waypoints). L'UI rappelle cette hypothèse juste au-dessus des liens de
  résultat, avec un avertissement sur la limite mobile.
- En format API (`api=1`), chaque waypoint intermédiaire est un **arrêt explicitement annoncé**
  dans la navigation Google Maps (l'itinéraire s'y arrête, pas un simple point de passage
  silencieux) : c'est une contrainte de ce format, à garder en tête si le nombre de points choisi
  est élevé.

`splitIntoSegments(points, maxPerLink = 10)` découpe une liste de points en plusieurs segments
si nécessaire ; chaque segment **reprend en premier point le dernier point du segment
précédent**, pour permettre d'enchaîner les trajets sans perdre le fil. Exemples : 9 ou 10 points
→ 1 segment ; 11 points → 2 segments (`[0..9]`, `[9..10]`) ; 20 points → 3 segments.

### 3. Niveau 2 — tracé cyclable via BRouter (`js/router.js`)

[BRouter](https://brouter.de/) est un moteur de routage vélo/rando communautaire et gratuit,
utilisable directement depuis le navigateur (CORS ouvert : `Access-Control-Allow-Origin: *`,
aucune clé requise). L'app envoie **tous les points Geovelo (départ, étapes, arrivée) en une
seule requête** :

```
GET https://brouter.de/brouter?lonlats=lon,lat|lon,lat|...&profile=safety&alternativeidx=0&format=geojson
```

Profil par défaut `safety` (priorité aux itinéraires sûrs), avec un choix `trekking` (randonnée)
dans l'UI. La requête est bornée par un timeout de ~20 s via `AbortController` ; ce timeout couvre
**toute** la requête, y compris la lecture du corps de la réponse (pas seulement l'obtention des
en-têtes HTTP). Un abandon déclenché par l'app elle-même (nouvelle conversion lancée avant que la
précédente n'ait abouti, voir plus bas) est distingué d'un vrai dépassement de délai via un code
`ABORTED` (vs `TIMEOUT`) : dans ce cas l'app ne montre aucun message de repli, la conversion en
cours est simplement remplacée par la nouvelle.

**Traitement de la réponse** (`parseBrouterResponse`) : BRouter renvoie une `FeatureCollection`
GeoJSON. `features[0].geometry.coordinates` est la géométrie complète (`[lon, lat, ele]` par
sommet). `features[0].properties["track-length"]` donne la longueur totale. Le tableau
`properties.messages` contient, sur sa première ligne, l'en-tête des colonnes
(`Longitude, Latitude, Elevation, Distance, ..., WayTags, NodeTags, ...`), puis une ligne par
**tronçon** (portion de voie aux tags constants). `Longitude`/`Latitude` sont des entiers ×1e6
(en chaîne) correspondant au **point de fin** du tronçon ; on les associe à l'index de géométrie
correspondant en avançant séquentiellement, dans une fenêtre bornée à ~300 m (repli sur le point
le plus proche *dans cette fenêtre* si aucune correspondance exacte n'est trouvée — cette borne
évite à la fois les sauts aberrants sur un tracé qui repasse près de lui-même et un coût
quadratique sur les longs itinéraires). `WayTags` contient les tags de la voie (ex.
`highway=cycleway`, `highway=secondary surface=asphalt cycleway:both=lane`), `NodeTags` ceux du
nœud de fin (ex. `highway=traffic_signals`). BRouter ne décrit pas toujours la toute fin du tracé
dans `messages` : une section finale sans tags est ajoutée pour couvrir ce reliquat (comptée dans
la longueur totale, jamais choisie comme candidat cyclable faute de tags).

En cas d'échec, une `RoutingError` typée est levée (`NETWORK`, `TIMEOUT`, `HTTP`, `BROUTER_ERROR`,
`ABORTED`) ; l'app affiche un message de repli adapté au code (ex. « n'a pas répondu à temps » pour
un timeout, « a rejeté la requête (itinéraire hors zone couverte, ou erreur serveur) » pour une
erreur HTTP) et poursuit avec le niveau 1 plutôt que de bloquer l'utilisateur — sauf pour
`ABORTED`, silencieux (voir ci-dessus).

Une fixture d'exemple (réponse réelle, tronquée par nature de l'itinéraire testé) est disponible
dans `tests/fixtures/brouter-sample.geojson`, générée avec :

```bash
curl -s "https://brouter.de/brouter?lonlats=1.396755,43.590853|1.385408,43.608432|1.379080,43.603898&profile=safety&alternativeidx=0&format=geojson" \
  > tests/fixtures/brouter-sample.geojson
```

*(La plupart des tests unitaires de `router.js` utilisent une réponse synthétique minimale
construite en mémoire, plus rapide et déterministe ; un test dédié charge aussi cette fixture
réelle pour vérifier que les sections couvrent bien tout le tracé et que la somme de leurs
longueurs colle à `track-length`.)*

### 4. Sélection des points intermédiaires (`js/waypoints.js`) — le cœur du projet

Google Maps recalcule l'itinéraire de façon indépendante entre chaque paire de points consécutifs
qu'on lui donne. Plus la géométrie réelle (issue de BRouter) s'écarte de la ligne droite entre
deux points envoyés, plus Google risque de dévier du tracé cyclable voulu. L'algorithme choisit
donc, sous un budget de points limité, ceux qui réduisent le plus cet écart — une approche proche
de la simplification de Douglas-Peucker, mais gloutonne et sous contrainte de budget :

1. **Ancres** : les points Geovelo (départ, étapes, arrivée) sont toujours inclus.
   - **Départ → index 0, arrivée → dernier index**, **sans recherche**. Sur une boucle (départ ≈
     arrivée, cas fréquent, ex. l'itinéraire Toulouse de l'exemple), une recherche par
     plus-proche-voisin se tromperait facilement d'extrémité (le premier sommet du tracé peut
     être numériquement plus proche du point d'arrivée que le vrai dernier sommet) ; fixer les
     deux bornes par construction élimine ce risque.
   - **Étapes intermédiaires** : projetées par recherche **séquentielle** à partir de l'index de
     l'ancre précédente (`geo.sequentialNearestIndex`) : on retient le **premier passage** du tracé
     à moins de `minimum_global_restant + 10 m` de l'étape, et le sommet le plus proche de ce
     passage. BRouter fait passer le tracé par chaque étape, donc ce minimum est quasi nul : le
     seuil serré évite de retenir une rue voisine longée plus tôt, et le « premier passage » gère
     les allers-retours (le retour peut repasser tout près d'une étape posée sur l'aller). Les index
     des ancres sont croissants.
2. **Candidats** : pour chaque tronçon BRouter valide, un seul candidat — son **point milieu en
   distance** le long de la géométrie (ou, à défaut, décalé à 35 %/65 % de la longueur du
   tronçon). Un tronçon est invalide si : sa longueur < 60 m ; il porte
   `junction=roundabout`/`circular` ; ou son `highway` vaut `steps`, `elevator` ou `platform`. Un
   candidat est ensuite écarté (essai à l'offset suivant, ou abandon du tronçon si aucun offset ne
   convient) s'il tombe à moins de 30 m (**distance réelle à vol d'oiseau**, pas une approximation
   par la longueur du tronçon) d'une extrémité de sa section, ou d'un nœud portant
   `highway=traffic_signals|crossing|stop|give_way|mini_roundabout|turning_circle` (tags relevés
   sur `NodeTags`, aux extrémités de tronçon). Les candidats à moins de 40 m d'une ancre (ou,
   pendant la sélection, d'un point déjà choisi) sont également exclus.
3. **Bonus « voie cyclable »** accordé si le tronçon porte `highway=cycleway` ; `highway=path`
   ou `track` avec `bicycle=designated|yes` ; une clé `cycleway*` valant `track`, `lane` ou
   `separate` ; `bicycle_road=yes` ; `cyclestreet=yes` ; ou `highway=living_street|pedestrian`
   avec `bicycle=yes|designated`.
4. **Sélection gloutonne sous budget** : tant qu'il reste du budget, on mesure, pour chaque
   intervalle entre deux points déjà retenus (ancres + ajoutés), l'écart maximal entre la
   géométrie réelle et la corde droite reliant les deux extrémités de l'intervalle. On prend
   l'intervalle au plus grand écart ; parmi ses candidats dont l'écart à cette même corde est
   **≥ 25 m** (en dessous, le candidat est ignoré : ajouter un point n'apporterait rien), on
   choisit celui qui maximise `écart_à_la_corde × (1 + 0.5 × bonus_cyclable)`. Si cet intervalle
   n'a aucun candidat valide, on essaie l'intervalle suivant. On s'arrête si l'écart maximal
   restant est < 25 m ou s'il n'y a plus de candidat.
5. Le résultat est trié par position sur la géométrie (garanti par construction — ancres à index
   strictement croissants, candidats insérés entre les bonnes bornes — puis un tri explicite en
   filet de sécurité).

### Réglage « précision »

Le sélecteur **« Nombre de liens Google Maps »** (1 à 6, défaut 1) fixe la capacité totale de
points transportables : `capacité = 9 × nbLiens + 1` (en tenant compte de l'enchaînement des
segments). Le budget de points ajoutés est `extraBudget = capacité − nbAncres` (minimum 0). Si le
nombre d'ancres dépasse la capacité, l'app force automatiquement le nombre de liens minimal
nécessaire (jusqu'à 6 maximum) et le signale à l'utilisateur. Cette indication de capacité est
toujours affichée : le niveau 2 (tracé cyclable via BRouter) est désormais tenté systématiquement,
sans case à cocher — seul le **profil de routage** (Sûreté / Randonnée, avec un court texte
d'aide sous le sélecteur) reste réglable ; le repli automatique et silencieux vers le niveau 1
(liens directs entre les points Geovelo) en cas d'échec de BRouter reste inchangé.

## Interface

- Champ URL, bouton **Convertir** (préremplissable via `?url=...` dans l'URL du site). Une note
  rappelle l'hypothèse d'usage : ouvrir sur ordinateur puis « Envoyer vers votre téléphone »
  (limite mobile à 3 étapes).
- Zone de statut `aria-live="polite"` pour le chargement, les erreurs et le repli niveau 2 → 1 ;
  le champ URL reçoit `aria-invalid="true"` en cas d'erreur de saisie, et le titre des résultats
  reçoit le focus après une conversion réussie.
- Chaque conversion **annule la précédente** si elle est encore en cours (un seul
  `AbortController` actif, transmis à `fetchBrouterRoute` via `signal`) ; le bouton Convertir est
  désactivé (`aria-busy="true"`) pendant le calcul.
- Toute la suite du traitement après le routage (sélection des points, découpage en segments,
  rendu des résultats et de la carte) est protégée par un filet de sécurité : en cas d'erreur
  inattendue, un message clair est affiché et **aucun résultat partiel n'est montré**. La carte
  est facultative : si Leaflet n'a pas pu être chargé depuis le CDN, les liens restent affichés et
  un message le signale, sans faire planter la conversion.
- Résultats : distance totale, nombre de points, et pour chaque segment un bouton **Ouvrir dans
  Google Maps** (format API, avec un `aria-label` explicite par segment), **Copier le lien**, et
  un lien secondaire **format chemin** avec son propre bouton de copie. La copie utilise
  `navigator.clipboard`, avec repli via un champ `<input>` temporaire sélectionné +
  `document.execCommand('copy')` si l'API n'est pas disponible (contexte non sécurisé, ancien
  navigateur). S'il y a plusieurs segments, un texte explique qu'il faut ouvrir le segment suivant
  une fois arrivé à son point de jonction.
- Carte Leaflet (chargée depuis unpkg.com avec intégrité SRI, voir ci-dessous), masquée avant le
  premier résultat : tracé (plein en niveau 2, pointillé en niveau 1), marqueurs distincts pour
  départ/arrivée, étapes Geovelo, points ajoutés et limites de segment (comparées par **index**,
  pas par égalité de coordonnées flottantes), `fitBounds` automatique, légende générée
  dynamiquement par `map.js` (une seule source de vérité pour les couleurs).
- Bouton **Exporter GPX** : génère un fichier `itineraire-geovelo.gpx` avec les points envoyés à
  Google Maps (`<wpt>`) et le tracé — en `<trk>`/`<trkseg>` en niveau 2 (tracé réellement suivi),
  ou en `<rte>`/`<rtept>` en niveau 1 (suite d'étapes reliées en ligne droite, pas une trace
  réelle : l'élément GPX le plus fidèle sémantiquement).

### Sécurité du chargement des dépendances (SRI)

Leaflet 1.9.4 (CSS et JS) est chargé depuis `unpkg.com` avec un attribut `integrity` (hash
SHA-256) et `crossorigin="anonymous"`, pour empêcher l'exécution d'un fichier altéré si le CDN
était compromis. Hashs vérifiés et recalculés via :

```bash
curl -s https://unpkg.com/leaflet@1.9.4/dist/leaflet.css | openssl dgst -sha256 -binary | openssl base64 -A
curl -s https://unpkg.com/leaflet@1.9.4/dist/leaflet.js  | openssl dgst -sha256 -binary | openssl base64 -A
```

(recoupés avec succès contre le miroir `cdnjs.cloudflare.com` du même fichier).

## Lancer en local

Les modules ES ne fonctionnent pas en ouvrant `index.html` directement (`file://`) : il faut un
petit serveur HTTP local.

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000/
```

## Tests

```bash
npm test
# équivalent : node --test tests/*.test.js
# (node --test tests/ sans glob échoue sur certaines versions de Node : le
# support des répertoires en argument positionnel est peu fiable/récent ;
# `node --test`, sans argument, fonctionne aussi grâce à la découverte
# automatique du dossier tests/.)
```

Suite `node:test` + `node:assert/strict` couvrant : le parseur Geovelo (inversion lon/lat, chaque
code d'erreur, validation stricte des nombres, contrôle de domaine exact, décodage percent-encodé) ;
les liens Google Maps (formats, découpage en segments, longueur d'URL) ; les utilitaires
géométriques ; BRouter (construction d'URL, parsing — y compris sans correspondance exacte, sur la
fixture réelle —, gestion d'erreurs réseau/HTTP/timeout/abandon externe via un `fetch` mocké,
fenêtre de repli bornée) ; la sélection des points intermédiaires (géométrie en « L », boucle,
aller-retour, rond-point exclu, nœud dangereux évité, candidat trop proche d'une ancre exclu,
budget respecté, index strictement croissants, ligne droite sans ajout) ; et la génération GPX
(`<trk>` et `<rte>`).

## Déploiement GitHub Pages

1. Pousser ce dépôt sur GitHub (branche `main`).
2. Dans le dépôt GitHub : **Settings → Pages**.
3. Section **Build and deployment** → **Source** : choisir **Deploy from a branch**.
4. **Branch** : sélectionner `main`, dossier **`/ (root)`**, puis **Save**.
5. GitHub publie le site à l'URL indiquée (quelques minutes de délai au premier déploiement).

Aucune étape de build n'est nécessaire : le site est statique et les modules ES sont servis tels
quels.

## Limites connues et suite

- **openrouteservice** comme moteur de routage alternatif (en complément de BRouter) est suivi
  dans [l'issue #1 du dépôt](https://github.com/Joris-Lft/prod-geovelo-to-maps/issues/1) — non
  implémenté pour l'instant.
- BRouter est un service communautaire gratuit, sans SLA : usage raisonnable recommandé (une seule
  requête par conversion, timeout côté client, pas d'appels en boucle), avec attribution
  OSM/BRouter affichée dans l'UI et ce README. En cas d'indisponibilité ou de réponse trop lente,
  l'app se replie automatiquement sur le niveau 1.
- Le format « chemin » `data=!4m2!4m1!3e1` n'étant pas documenté officiellement par Google, son
  comportement pourrait changer sans préavis ; le format API reste la référence.
