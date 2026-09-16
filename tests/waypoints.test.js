import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectWaypoints } from '../js/waypoints.js';
import { haversineDistance } from '../js/geo.js';

// Géométrie synthétique en "L" : un segment horizontal (10 sommets) suivi
// d'un segment vertical (9 sommets), le coude étant la fin de la première
// section. Les deux sections font ~220 m, valides pour générer un candidat
// (point milieu) chacune.
function lShapeRoute() {
  const coords = [];
  for (let i = 0; i < 10; i++) coords.push({ lat: 0, lng: 0.0002 * i }); // idx 0..9
  for (let i = 1; i <= 9; i++) coords.push({ lat: 0.0002 * i, lng: 0.002 }); // idx 10..18
  const sections = [
    { startIdx: 0, endIdx: 9, wayTags: { highway: 'unclassified' }, nodeTags: {}, lengthM: sumLen(coords, 0, 9) },
    { startIdx: 9, endIdx: 18, wayTags: { highway: 'unclassified' }, nodeTags: {}, lengthM: sumLen(coords, 9, 18) },
  ];
  return { coords, sections, lengthM: sumLen(coords, 0, 18) };
}

function sumLen(coords, from, to) {
  let sum = 0;
  for (let i = from + 1; i <= to; i++) sum += haversineDistance(coords[i - 1], coords[i]);
  return sum;
}

test('L-shape: adds a point near the corner but not on it (corner is a section end)', () => {
  const route = lShapeRoute();
  const anchors = [route.coords[0], route.coords[18]];
  const result = selectWaypoints({ route, anchors, extraBudget: 1 });

  assert.equal(result.length, 3);
  assert.equal(result[0].kind, 'anchor');
  assert.equal(result[2].kind, 'anchor');
  assert.equal(result[1].kind, 'added');
  // Le point ajouté ne doit pas être exactement le coude (idx 9).
  assert.notEqual(Math.round(result[1].idx), 9);
  assert.ok(result[1].idx > 0 && result[1].idx < 18);
});

test('anchors are always present, ordered by geometry position', () => {
  const route = lShapeRoute();
  const anchors = [route.coords[0], route.coords[9], route.coords[18]];
  const result = selectWaypoints({ route, anchors, extraBudget: 2 });
  const anchorPoints = result.filter((p) => p.kind === 'anchor');
  assert.equal(anchorPoints.length, 3);
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i].idx >= result[i - 1].idx);
  }
});

test('budget 0 -> anchors only', () => {
  const route = lShapeRoute();
  const anchors = [route.coords[0], route.coords[18]];
  const result = selectWaypoints({ route, anchors, extraBudget: 0 });
  assert.equal(result.length, 2);
  assert.ok(result.every((p) => p.kind === 'anchor'));
});

test('a roundabout section is never chosen as a candidate', () => {
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push({ lat: 0, lng: 0.0002 * i });
  // Légère déviation pour créer un écart réel par rapport à la corde.
  coords[10] = { lat: 0.0005, lng: coords[10].lng };
  const route = {
    coords,
    sections: [{ startIdx: 0, endIdx: 20, wayTags: { highway: 'unclassified', junction: 'roundabout' }, nodeTags: {}, lengthM: sumLen(coords, 0, 20) }],
    lengthM: sumLen(coords, 0, 20),
  };
  const anchors = [coords[0], coords[20]];
  const result = selectWaypoints({ route, anchors, extraBudget: 3 });
  assert.equal(result.length, 2, 'no point should be added from a roundabout-only route');
});

test('extraBudget caps the number of added points even if more deviation remains', () => {
  // Zig-zag géométrie avec plusieurs sections valides et bien déviées.
  const coords = [];
  const sections = [];
  let idx = 0;
  for (let seg = 0; seg < 6; seg++) {
    const latOffset = seg % 2 === 0 ? 0 : 0.001;
    const start = idx;
    for (let i = 0; i <= 10; i++) {
      coords.push({ lat: latOffset, lng: 0.001 * seg + 0.0001 * i });
      idx++;
    }
    const end = idx - 1;
    sections.push({
      startIdx: start,
      endIdx: end,
      wayTags: { highway: 'unclassified' },
      nodeTags: {},
      lengthM: sumLen(coords, start, end),
    });
  }
  const route = { coords, sections, lengthM: sumLen(coords, 0, coords.length - 1) };
  const anchors = [coords[0], coords[coords.length - 1]];
  const budget = 2;
  const result = selectWaypoints({ route, anchors, extraBudget: budget });
  const added = result.filter((p) => p.kind === 'added');
  assert.ok(added.length <= budget);
});

