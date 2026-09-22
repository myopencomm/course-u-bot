// src/alias.js — gestion du vocabulaire maison.
//
//   npm run alias -- list
//   npm run alias -- add "quick milk" "Lait UHT entier bio" [itemid]
//   npm run alias -- remove "quick milk"
//
// Épingler un itemid rend le choix certain : le bot ira chercher cette
// référence exacte au lieu de raisonner sur le libellé.

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './lib/paths.js';
import { chargerLexique, enregistrerAlias } from './lib/lexique.js';
import { normalize } from './lib/normalize.js';

const LEXIQUE_PATH = path.join(DATA_DIR, 'lexique.json');
const [action, cle, vers, itemid] = process.argv.slice(2);

function afficher() {
  const l = chargerLexique();
  const cles = Object.keys(l);
  if (!cles.length) return console.log('Vocabulaire vide.');
  console.log(`Vocabulaire maison (${cles.length} entrée(s)) :`);
  for (const k of cles) {
    const e = l[k];
    console.log(`  « ${k} » → ${e.vers}${e.itemid ? `  [réf. ${e.itemid}]` : ''}`);
    if (e.libelle) console.log(`      ${e.libelle}`);
  }
}

if (!action || action === 'list') {
  afficher();
} else if (action === 'add') {
  if (!cle || !vers) {
    console.log('Usage : npm run alias -- add "<ce que vous écrivez>" "<ce que ça veut dire>" [itemid]');
    process.exit(1);
  }
  const e = enregistrerAlias(cle, vers, itemid);
  console.log(`Ajouté : « ${normalize(cle)} » → ${e.vers}${e.itemid ? `  [réf. ${e.itemid}]` : ''}`);
} else if (action === 'remove') {
  const doc = JSON.parse(fs.readFileSync(LEXIQUE_PATH, 'utf8'));
  const k = normalize(cle || '');
  if (!doc.entrees?.[k]) { console.log(`Aucune entrée « ${k} ».`); process.exit(1); }
  delete doc.entrees[k];
  fs.writeFileSync(LEXIQUE_PATH, JSON.stringify(doc, null, 2));
  console.log(`Supprimé : « ${k} »`);
} else {
  console.log('Actions : list · add · remove');
  process.exit(1);
}
