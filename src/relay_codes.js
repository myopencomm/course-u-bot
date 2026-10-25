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
// Il écoute la boîte (IDLE) et la relit aussi toutes les 15 s : un code part
// dans la quinzaine de secondes qui suit son arrivée.
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
import { extractCode, SENDER_DOMAIN, SENDER_HINTS, lireConsommes, lireRelayes, connexionEnCours, marquerRelaye } from './lib/otp.js';
import { sendTelegram } from './lib/telegram.js';

const TARGET = process.env.RELAY_TELEGRAM_TARGET || '';
const ACCOUNT = process.env.RELAY_TELEGRAM_ACCOUNT || process.env.TELEGRAM_ACCOUNT || '';
const USER = process.env.GMAIL_USER;
const PASS = process.env.GMAIL_APP_PASSWORD;
// Un code Super U expire vite : un mail plus ancien ne sert plus à personne.
const MAX_AGE_MS = 10 * 60 * 1000;
// Gmail ne signale pas toujours un nouveau mail pendant l'IDLE : un code reçu
// à 17:50 n'a été vu qu'au renouvellement de l'IDLE, cinq minutes plus tard.
// On regarde donc aussi la boîte à intervalle court.
const POLL_MS = 15 * 1000;
// Au-delà, la connexion est tenue pour morte (socket à moitié fermé après une
// veille ou une coupure réseau) : on sort, launchd relance.
const EXAMEN_MAX_MS = 60 * 1000;
// Relancé juste après une coupure, le relais ne doit pas taire le code qui
// vient d'arriver : au démarrage, un code plus récent que ça est encore envoyé.
const FRAIS_AU_DEMARRAGE_MS = 3 * 60 * 1000;

// Horodaté : sans l'heure, un retard d'envoi ne se diagnostique pas.
const log = (m) => console.log(`${new Date().toLocaleTimeString('fr-FR')} ${m}`);

if (!TARGET || !USER || !PASS) {
  log('[RELAIS] RELAY_TELEGRAM_TARGET, GMAIL_USER et GMAIL_APP_PASSWORD sont requis dans .env — relais non démarré.');
  // Sortie « réussie » : launchd ne relance pas un relais non configuré.
  process.exit(0);
}

const IMAP = {
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: Number(process.env.IMAP_PORT || 993),
  secure: true,
  auth: { user: USER, pass: PASS },
  logger: false,
};
const client = new ImapFlow({
  ...IMAP,
  // Gmail coupe une IDLE au bout de ~30 min : on la renouvelle avant.
  maxIdleTime: 5 * 60 * 1000,
});
// Contrôle par une connexion neuve, à intervalle plus long : le filet de
// sécurité si la connexion permanente cesse de voir les nouveaux mails.
const CONTROLE_MS = 2 * 60 * 1000;

let dernierUid = 0;
const envoyes = new Set();

async function codesSuperU() {
  // Sans NOOP, Gmail ne met pas à jour la vue de la boîte d'une connexion
  // ouverte : la recherche ne voyait pas le mail arrivé depuis, et un code
  // reçu à 19:03 n'est jamais parti.
  await client.noop();
  const uids = await client.search(
    { from: SENDER_DOMAIN, since: new Date(Date.now() - 86400000) },
    { uid: true },
  );
  return uids || [];
}

