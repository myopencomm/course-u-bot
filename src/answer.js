// src/answer.js — applique les réponses aux questions en attente.
// Usage : node src/answer.js "1a 2b 3skip"

import fs from 'fs';
import 'dotenv/config';
import { QUESTIONS_PATH, BILAN_PATH, PREFS_PATH } from './lib/paths.js';
import { openBrowser, closeBrowser, ensureLoggedIn } from './lib/session.js';
import { search, rank } from './lib/catalog.js';
import { addFromSearch, readCart } from './lib/cart.js';
import { sendTelegram } from './lib/telegram.js';

/** "1a 2b 3skip" -> Map { 1 => 'a', 2 => 'b', 3 => 'skip' } */
function parseAnswers(raw) {
  const out = new Map();
  for (const m of String(raw).matchAll(/(\d+)\s*(skip|[a-c])/gi)) {
    out.set(Number(m[1]), m[2].toLowerCase());
  }
  return out;
}

async function main() {
  const answers = parseAnswers(process.argv.slice(2).join(' '));
  if (!answers.size) {
    console.log('Aucune réponse exploitable. Format attendu : "1a 2b 3skip".');
    return;
  }

  const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  const prefs = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
  const { page } = await openBrowser();
  const done = [];
  const remaining = [];

  try {
    await ensureLoggedIn(page, { notify: sendTelegram });

    for (const q of questions) {
      const choice = answers.get(q.index);
      if (!choice) { remaining.push(q); continue; }
      if (choice === 'skip') { done.push({ ...q, result: 'ignoré' }); continue; }

      const option = q.options['abc'.indexOf(choice)];
      if (!option) { remaining.push(q); continue; }

      // Il faut revenir sur une page de résultats pour disposer d'une tuile cliquable.
      const res = await search(page, option.name);
      rank(res.products, { wanted: q.wanted, prefs });
      const r = await addFromSearch(page, option.itemid, q.quantity || 1);
      done.push({ ...q, result: r.ok ? `ajouté : ${option.name}` : `échec : ${r.reason}` });
      console.log(`  ${r.ok ? '✅' : '⚠️'} ${q.wanted} -> ${option.name.slice(0, 50)}`);
    }

    const cart = await readCart(page);
    fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(remaining, null, 2));

    const bilan = JSON.parse(fs.readFileSync(BILAN_PATH, 'utf8'));
    bilan.answeredAt = new Date().toISOString();
    bilan.answers = done;
    bilan.cart = cart;
    fs.writeFileSync(BILAN_PATH, JSON.stringify(bilan, null, 2));

    let msg = `🛒 Panier complété : ${cart.items.length} articles${cart.amount ? `, ${cart.amount} €` : ''}.\n`;
    msg += done.map((d) => `• ${d.wanted} → ${d.result}`).join('\n');
    if (remaining.length) msg += `\n\nIl reste ${remaining.length} question(s) sans réponse.`;
    console.log(`\n${msg}`);
    await sendTelegram(msg);
  } finally {
    // Chrome reste ouvert : la session Super U et la clearance Cloudflare
    // restent chaudes pour le run suivant.
    await closeBrowser({ page });
  }
}

// La connexion CDP maintient la boucle d'événements ouverte et Chrome reste
// volontairement lancé : on sort explicitement, comme le faisait la v1.
main().then(() => process.exit(0)).catch(async (err) => {
  console.error('[ERREUR]', err.message);
  await sendTelegram(`⚠️ Réponses non appliquées : ${err.message}`).catch(() => {});
  process.exit(1);
});
