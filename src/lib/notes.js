// src/lib/notes.js — lecture de la note Apple et extraction de la liste.
//
// Format réel de la note (texte libre en français) :
//   Lait frais entier 3 bouteilles        -> 3 unités
//   Kiwi gold 5                           -> 5 unités
//   tomates cerises 500 g au moins        -> 1 unité, contrainte de poids 500 g
//   Chocolat noir 80% doux Lindt          -> 1 unité (80% n'est pas une quantité)
//   Disques le chat 4 en 1 pour le linge  -> 1 unité ("4 en 1" fait partie du nom)
//
// Les trois derniers cas sont précisément ceux où un extracteur naïf se trompe.

import fs from 'fs';
import { execFileSync } from 'child_process';

// Titre exact de la note Apple à lire, et titre de la section à l'intérieur.
const NOTE_TITLE = process.env.NOTE_TITLE || 'Shopping List';
const SECTION_TITLE = process.env.NOTE_SECTION || 'PROCHAIN SUPERMARCH';
const SECTION = new RegExp(SECTION_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

// Unités de comptage : le nombre qui précède est une quantité.
const COUNT_UNITS = /^(bouteilles?|tablettes?|bo[iî]tes?|paquets?|pi[eè]ces?|sachets?|pots?|barquettes?|briques?|packs?|tubes?|flacons?|rouleaux?|douzaines?|x)$/i;
// Unités de mesure : le nombre qui précède décrit la taille, pas la quantité.
const SIZE_UNITS = /^(g|kg|mg|l|cl|ml|dl|cm|mm)$/i;

function osascript(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function readNoteBody() {
  const script = `tell application "Notes" to return body of (first note whose name is "${NOTE_TITLE}")`;
  try {
    return osascript(script);
  } catch (err) {
    const brut = String(err.stderr || err.message);
    if (/-1719|Index non valable|Invalid index|can.t get note/i.test(brut)) {
      throw new Error(
        `Aucune note intitulée « ${NOTE_TITLE} » dans Apple Notes.\n` +
        `  • Créez-la, ou changez NOTE_TITLE dans le fichier .env.\n` +
        `  • Le titre doit correspondre exactement, accents compris.\n` +
        `  • Voir docs/INSTALLATION.md, étape 5.`,
      );
    }
    if (/not authorized|1743|Application isn.t running/i.test(brut)) {
      throw new Error(
        'Accès à Apple Notes refusé.\n' +
        "  • Réglages Système > Confidentialité et sécurité > Automatisation,\n" +
        '    autorisez le Terminal à piloter Notes, puis relancez.',
      );
    }
    throw new Error(`Lecture d'Apple Notes impossible : ${brut.split('\n')[0].slice(0, 120)}`);
  }
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ');
}

/** Isole la section PROCHAIN SUPERMARCHÉ jusqu'au prochain titre en capitales. */
export function extractSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => SECTION.test(l));
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (!t) continue;
    // Un nouveau titre de section (majuscules, pas de minuscule) termine la liste.
    if (/^[A-ZÉÈÀÂÎÔÛÇ0-9\s'’-]{6,}$/.test(t) && !/[a-zéèàâîôûç]/.test(t)) break;
    out.push(t);
  }
  return out;
}

/** Transforme une ligne libre en { raw, wanted, quantity, sizeHint }. */
export function parseLine(raw) {
  let s = raw.replace(/^[-•*•]\s*/, '').trim();
  let quantity = 1;
  let sizeHint = null;

  const words = s.split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const num = w.match(/^(\d+)$/);
    if (!num) continue;
    const n = Number(num[1]);
    const next = (words[i + 1] || '').replace(/[.,]$/, '');

    // "4 en 1" : désignation commerciale, on n'y touche pas.
    if (/^en$/i.test(next) && /^\d+$/.test(words[i + 2] || '')) continue;
    // "80%" est collé au chiffre, donc déjà exclu par le match ^\d+$ ; on gère "80 %".
    if (next === '%') continue;

    if (SIZE_UNITS.test(next)) { sizeHint = `${n} ${next}`; continue; }
    if (COUNT_UNITS.test(next)) { quantity = n; words.splice(i, 2); i -= 1; continue; }
    // Nombre nu en fin de ligne : quantité ("Kiwi gold 5").
    if (i === words.length - 1 && n <= 30) { quantity = n; words.splice(i, 1); break; }
  }

  const wanted = words.join(' ').replace(/\s+/g, ' ').replace(/\s+(au moins|environ|si possible)$/i, '').trim();
  return { raw, wanted: wanted || s, quantity, sizeHint };
}

