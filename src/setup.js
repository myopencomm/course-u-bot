// src/setup.js — assistant d'installation.
//
// Pose les questions une par une, écrit le fichier .env, prépare le lexique et
// installe le garde-fou de confidentialité. Conçu pour quelqu'un qui n'a jamais
// touché à un terminal : aucune étape ne suppose de connaissance préalable.

import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as entree, stdout as sortie } from 'process';
import { execFileSync } from 'child_process';
import { ROOT, DATA_DIR } from './lib/paths.js';

const ENV_PATH = path.join(ROOT, '.env');
const rl = readline.createInterface({ input: entree, output: sortie });

const demander = async (question, defaut = '') => {
  const r = (await rl.question(defaut ? `${question} [${defaut}] : ` : `${question} : `)).trim();
  return r || defaut;
};

console.log(`
╭──────────────────────────────────────────────────────────╮
│  course-u-bot — installation                             │
│  Votre liste de courses Apple Notes → votre panier Super U │
╰──────────────────────────────────────────────────────────╯
`);

if (fs.existsSync(ENV_PATH)) {
  const ecraser = await demander('Un fichier .env existe déjà. Le remplacer ? (oui/non)', 'non');
  if (!/^o|^y/i.test(ecraser)) { console.log('Installation interrompue, rien n\'a été modifié.'); rl.close(); process.exit(0); }
}

console.log('\n── 1/4 · Votre compte Super U ──────────────────────────────');
console.log('Les identifiants restent sur votre ordinateur, dans un fichier .env');
console.log('que git ne publiera jamais.\n');
const email = await demander('E-mail du compte Super U');
const motDePasse = await demander('Mot de passe Super U (il s\'affiche en clair)');

console.log('\n── 2/4 · Le code de connexion ──────────────────────────────');
console.log('Super U envoie un code à 8 chiffres par e-mail à chaque connexion.');
console.log('Le bot le lit tout seul, le saisit, puis supprime le message.');
console.log('Avec Gmail, créez un « mot de passe d\'application » ici :');
console.log('  https://myaccount.google.com/apppasswords');
console.log('Ce n\'est PAS le mot de passe de votre compte Google.\n');
const gmailUser = await demander('Adresse de la boîte qui reçoit le code', email);
const gmailPass = await demander('Mot de passe d\'application (16 caractères)');

console.log('\n── 3/4 · Votre note de courses ─────────────────────────────');
console.log('Le bot lit une note dans Apple Notes. Dans cette note, il ne lit');
console.log('qu\'une section, ce qui vous laisse écrire autre chose autour.\n');
const noteTitle = await demander('Titre exact de la note', 'Shopping List');
const noteSection = await demander('Titre de la section à lire', 'PROCHAIN SUPERMARCH');

console.log('\n── 4/4 · Notifications Telegram ────────────────────────────');
console.log('Facultatif. Permet de recevoir le bilan et de lancer les courses');
console.log('depuis un groupe familial. Laissez vide pour vous en passer.');
console.log('Voir docs/TELEGRAM.md pour tout le montage.\n');
const telegram = await demander('Identifiant de conversation ou de groupe (vide = aucune)', '');

const contenu = `# Généré par « npm run setup » le ${new Date().toISOString().slice(0, 10)}
COURSESU_EMAIL=${email}
COURSESU_PASSWORD=${motDePasse}
COURSESU_STORE_PATH=

GMAIL_USER=${gmailUser}
GMAIL_APP_PASSWORD=${gmailPass}
IMAP_HOST=imap.gmail.com
IMAP_PORT=993

TELEGRAM_TARGET=${telegram}

NOTE_TITLE=${noteTitle}
NOTE_SECTION=${noteSection}

JUDGE_ENABLED=true
JUDGE_PRESET=claude
JUDGE_THRESHOLD=0.8
`;
fs.writeFileSync(ENV_PATH, contenu, { mode: 0o600 });
console.log(`\n✅ Fichier .env écrit (lisible par vous seul).`);

// Lexique de départ
const lexique = path.join(DATA_DIR, 'lexique.json');
if (!fs.existsSync(lexique)) {
  fs.writeFileSync(lexique, JSON.stringify({
    _doc: "Vocabulaire de votre foyer. Ajoutez des entrées avec « npm run alias -- add ».",
    entrees: {},
  }, null, 2));
  console.log('✅ Lexique vide créé (data/lexique.json).');
}

// Garde-fou : refuse de publier des données personnelles
try {
  const hooks = path.join(ROOT, '.git', 'hooks');
  if (fs.existsSync(hooks)) {
    const hook = path.join(hooks, 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nnode "$(dirname "$0")/../../src/check_privacy.js" || exit 1\n', { mode: 0o755 });
    console.log('✅ Garde-fou installé : git refusera un commit contenant vos données.');
  }
} catch {}

console.log(`
── Et maintenant ───────────────────────────────────────────

  1. Connectez-vous une première fois, à la main :
       npm run login
     Une fenêtre Chrome s'ouvre. Connectez-vous normalement.
     La session est ensuite réutilisée, vous n'aurez plus à le faire.

  2. Apprenez vos habitudes d'achat :
       npm run sync-account
       npm run build-prefs

  3. Écrivez votre liste dans la note Apple, puis :
       npm run prepare-cart

  Le panier est rempli, JAMAIS validé : vous gardez la main
  sur la commande et le paiement.
`);
rl.close();
