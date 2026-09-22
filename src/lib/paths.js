// src/lib/paths.js — chemins du projet.
//
// Tout est résolu depuis l'emplacement de ce fichier : le programme fonctionne
// quel que soit le dossier où il est installé et quel que soit le répertoire
// courant au lancement.

import path from 'path';
import { fileURLToPath } from 'url';

const ICI = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(ICI, '..', '..');
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
export const SRC_DIR = path.join(ROOT, 'src');

export const PREFS_PATH = path.join(DATA_DIR, 'prefs.v2.json');
export const BILAN_PATH = path.join(DATA_DIR, 'bilan.v2.json');
export const QUESTIONS_PATH = path.join(DATA_DIR, 'questions.v2.json');
export const OTP_INBOX_PATH = path.join(DATA_DIR, 'otp_inbox.txt');
export const SESSION_PATH = path.join(DATA_DIR, 'session.json');

export const SITE = process.env.COURSESU_SITE || 'https://www.coursesu.com';
export const LOGIN_URL = `${SITE}/connexion`;
export const CART_URL = `${SITE}/panier`;
export const SEARCH_URL = (q) => `${SITE}/recherche?q=${encodeURIComponent(q)}`;

/**
 * Page d'accueil du magasin.
 *
 * Chaque utilisateur a son propre magasin (`/drive-superu-<ville>`). Plutôt que
 * d'imposer à chacun de trouver cette URL, on se rabat par défaut sur l'accueil
 * du site : le magasin déjà sélectionné sur le compte est repris automatiquement,
 * et `readContext()` le confirme via tc_vars. COURSESU_STORE_PATH permet de le
 * forcer pour qui a plusieurs magasins.
 */
export const STORE_URL = process.env.COURSESU_STORE_PATH
  ? `${SITE}/${String(process.env.COURSESU_STORE_PATH).replace(/^\//, '')}`
  : SITE;