export function readShoppingList({ fromFile } = {}) {
  const text = fromFile ? fs.readFileSync(fromFile, 'utf8') : htmlToText(readNoteBody());
  return extractSection(text).map(parseLine);
}

/** Date de dernière modification de la note, d'après Notes. */
function readNoteModified() {
  // Calculé en secondes par rapport à maintenant : une date AppleScript sort
  // dans la langue du système et ne se relit pas de façon fiable.
  const script = `tell application "Notes" to return ((modification date of (first note whose name is "${NOTE_TITLE}")) - (current date)) as integer`;
  try {
    const ecart = Number(osascript(script).trim());
    return Number.isFinite(ecart) ? new Date(Date.now() + ecart * 1000) : null;
  } catch { return null; }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lit la liste après avoir laissé à iCloud le temps de livrer les dernières
 * modifications.
 *
 * La note est partagée : une modification faite sur un autre appareil n'arrive
 * sur ce Mac que si Notes tourne, quelques secondes à quelques dizaines de
 * secondes plus tard. Quand Notes était fermé, osascript le lançait et lisait
 * aussitôt la copie locale, d'avant la synchronisation : un ajout de dernière
 * minute manquait au panier.
 *
 * On lance donc Notes s'il ne tourne pas et on lui laisse le temps de se
 * synchroniser, puis on relit la note jusqu'à ce qu'elle ne bouge plus.
 * Réglages : NOTE_SYNC_COLD_MS (attente après lancement, 45 s), NOTE_SYNC_STABLE_MS
 * (durée sans changement exigée, 15 s), NOTE_SYNC_MAX_MS (plafond, 120 s).
 *
 * @returns {{ items, modifiedAt: Date|null, waitedMs: number }}
 */
export async function readShoppingListFresh({ fromFile, log = console.log } = {}) {
  if (fromFile) return { items: readShoppingList({ fromFile }), modifiedAt: null, waitedMs: 0 };

  const debut = Date.now();
  const coldMs = Number(process.env.NOTE_SYNC_COLD_MS || 45000);
  const stableMs = Number(process.env.NOTE_SYNC_STABLE_MS || 15000);
  const maxMs = Number(process.env.NOTE_SYNC_MAX_MS || 120000);

  let lance = false;
  try { lance = osascript('application "Notes" is running').trim() === 'true'; } catch {}
  if (!lance) {
    log(`[NOTE] Notes était fermé : lancement, puis ${Math.round(coldMs / 1000)} s pour la synchronisation iCloud.`);
    try { osascript('tell application "Notes" to launch'); } catch {}
    await pause(coldMs);
  }

  let corps = readNoteBody();
  let depuis = Date.now();
  while (Date.now() - depuis < stableMs && Date.now() - debut < maxMs) {
    await pause(5000);
    const nouveau = readNoteBody();
    if (nouveau !== corps) {
      log('[NOTE] La note vient de changer (synchronisation en cours) : on attend qu\'elle se stabilise.');
      corps = nouveau;
      depuis = Date.now();
    }
  }

  return {
    items: extractSection(htmlToText(corps)).map(parseLine),
    modifiedAt: readNoteModified(),
    waitedMs: Date.now() - debut,
  };
}
