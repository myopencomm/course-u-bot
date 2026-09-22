// src/lib/otp.js — récupération du code de vérification envoyé par Super U.
//
// Deux sources, dans cet ordre :
//   1. Gmail en IMAP  — instantané, autonome, personne dans la boucle.
//   2. Fichier de dépannage — data/otp_inbox.txt, lu ici si l'IMAP casse.
//
// Attention : ce fichier ne peut PAS être alimenté automatiquement depuis le
// groupe Telegram. Zapier y poste le code via un bot, or l'API Telegram ne livre
// jamais à un bot les messages émis par un autre bot (ni les siens). Aucun bot
// OpenClaw ne verra donc ce code. Le fichier se remplit à la main, ou par
// l'agent quand l'utilisateur lui donne le code en message direct — un humain,
// ses messages passent.
//
// Le code n'est accepté que s'il est postérieur au début de la tentative de
// connexion : sans ça, on rejouerait le code de la session précédente.

import fs from 'fs';
import { ImapFlow } from 'imapflow';
import path from 'path';
import { OTP_INBOX_PATH, DATA_DIR } from './paths.js';

const CONSUMED_PATH = path.join(DATA_DIR, 'otp_consumed.json');

// Le code Super U fait 8 chiffres (placeholder du site : "Exemple : 12345678").
// On accepte 6 à 8 pour encaisser un changement de format, en privilégiant le
// plus long : une première version ne cherchait que 6 chiffres et ne trouvait rien.
const CODE_RES = [/\b(\d{8})\b/, /\b(\d{7})\b/, /\b(\d{6})\b/];
// Expéditeur réel du code, relevé sur un mail authentique :
//   ne-pas-repondre@auth-mail.magasins-u.com
//   sujet : "Connexion à votre compte U : votre code d'authentification"
const SENDER_DOMAIN = 'magasins-u.com';
const SENDER_HINTS = ['magasins-u', 'coursesu', 'systeme-u', 'compte u'];
// Ordre de fouille. La corbeille est indispensable : le mail y est déplacé après
// traitement par l'automatisation Zapier, souvent avant qu'on ait pu le lire.
const MAILBOXES = ['INBOX', '[Gmail]/All Mail', '[Gmail]/Trash'];

