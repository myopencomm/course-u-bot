// src/lib/normalize.js — rapprochement d'une ligne de liste avec un libellé catalogue.
//
// La première version utilisait un Jaccard symétrique. C'était structurellement
// faux ici : une requête courte face à un nom de produit long est lourdement
// pénalisée. « Comté » contre « Comté AOP au lait cru affiné 15 mois JURAFLORE,
// 35%mg, 200g » ne partage qu'1 token sur 11, soit 0,09 — alors que c'est
// exactement le produit voulu, et qu'il est dans les achats récents.
//
// On raisonne donc en COUVERTURE : quelle part des mots de la demande se
// retrouve dans le candidat. « Comté » → 1/1 = 1. Et on ajoute la POSITION :
// « Citron vert » en tête de « Citron vert - filet » vaut mieux que le même
// « citron vert » au milieu de « Filets de thon à l'huile d'olive Citron vert ».

// Mots qui n'aident pas à discriminer (marques distributeur, unités, liaisons).
const NOISE = new Set([
  'u', 'bio', 'saveurs', 'tout', 'petits', 'le', 'la', 'les', 'de', 'du', 'des',
  'a', 'au', 'aux', 'en', 'et', 'l', 'd', 'x', 'g', 'kg', 'ml', 'cl', 'mg',
]);

// Les listes de courses sont écrites moitié français moitié anglais.
// « Banana » ne partageait aucun token avec « Banane Cavendish » : score 0.
const EN_FR = new Map(Object.entries({
  banana: 'banane', bananas: 'banane', lemon: 'citron', lime: 'citron vert',
  milk: 'lait', bread: 'pain', cheese: 'fromage', butter: 'beurre',
  egg: 'oeuf', eggs: 'oeuf', apple: 'pomme', apples: 'pomme',
  chicken: 'poulet', beef: 'boeuf', pork: 'porc', fish: 'poisson',
  rice: 'riz', pasta: 'pates', water: 'eau', juice: 'jus', oil: 'huile',
  salt: 'sel', pepper: 'poivre', sugar: 'sucre', flour: 'farine',
  onion: 'oignon', garlic: 'ail', potato: 'pomme de terre', tomato: 'tomate',
  carrot: 'carotte', cucumber: 'concombre', strawberry: 'fraise',
  yoghurt: 'yaourt', yogurt: 'yaourt', cream: 'creme', honey: 'miel',
  chocolate: 'chocolat', coffee: 'cafe', tea: 'the', beer: 'biere', wine: 'vin',
}));

export function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Forme canonique : minuscules, sans accents, sans ponctuation. */
export function normalize(s) {
  return stripAccents(String(s || '').toLowerCase())
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokens significatifs, anglais traduit, bruit retiré. */
export function tokens(s) {
  const out = [];
  for (const t of normalize(s).split(' ')) {
    if (!t) continue;
    const fr = EN_FR.get(t);
    if (fr) out.push(...fr.split(' '));
    else out.push(t);
  }
  return out.filter((t) => !NOISE.has(t));
}

/** Distance de Levenshtein bornée à 1, pour absorber pluriels et variantes. */
function nearlyEqual(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length < 5 || b.length < 5) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function findToken(tok, list) {
  return list.findIndex((c) => nearlyEqual(tok, c));
}

/**
 * Similarité 0..1, orientée « le candidat répond-il à la demande ».
 * Asymétrique à dessein : similarity(demande, candidat).
 */
export function similarity(wanted, candidate) {
  const q = tokens(wanted);
  const c = tokens(candidate);
  if (!q.length || !c.length) return 0;

  let found = 0;
  let positionSum = 0;
  for (const t of q) {
    const idx = findToken(t, c);
    if (idx >= 0) { found += 1; positionSum += idx; }
  }
  if (!found) return 0;

  // Part des mots demandés effectivement présents. C'est le signal principal.
  const coverage = found / q.length;
  // Position moyenne des mots trouvés : en tête = pertinent, noyé au milieu = accessoire.
  const avgPos = positionSum / found;
  const head = Math.max(0, 1 - avgPos / 6);
  // Léger malus pour les noms très bavards, qui décrivent souvent autre chose.
  const concision = Math.min(1, (q.length + 3) / c.length);

  return Number((0.62 * coverage + 0.26 * head + 0.12 * concision).toFixed(4));
}
