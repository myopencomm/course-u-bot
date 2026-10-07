// src/relay_codes.js — envoie sur Telegram les codes Super U demandés par une
// autre personne du foyer.
//
//   npm run relay-codes
//
// Plusieurs personnes partagent le même compte Super U. Quand l'une d'elles se
// connecte depuis son ordinateur (pour relire le panier préparé par le bot,
// par exemple), Super U envoie le code à l'adresse du compte — une boîte Gmail
// qu'elle ne consulte pas forcément. Ce programme la surveille et poste chaque
// nouveau code dans le groupe Telegram du foyer.
//
// Il tourne en continu (voir docs/TELEGRAM.md pour le lancer au démarrage du
// Mac) et ne fait rien d'autre : il lit, il ne supprime ni ne déplace aucun mail.
//
// Il se tait dans deux cas :
//   - le bot est lui-même en train de se connecter (marqueur debutConnexion) :
//     ce code-là est le sien, il le consomme seul ;
//   - le code figure déjà dans le registre des codes consommés par le bot.
//
// Chaque code relayé est inscrit dans data/codes_relayes.json : le bot, s'il se
// connecte juste après, ne le prendra pas pour le sien.

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { extractCode, SENDER_DOMAIN, SENDER_HINTS, lireConsommes, connexionEnCours, marquerRelaye } from './lib/otp.js';
import { sendTelegram } from './lib/telegram.js';

const TARGET = process.env.RELAY_TELEGRAM_TARGET || '';
const ACCOUNT = process.env.RELAY_TELEGRAM_ACCOUNT || process.env.TELEGRAM_ACCOUNT || '';
const USER = process.env.GMAIL_USER;
const PASS = process.env.GMAIL_APP_PASSWORD;
// Un code Super U expire vite : un mail plus ancien ne sert plus à personne.
const MAX_AGE_MS = 10 * 60 * 1000;

if (!TARGET || !USER || !PASS) {
  console.log('[RELAIS] RELAY_TELEGRAM_TARGET, GMAIL_USER et GMAIL_APP_PASSWORD sont requis dans .env — relais non démarré.');
  // Sortie « réussie » : launchd ne relance pas un relais non configuré.
  process.exit(0);
}

const client = new ImapFlow({
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: Number(process.env.IMAP_PORT || 993),
  secure: true,
  auth: { user: USER, pass: PASS },
  logger: false,
  // Gmail coupe une IDLE au bout de ~30 min : on la renouvelle avant.
  maxIdleTime: 5 * 60 * 1000,
});

let dernierUid = 0;
const envoyes = new Set();

async function codesSuperU() {
  const uids = await client.search(
    { from: SENDER_DOMAIN, since: new Date(Date.now() - 86400000) },
    { uid: true },
  );
  return uids || [];
}

async function examiner() {
  for (const uid of await codesSuperU()) {
    if (uid <= dernierUid) continue;
    dernierUid = uid;

    const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true, bodyParts: ['TEXT'] }, { uid: true });
    if (!msg) continue;
    if (msg.internalDate && Date.now() - msg.internalDate.getTime() > MAX_AGE_MS) continue;

    const from = (msg.envelope?.from || []).map((a) => `${a.name || ''} ${a.address || ''}`).join(' ').toLowerCase();
    const subject = msg.envelope?.subject || '';
    if (!SENDER_HINTS.some((h) => `${from} ${subject}`.toLowerCase().includes(h))) continue;

    const code = extractCode(subject) || extractCode(msg.bodyParts?.get('text')?.toString('utf8') || '');
    if (!code || envoyes.has(code)) continue;

    if (connexionEnCours()) {
      console.log(`[RELAIS] Code reçu pendant une connexion du bot : gardé pour lui.`);
      continue;
    }
    if (lireConsommes().some((e) => e.code === code)) continue;

    const heure = (msg.internalDate || new Date()).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const ok = await sendTelegram(
      `🔑 Code de connexion Super U : ${code}\nReçu à ${heure}, valable quelques minutes.`,
      { target: TARGET, account: ACCOUNT },
    );
    envoyes.add(code);
    // Inscrit même si l'envoi a échoué : c'est le code de quelqu'un d'autre.
    marquerRelaye(code);
    console.log(`[RELAIS] Code de ${heure} ${ok ? 'envoyé sur Telegram' : 'NON envoyé (Telegram indisponible)'}.`);
  }
}

await client.connect();
await client.getMailboxLock('INBOX');
// Au démarrage, les codes déjà présents ne sont pas renvoyés.
dernierUid = Math.max(0, ...(await codesSuperU()));

// Les événements sont traités l'un après l'autre : deux examens simultanés
// enverraient le même code deux fois.
let file = Promise.resolve();
client.on('exists', () => {
  file = file.then(examiner).catch((err) => console.warn(`[RELAIS] Lecture en échec : ${String(err.message).slice(0, 100)}`));
});
// Connexion perdue (réseau, mise en veille) : on sort en erreur, launchd relance.
client.on('close', () => {
  console.log('[RELAIS] Connexion Gmail fermée — redémarrage.');
  process.exit(1);
});
client.on('error', (err) => console.warn(`[RELAIS] Erreur IMAP : ${String(err.message).slice(0, 100)}`));

console.log(`[RELAIS] À l'écoute des codes Super U (envoi vers ${TARGET}).`);