/** Extrait le code d'un texte, en privilégiant le format le plus long. */
function extractCode(text) {
  if (!text) return null;
  for (const re of CODE_RES) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Cherche le code dans les mails reçus depuis `since`. Retourne null si rien.
 *
 * Deux pièges corrigés ici, tous deux silencieux :
 *
 * 1. `client.search()` renvoie des NUMÉROS DE SÉQUENCE, pas des UID, tant qu'on
 *    ne passe pas `{ uid: true }`. Une première version enchaînait avec
 *    `fetchOne(id, ..., { uid: true })` : elle lisait donc de tout autres
 *    messages et ne trouvait jamais rien, sans la moindre erreur.
 *
 * 2. Les codes s'empilent dans un même fil de conversation quand plusieurs
 *    tentatives se suivent. Il faut impérativement le PLUS RÉCENT, sinon on
 *    ressaisit un code déjà périmé.
 */
async function pollGmail({ since, user, pass, consommes = [] }) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();
  try {
    const candidates = [];

    // Le mail du code est supprimé après traitement par l'automatisation : il
    // atterrit en corbeille, parfois en quelques secondes. Et dans la sémantique
    // IMAP de Gmail, "All Mail" N'INCLUT PAS la corbeille. Chercher dans INBOX
    // seul — ou même dans All Mail — ne trouve donc rien dès que le mail a été
    // supprimé. On balaie les trois dossiers.
    for (const mailbox of MAILBOXES) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch {
        continue; // dossier absent selon la langue du compte
      }
      try {
        const uids = await client.search(
          { from: SENDER_DOMAIN, since: new Date(since.getTime() - 86400000) },
          { uid: true },
        );
        for (const uid of (uids || []).slice(-20)) {
          const msg = await client.fetchOne(String(uid), {
            envelope: true,
            internalDate: true,
            bodyParts: ['TEXT'],
          }, { uid: true });
          if (!msg) continue;
          if (msg.internalDate && msg.internalDate < since) continue;

          const from = (msg.envelope?.from || []).map((a) => `${a.name || ''} ${a.address || ''}`).join(' ').toLowerCase();
          const subject = msg.envelope?.subject || '';
          if (!SENDER_HINTS.some((h) => `${from} ${subject}`.toLowerCase().includes(h))) continue;

          const body = msg.bodyParts?.get('text')?.toString('utf8') || '';
          const code = extractCode(subject) || extractCode(body);
          // On retient OÙ se trouve le message : il devra être supprimé une fois
          // le code utilisé, pour ne pas polluer la boîte que Zapier surveille.
          if (code && !consommes.includes(code)) {
            candidates.push({ code, at: msg.internalDate || new Date(0), mailbox, uid: String(uid) });
          }
        }
      } finally {
        lock.release();
      }
    }

    if (!candidates.length) return null;
    // Les codes s'empilent quand plusieurs tentatives se suivent : le plus
    // récent est le seul valide.
    candidates.sort((a, b) => b.at - a.at);
    return candidates[0];
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Lit le code déposé dans le fichier de dépannage, s'il est frais. */
function pollFileRelay({ since }) {
  try {
    const stat = fs.statSync(OTP_INBOX_PATH);
    if (stat.mtime < since) return null; // code périmé, laissé par une tentative antérieure
    const code = extractCode(fs.readFileSync(OTP_INBOX_PATH, 'utf8'));
    return code || null;
  } catch {
    return null;
  }
}

/** Codes déjà présentés au site : on ne les rejoue jamais. */
function lireConsommes() {
  try {
    const l = JSON.parse(fs.readFileSync(CONSUMED_PATH, 'utf8'));
    const limite = Date.now() - 6 * 3600 * 1000; // au-delà de 6h, sans objet
    return Array.isArray(l) ? l.filter((e) => e && e.at > limite) : [];
  } catch { return []; }
}

export function marquerConsomme(code) {
  const l = lireConsommes().filter((e) => e.code !== code);
  l.push({ code, at: Date.now() });
  try { fs.writeFileSync(CONSUMED_PATH, JSON.stringify(l.slice(-20), null, 2)); } catch {}
}

/**
 * Supprime le mail dont le code vient d'être utilisé.
 *
 * Une autre personne du foyer peut se connecter au même compte depuis son poste
 * code via Zapier, qui surveille cette boîte. Zapier repère mal les empilements
 * et peut relayer un code déjà consommé par le bot. Laisser traîner nos mails
 * fait donc échouer SES connexions : on nettoie derrière nous.
 *
 * Un échec de suppression n'est jamais bloquant — la connexion, elle, a réussi.
 */
export async function supprimerMail(ref, { user, pass } = {}) {
  if (!ref?.uid || !ref?.mailbox) return false;
  const u = user || process.env.GMAIL_USER;
  const p = pass || process.env.GMAIL_APP_PASSWORD;
  if (!u || !p) return false;

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: u, pass: p }, logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(ref.mailbox);
    try {
      // Sur Gmail, messageDelete() retire seulement le libellé du dossier
      // courant : depuis INBOX cela ARCHIVE le message, qui reste visible dans
      // « Tous les messages ». Un déplacement explicite vers la corbeille est la
      // seule vraie suppression. On garde messageDelete en repli, et on ne
      // déplace pas un message déjà dans la corbeille.
      if (!/trash|corbeille/i.test(ref.mailbox)) {
        await client.messageMove({ uid: ref.uid }, '[Gmail]/Trash', { uid: true });
      } else {
        await client.messageDelete({ uid: ref.uid }, { uid: true });
      }
      return true;
    } finally {
      lock.release();
    }
  } catch (err) {
    console.warn(`[OTP] mail non supprimé (${String(err.message).slice(0, 80)}) — sans conséquence pour la connexion.`);
    return false;
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Balaie les mails dont le code a DÉJÀ été consommé par le bot.
 *
 * Filet de sécurité : si une suppression a échoué (réseau, verrou IMAP), le mail
 * resterait dans la boîte surveillée et pourrait faire relayer à cette personne
 * un code périmé. On ne touche qu'aux codes présents dans notre propre registre :
 * un code frais destiné à quelqu'un d'autre n'y figure jamais.
 */
export async function nettoyerMailsConsommes({ user, pass } = {}) {
  const u = user || process.env.GMAIL_USER;
  const p = pass || process.env.GMAIL_APP_PASSWORD;
  const connus = lireConsommes().map((e) => e.code);
  if (!u || !p || !connus.length) return 0;

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: u, pass: p }, logger: false,
  });
  let efface = 0;
  try {
    await client.connect();
    for (const mailbox of ['INBOX', '[Gmail]/All Mail']) {
      let lock;
      try { lock = await client.getMailboxLock(mailbox); } catch { continue; }
      try {
        const uids = await client.search(
          { from: SENDER_DOMAIN, since: new Date(Date.now() - 48 * 3600 * 1000) },
          { uid: true },
        );
        for (const uid of (uids || [])) {
          const msg = await client.fetchOne(String(uid), { envelope: true, bodyParts: ['TEXT'] }, { uid: true });
          if (!msg) continue;
          const body = msg.bodyParts?.get('text')?.toString('utf8') || '';
          const code = extractCode(msg.envelope?.subject || '') || extractCode(body);
          if (!code || !connus.includes(code)) continue;
          await client.messageMove({ uid: String(uid) }, '[Gmail]/Trash', { uid: true }).catch(() => {});
          efface += 1;
        }
      } finally { lock.release(); }
    }
  } catch (err) {
    console.warn(`[OTP] balayage des mails consommés impossible (${String(err.message).slice(0, 70)}).`);
  } finally {
    await client.logout().catch(() => {});
  }
  return efface;
}

