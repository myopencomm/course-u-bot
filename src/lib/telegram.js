// src/lib/telegram.js — notifications via le CLI openclaw.
//
// Le CLI ne sait pas LIRE les messages Telegram (l'API Bot ne donne pas
// l'historique) : `openclaw message read` renvoie "Unsupported Telegram action".
// C'est pour ça que le code de vérification passe par Gmail en priorité, et que
// le repli Telegram s'appuie sur l'agent, qui écrit le code dans otp_inbox.txt.

import { execFile } from 'child_process';
import fs from 'fs';

// Aucun destinataire par défaut : un identifiant en dur enverrait les courses
// de tout le monde au même endroit.
const TARGET = process.env.TELEGRAM_TARGET || '';
const CANDIDATE_BINS = [
  process.env.OPENCLAW_BIN,
  `${process.env.HOME}/.npm-global/bin/openclaw`,
  '/usr/local/bin/openclaw',
  'openclaw',
].filter(Boolean);

function bin() {
  for (const b of CANDIDATE_BINS) if (b === 'openclaw' || fs.existsSync(b)) return b;
  return 'openclaw';
}

export function sendTelegram(text, { target = TARGET, account = process.env.TELEGRAM_ACCOUNT || '' } = {}) {
  if (!target) {
    console.log('  (TELEGRAM_TARGET non défini — notification ignorée)');
    return Promise.resolve(false);
  }
  // `--target=<id>` collé : l'identifiant d'un groupe commence par « - » et
  // serait lu comme une option. `--account` choisit le bot OpenClaw membre du
  // groupe quand il y en a plusieurs.
  const args = ['message', 'send', '--channel', 'telegram', `--target=${target}`, '-m', text];
  if (account) args.push('--account', String(account));
  return new Promise((resolve) => {
    execFile(bin(), args,
      { timeout: 30000 },
      (err) => {
        if (err) console.log(`  ⚠️  Telegram indisponible : ${String(err.message).slice(0, 120)}`);
        resolve(!err);
      });
  });
}