test('loop: departure ~= arrival close to the 1st vertex -> arrival still maps to the last index', () => {
  // Boucle : le premier sommet (idx0) est à ~2,2 m de l'ancre d'arrivée,
  // le dernier sommet (idx=len-1) à ~5 m. Numériquement, idx0 est donc plus
  // proche de l'ancre d'arrivée que le vrai dernier sommet : une recherche
  // "plus proche voisin" se tromperait et renverrait idx0. La règle
  // "arrivée = dernier index, sans recherche" doit l'éviter.
  const coords = [];
  coords.push({ lat: 0, lng: 0 }); // idx0 : départ
  for (let i = 1; i <= 20; i++) coords.push({ lat: 0.0005 * i, lng: 0.0003 * i }); // boucle qui s'éloigne
  coords.push({ lat: 0, lng: 0.00006 }); // idx22 (dernier) : ~6,6 m de idx0

  const route = { coords, sections: [], lengthM: 0 };
  const anchors = [
    { lat: 0, lng: 0 }, // départ = idx0 exactement
    { lat: 0, lng: 0.00002 }, // arrivée : ~2,2 m de idx0, ~4,9 m du vrai dernier sommet
  ];

  const result = selectWaypoints({ route, anchors, extraBudget: 0 });
  assert.equal(result.length, 2);
  assert.equal(result[0].idx, 0);
  assert.equal(result[1].idx, coords.length - 1);
});

test('out-and-back: a step anchor on the outbound leg must not snap to the closer return leg', () => {
  // Aller : lat=0, lng 0 -> 0.01 (idx0..10). Retour : lat=-0.00003 (~3,3 m
  // au sud), lng 0.009 -> -0.001 (idx11..21). L'ancre d'étape est à ~2,77 m
  // de l'aller (idx5) mais à seulement ~0,55 m du retour (idx~16) : une
  // recherche "plus proche global" choisirait à tort le retour (index plus
  // grand, hors ordre chronologique).
  const coords = [];
  for (let i = 0; i <= 10; i++) coords.push({ lat: 0, lng: 0.001 * i }); // idx0..10 (aller)
  for (let i = 0; i <= 10; i++) coords.push({ lat: -0.00003, lng: 0.009 - 0.001 * i }); // idx11..21 (retour)

  const route = { coords, sections: [], lengthM: 0 };
  const anchors = [
    { lat: 0, lng: 0 }, // départ = idx0
    { lat: -0.000025, lng: 0.005 }, // étape, proche de idx5 (aller) ET idx~16 (retour, plus proche)
    { lat: -0.00003, lng: -0.001 }, // arrivée = dernier idx (21)
  ];

  const result = selectWaypoints({ route, anchors, extraBudget: 0 });
  assert.equal(result.length, 3);
  assert.equal(result[0].idx, 0);
  assert.equal(result[2].idx, coords.length - 1);
  assert.ok(result[1].idx <= 10, `step should snap to the outbound leg (idx <= 10), got ${result[1].idx}`);
  assert.ok(result[1].idx < result[2].idx);
});

test('added points stay sorted by idx alongside anchors', () => {
  const route = lShapeRoute();
  const anchors = [route.coords[0], route.coords[18]];
  const result = selectWaypoints({ route, anchors, extraBudget: 1 });
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i].idx > result[i - 1].idx, 'idx must be strictly increasing');
  }
});

test('a candidate stays >= 30 m from a hazardous node (traffic_signals) tagged at a section boundary', () => {
  // Section unique de 22 sommets (~231 m), avec un feu tricolore tagué en
  // NodeTags à sa fin (idx21). Le point milieu (idx~11) en est déjà loin,
  // mais on vérifie que la contrainte réelle (30 m, distance à vol
  // d'oiseau) est bien appliquée à ce nœud, et pas seulement à l'extrémité
  // "générique" de section.
  const coords = [];
  for (let i = 0; i <= 21; i++) coords.push({ lat: 0, lng: 0.0001 * i });
  const sections = [
    {
      startIdx: 0,
      endIdx: 21,
      wayTags: { highway: 'unclassified' },
      nodeTags: { highway: 'traffic_signals' },
      lengthM: sumLen(coords, 0, 21),
    },
  ];
  const route = { coords, sections, lengthM: sumLen(coords, 0, 21) };

  const hazardNode = coords[21];
  const anchors = [coords[0], coords[21]];
  const result = selectWaypoints({ route, anchors, extraBudget: 1 });

  const added = result.filter((p) => p.kind === 'added');
  for (const p of added) {
    assert.ok(haversineDistance(p, hazardNode) >= 30, 'candidate must stay >= 30 m from a hazardous node');
  }
});

test('a candidate within 40 m of an anchor is excluded', () => {
  const route = lShapeRoute();
  // coords[5] coïncide avec le candidat "point milieu" que produirait la
  // section A (t=0.5) : en en faisant une ancre, ce candidat doit être
  // exclu (trop proche), sans empêcher un ajout valide ailleurs (section B).
  const midAnchor = route.coords[5];
  const anchors = [route.coords[0], midAnchor, route.coords[18]];
  const result = selectWaypoints({ route, anchors, extraBudget: 2 });

  const added = result.filter((p) => p.kind === 'added');
  for (const p of added) {
    assert.ok(haversineDistance(p, midAnchor) >= 40, 'a candidate too close to an anchor must be excluded');
  }
});

test('straight line geometry -> no point added', () => {
  const coords = [];
  for (let i = 0; i <= 10; i++) coords.push({ lat: 0, lng: 0.0002 * i });
  const sections = [
    { startIdx: 0, endIdx: 10, wayTags: { highway: 'cycleway' }, nodeTags: {}, lengthM: sumLen(coords, 0, 10) },
  ];
  const route = { coords, sections, lengthM: sumLen(coords, 0, 10) };
  const anchors = [coords[0], coords[10]];
  const result = selectWaypoints({ route, anchors, extraBudget: 5 });
  assert.equal(result.length, 2);
});