/** Efface le relais pour qu'un code déjà consommé ne soit jamais rejoué. */
export function clearRelay() {
  try { fs.unlinkSync(OTP_INBOX_PATH); } catch {}
}

/**
 * Attend le code de vérification.
 * @param {Date}   since       Instant de début de la tentative de connexion.
 * @param {number} timeoutMs   Abandon au-delà.
 * @param {function} onWaiting Appelé une fois, pour prévenir l'utilisateur.
 */
export async function waitForCode({ since, timeoutMs = 180000, onWaiting, graceMs = 240000 } = {}) {
  // Fenêtre volontairement tolérante vers le passé. Le mail est déclenché par la
  // soumission du formulaire, mais `since` n'est fixé qu'après la validation du
  // Turnstile, qui prend plusieurs dizaines de secondes : un code légitime
  // arrivait AVANT `since` et était rejeté comme périmé, sans que le site en
  // renvoie un second. La liste des codes déjà consommés évite le rejeu.
  const start = new Date((since || new Date()).getTime() - graceMs);
  const deadline = Date.now() + timeoutMs;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  let gmailUsable = Boolean(user && pass);
  let notified = false;
  let echecs = 0;

  while (Date.now() < deadline) {
    if (gmailUsable) {
      try {
        const trouve = await pollGmail({ since: start, user, pass, consommes: lireConsommes().map((e) => e.code) });
        if (trouve) return { code: trouve.code, source: 'gmail', ref: { mailbox: trouve.mailbox, uid: trouve.uid } };
        echecs = 0;
      } catch (err) {
        // Un incident passager ne doit pas condamner Gmail pour tout l'appel :
        // une première version désactivait la source dès la première erreur.
        echecs += 1;
        console.warn(`[OTP] lecture Gmail en échec (${echecs}/3) : ${String(err.message).slice(0, 80)}`);
        if (echecs >= 3) {
          console.warn('[OTP] Gmail abandonné — bascule sur le fichier de dépannage.');
          gmailUsable = false;
        }
      }
    }

    const relayed = pollFileRelay({ since: start });
    if (relayed) return { code: relayed, source: 'fichier', ref: null };

    if (!notified) {
      notified = true;
      if (onWaiting) await onWaiting({ gmailUsable });
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(`Aucun code de vérification reçu en ${Math.round(timeoutMs / 1000)}s (Gmail + fichier de dépannage).`);
}