async function examiner({ ageMax = MAX_AGE_MS } = {}) {
  for (const uid of await codesSuperU()) {
    if (uid <= dernierUid) continue;
    dernierUid = uid;

    const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true, bodyParts: ['TEXT'] }, { uid: true });
    if (!msg) continue;
    const recu = msg.internalDate ? msg.internalDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '?';
    if (msg.internalDate && Date.now() - msg.internalDate.getTime() > ageMax) { log(`[RELAIS] Mail de ${recu} ignoré : trop ancien.`); continue; }

    const from = (msg.envelope?.from || []).map((a) => `${a.name || ''} ${a.address || ''}`).join(' ').toLowerCase();
    const subject = msg.envelope?.subject || '';
    if (!SENDER_HINTS.some((h) => `${from} ${subject}`.toLowerCase().includes(h))) { log(`[RELAIS] Mail de ${recu} ignoré : expéditeur inattendu.`); continue; }

    const code = extractCode(subject) || extractCode(msg.bodyParts?.get('text')?.toString('utf8') || '');
    if (!code) { log(`[RELAIS] Mail de ${recu} ignoré : aucun code lu.`); continue; }
    if (envoyes.has(code)) continue;

    if (connexionEnCours()) {
      log('[RELAIS] Code reçu pendant une connexion du bot : gardé pour lui.');
      continue;
    }
    if (lireConsommes().some((e) => e.code === code)) { log(`[RELAIS] Code de ${recu} ignoré : utilisé par le bot.`); continue; }
    // Déjà relayé avant un redémarrage : ne pas le reposter.
    if (lireRelayes().some((e) => e.code === code)) { envoyes.add(code); continue; }

    const heure = (msg.internalDate || new Date()).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const ok = await sendTelegram(
      `🔑 Code de connexion Super U : ${code}\nReçu à ${heure}, valable quelques minutes.`,
      { target: TARGET, account: ACCOUNT },
    );
    envoyes.add(code);
    // Inscrit même si l'envoi a échoué : c'est le code de quelqu'un d'autre.
    marquerRelaye(code);
    const delai = msg.internalDate ? ` ${Math.round((Date.now() - msg.internalDate.getTime()) / 1000)} s après réception` : '';
    log(`[RELAIS] Code de ${heure} ${ok ? `envoyé sur Telegram${delai}` : 'NON envoyé (Telegram indisponible)'}.`);
  }
}

/** Échoue si Gmail ne répond pas à temps : la connexion est alors morte. */
function avecDelai(promesse, ms) {
  let minuteur;
  const delai = new Promise((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(new Error(`Gmail muet depuis ${ms / 1000} s`)), ms);
  });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur));
}

// Les examens passent l'un après l'autre : deux examens simultanés enverraient
// le même code deux fois.
let file = Promise.resolve();
function examinerBientot() {
  file = file
    .then(() => avecDelai(examiner(), EXAMEN_MAX_MS))
    .catch((err) => {
      log(`[RELAIS] Lecture en échec : ${String(err.message).slice(0, 100)}`);
      if (/muet/.test(err.message)) process.exit(1);
    });
}

await client.connect();
await client.getMailboxLock('INBOX');
log(`[RELAIS] À l'écoute des codes Super U (envoi vers ${TARGET}).`);

// Au démarrage, seuls les codes tout frais et jamais relayés partent : un
// redémarrage ne fait ni perdre le code qui arrive, ni reposter les anciens.
await avecDelai(examiner({ ageMax: FRAIS_AU_DEMARRAGE_MS }), EXAMEN_MAX_MS);

client.on('exists', examinerBientot);
setInterval(examinerBientot, POLL_MS);

// Le 25/10, la connexion permanente n'a jamais vu un code reçu à 19:03,
// qu'une connexion neuve trouvait aussitôt. Une connexion courte vérifie donc
// régulièrement qu'aucun mail Super U plus récent ne lui échappe ; si c'est
// le cas, on redémarre : le démarrage envoie les codes de moins de 3 minutes.
setInterval(async () => {
  const temoin = new ImapFlow(IMAP);
  try {
    await avecDelai(temoin.connect(), 30000);
    const verrou = await temoin.getMailboxLock('INBOX');
    const uids = (await temoin.search({ from: SENDER_DOMAIN, since: new Date(Date.now() - 86400000) }, { uid: true })) || [];
    verrou.release();
    const dernier = Math.max(0, ...uids);
    if (dernier > dernierUid) {
      // Laisse une chance à l'examen en cours avant de conclure.
      await file;
      if (dernier > dernierUid) {
        log(`[RELAIS] Vue périmée : mail ${dernier} invisible pour la connexion permanente — redémarrage.`);
        process.exit(1);
      }
    }
  } catch (err) {
    log(`[RELAIS] Contrôle impossible : ${String(err.message).slice(0, 100)}`);
  } finally {
    temoin.logout().catch(() => {});
  }
}, CONTROLE_MS);
// Connexion perdue (réseau, mise en veille) : on sort en erreur, launchd relance.
client.on('close', () => {
  log('[RELAIS] Connexion Gmail fermée — redémarrage.');
  process.exit(1);
});
client.on('error', (err) => log(`[RELAIS] Erreur IMAP : ${String(err.message).slice(0, 100)}`));
