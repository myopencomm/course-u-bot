// src/check_privacy.js — refuse de publier des données personnelles.
//
// Ce programme manipule des identifiants, un historique d'achats et des listes
// de courses : tout cela décrit un foyer. Un « git add . » distrait suffirait à
// le rendre public et rien ne le rattraperait.
//
// Ce contrôle inspecte ce que git s'apprête à envoyer — pas le disque entier —
// et refuse si quelque chose ressemble à une donnée personnelle.
//
//   npm run check-privacy          vérifie les fichiers suivis par git
//   npm run check-privacy -- --all vérifie aussi les fichiers non suivis
//
// Installé en hook pre-commit par « npm run setup ».

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const RACINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Fichiers qui ne doivent jamais être suivis, quel que soit leur contenu.
const INTERDITS = [
  /^\.env$/,
  /^\.env\.(?!example)/,
  /^data\/(?!saisons\.json|lexique\.example\.json|\.gitkeep)/,
  /^\.chrome-profile\//,
  /^node_modules\//,
];

// Prénoms à ne jamais publier. Renseignez-les dans .env :
//   PRIVACY_NAMES=Marie,Paul
// Les commentaires de code sont l'endroit où ils se glissent le plus facilement.
const PRENOMS = (process.env.PRIVACY_NAMES || '')
  .split(',').map((n) => n.trim()).filter((n) => n.length >= 3);

// Motifs recherchés dans le contenu des fichiers publiés.
const MOTIFS = [
  ...PRENOMS.map((n) => ({
    nom: `prénom « ${n} »`,
    re: new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
  })),
  { nom: 'adresse e-mail', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g, sauf: /exemple\.|example\.|votre\.email|noreply@|ne-pas-repondre@/i },
  // Un vrai code est aléatoire. Les durées en millisecondes (86400000) et les
  // exemples de documentation finissent par des zéros : on les écarte.
  { nom: 'code de connexion à 8 chiffres', re: /\b\d{8}\b/g, sauf: /12345678|0{4,}$/ },
  { nom: 'numéro de commande', re: /\bN[°ºo]\s*\d{7,9}\b/gi },
  { nom: 'identifiant Telegram', re: /\b-?\d{9,12}\b/g, sauf: /1234567890|^\d{1,8}$/ },
  { nom: 'chemin personnel', re: /\/Users\/(?!votre-nom|utilisateur)[a-z0-9_.-]+\//gi },
];

function fichiersSuivis(tout) {
  try {
    const args = tout ? ['ls-files', '--cached', '--others', '--exclude-standard'] : ['ls-files', '--cached'];
    return execFileSync('git', args, { cwd: RACINE, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    console.error('Pas de dépôt git ici — rien à vérifier.');
    process.exit(0);
  }
}

const tout = process.argv.includes('--all');
const fichiers = fichiersSuivis(tout);
const alertes = [];

for (const f of fichiers) {
  if (INTERDITS.some((re) => re.test(f))) {
    alertes.push({ fichier: f, quoi: 'fichier interdit à la publication', extrait: '' });
    continue;
  }
  const complet = path.join(RACINE, f);
  let contenu;
  try {
    if (fs.statSync(complet).size > 2 * 1024 * 1024) continue;
    contenu = fs.readFileSync(complet, 'utf8');
  } catch { continue; }
  if (/\.(png|jpe?g|gif|pdf|zip|ico)$/i.test(f)) continue;

  for (const m of MOTIFS) {
    for (const trouve of contenu.match(m.re) || []) {
      if (m.sauf && m.sauf.test(trouve)) continue;
      alertes.push({ fichier: f, quoi: m.nom, extrait: trouve.slice(0, 40) });
    }
  }
}

if (!alertes.length) {
  console.log(`✅ ${fichiers.length} fichier(s) vérifié(s) — aucune donnée personnelle détectée.`);
  process.exit(0);
}

console.error(`\n⛔ ${alertes.length} problème(s) — publication bloquée.\n`);
const parFichier = new Map();
for (const a of alertes) {
  if (!parFichier.has(a.fichier)) parFichier.set(a.fichier, []);
  parFichier.get(a.fichier).push(a);
}
for (const [f, liste] of parFichier) {
  console.error(`  ${f}`);
  for (const a of liste.slice(0, 5)) console.error(`     ${a.quoi}${a.extrait ? ` : ${a.extrait}` : ''}`);
  if (liste.length > 5) console.error(`     … et ${liste.length - 5} autre(s)`);
}
console.error('\nQue faire :');
console.error('  • fichier personnel indexé par erreur → git rm --cached <fichier>');
console.error('  • donnée réelle dans un exemple → remplacez-la par une valeur fictive');
console.error('  • faux positif → ajustez les motifs dans src/check_privacy.js\n');
process.exit(1);
