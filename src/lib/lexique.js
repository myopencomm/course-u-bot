// src/lib/lexique.js — vocabulaire maison et produits de saison.
//
// Deux traductions appliquées avant tout rapprochement catalogue :
//
//  1. Le VOCABULAIRE du foyer. Quelqu'un écrit « quick milk » pour du lait UHT
//     entier bio, « penguin chocolate » pour du Milka au lait. Aucun algorithme
//     de similarité ne peut deviner ça : c'est une convention, elle s'apprend
//     et se stocke.
//
//  2. Les PRODUITS DE SAISON. « 3 légumes de saison » ne désigne aucun produit
//     en particulier : il faut connaître le mois de la commande, savoir ce qui
//     est de saison, et choisir en priorité ce que le foyer achète vraiment.

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.js';
import { normalize, similarity } from './normalize.js';

const LEXIQUE_PATH = path.join(DATA_DIR, 'lexique.json');
const SAISONS_PATH = path.join(DATA_DIR, 'saisons.json');

// « 3 légumes de saison », « seasonal fruits », « 2 fruits de saison »…
const SAISON_RE = /^(?:(\d+)\s+)?(?:(l[ée]gumes?|vegetables?|veggies?)|(fruits?))\s*(?:de\s+saison|of\s+the\s+season|du\s+moment)$|^(?:(\d+)\s+)?seasonal\s+(?:(vegetables?|veggies?)|(fruits?))$/i;

export function chargerLexique() {
  try { return JSON.parse(fs.readFileSync(LEXIQUE_PATH, 'utf8')).entrees || {}; }
  catch { return {}; }
}

export function chargerSaisons() {
  try { return JSON.parse(fs.readFileSync(SAISONS_PATH, 'utf8')); }
  catch { return {}; }
}

export function enregistrerAlias(cle, vers, itemid = null, libelle = null) {
  let doc = { entrees: {} };
  try { doc = JSON.parse(fs.readFileSync(LEXIQUE_PATH, 'utf8')); } catch {}
  doc.entrees = doc.entrees || {};
  doc.entrees[normalize(cle)] = {
    vers,
    itemid: itemid || null,
    libelle: libelle || null,
    ajoute: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(LEXIQUE_PATH, JSON.stringify(doc, null, 2));
  return doc.entrees[normalize(cle)];
}

/** Traduit une ligne si elle correspond à une entrée du vocabulaire maison. */
function appliquerAlias(ligne, lexique) {
  const cle = normalize(ligne.wanted);
  const exact = lexique[cle];
  if (exact) return { ...ligne, wanted: exact.vers, pinnedItemId: exact.itemid || null, alias: cle };

  // Tolérance : « quick milk bio » doit encore reconnaître « quick milk ».
  for (const [k, v] of Object.entries(lexique)) {
    if (cle.startsWith(k + ' ') || cle.endsWith(' ' + k)) {
      return { ...ligne, wanted: v.vers, pinnedItemId: v.itemid || null, alias: k };
    }
  }
  return null;
}

/**
 * Classe les produits de saison du mois par ce que le foyer achète réellement.
 * Un « légume de saison » qui n'a jamais été acheté vaut moins qu'un habituel.
 */
function classerParHabitude(noms, prefs) {
  const produits = Object.values(prefs?.products || {});
  return noms
    .map((nom) => {
      let meilleur = 0;
      for (const p of produits) {
        if (similarity(nom, p.label) >= 0.75) meilleur = Math.max(meilleur, p.confidence ?? 0);
      }
      return { nom, habitude: meilleur };
    })
    .sort((a, b) => b.habitude - a.habitude);
}

/**
 * Développe une ligne « N légumes/fruits de saison » en N lignes concrètes.
 * `dejaPris` évite de proposer deux fois le même produit dans une même liste.
 */
function appliquerSaison(ligne, { prefs, date, dejaPris }) {
  const m = SAISON_RE.exec(ligne.wanted.trim());
  if (!m) return null;

  // Sans chiffre, on en met trois. « légumes de saison » s'écrit presque
  // toujours sans nombre, et ce qui est attendu derrière, c'est un assortiment.
  // Un « x2 » repéré par le parseur de quantité reste prioritaire sur ce défaut.
  const DEFAUT = 3;
  const explicite = Number(m[1] || m[4]);
  const nombre = Number.isFinite(explicite) && explicite > 0
    ? explicite
    : (ligne.quantity > 1 ? ligne.quantity : DEFAUT);
  const estLegume = Boolean(m[2] || m[5]);
  const saisons = chargerSaisons();
  const mois = String((date || new Date()).getMonth() + 1);
  const bloc = saisons[mois];
  if (!bloc) return null;

  const source = estLegume ? bloc.legumes : bloc.fruits;
  const classes = classerParHabitude(source, prefs).filter((c) => !dejaPris.has(normalize(c.nom)));
  const choisis = classes.slice(0, nombre);
  if (!choisis.length) return null;

  choisis.forEach((c) => dejaPris.add(normalize(c.nom)));
  return choisis.map((c) => ({
    raw: ligne.raw,
    wanted: c.nom,
    quantity: 1,
    sizeHint: null,
    saison: { mois: bloc.nom, type: estLegume ? 'légume' : 'fruit', habitude: c.habitude },
  }));
}

/**
 * Applique vocabulaire et saison à une liste de lignes.
 * Retourne les lignes développées, plus un journal des traductions faites.
 */
export function developper(lignes, { prefs, date = new Date() } = {}) {
  const lexique = chargerLexique();
  const dejaPris = new Set(lignes.map((l) => normalize(l.wanted)));
  const sorties = [];
  const journal = [];

  for (const ligne of lignes) {
    const alias = appliquerAlias(ligne, lexique);
    if (alias) {
      sorties.push(alias);
      journal.push(`« ${ligne.wanted} » → ${alias.wanted}${alias.pinnedItemId ? ' (référence épinglée)' : ''}`);
      continue;
    }

    const saison = appliquerSaison(ligne, { prefs, date, dejaPris });
    if (saison) {
      sorties.push(...saison);
      const t = saison[0].saison;
      journal.push(`« ${ligne.wanted} » → ${saison.map((s) => s.wanted).join(', ')} (${t.type}s de ${t.mois})`);
      continue;
    }

    sorties.push(ligne);
  }
  return { lignes: sorties, journal };
}
