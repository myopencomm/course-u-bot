// src/verify_cart.js — vérifie le panier SANS rien y ajouter.
//
// Nécessaire parce que `prepare-cart` ajoute toujours : si le panier est déjà
// rempli, on ne peut pas le relancer juste pour savoir où on en est. Et un
// bilan sur disque peut avoir été produit par une version antérieure du code —
// c'est arrivé le 2026-09-21, où un bilan de 21h48 rapportait 131 lignes et
// 7 anomalies issues d'un bug de lecture corrigé deux minutes plus tard.
//
// Ce script relit le panier réel, le confronte à la liste, réécrit le bilan,
// et ne touche à rien d'autre.

import fs from 'fs';
import 'dotenv/config';
import { BILAN_PATH } from './lib/paths.js';
import { openBrowser, closeBrowser, ensureLoggedIn } from './lib/session.js';
import { readCart } from './lib/cart.js';
import { readShoppingList } from './lib/notes.js';
import { relirePanier } from './lib/judge.js';
import { sendTelegram } from './lib/telegram.js';

async function main() {
  const items = readShoppingList();
  const { page } = await openBrowser();
  try {
    await ensureLoggedIn(page, { notify: sendTelegram });
    const cart = await readCart(page);

    console.log(`[PANIER] ${cart.declaredCount ?? cart.items.length} articles · ${cart.amount ?? '?'} €`);
    for (const i of cart.items) {
      console.log(`   x${i.quantity}  ${String(i.price ?? '?').padStart(6)} €  ${i.name.slice(0, 52)}${i.unavailable ? '  ⚠️ indisponible' : ''}`);
    }

    // Cohérence interne : le site déclare-t-il le même nombre que ce qu'on lit ?
    const ecart = cart.declaredCount != null && cart.declaredCount !== cart.items.length;
    if (ecart) console.log(`[ALERTE] le site déclare ${cart.declaredCount} articles, j'en lis ${cart.items.length} — lecture suspecte.`);

    console.log('\n[RELECTURE] Vérification par le CLI Claude...');
    const revue = await relirePanier({ items, cart });

    let msg = `🔎 Vérification du panier : ${cart.declaredCount ?? cart.items.length} articles, ${cart.amount ?? '?'} €\n`;
    msg += cart.items.map((i) => `• ${i.name.slice(0, 46)} — ${i.price ?? '?'} €${i.unavailable ? ' ⚠️ indisponible' : ''}`).join('\n');

    if (ecart) msg += `\n\n⚠️ Incohérence de lecture : ${cart.declaredCount} déclarés, ${cart.items.length} lus.`;
    if (revue.verdict === 'ok') {
      msg += '\n\n✅ Panier conforme à la liste.';
      console.log('[RELECTURE] Panier conforme à la liste.');
    } else if (revue.anomalies.length) {
      msg += '\n\n' + revue.anomalies.map((a) => `⚠️ ${a}`).join('\n');
      revue.anomalies.forEach((a) => console.log(`  ⚠️  ${a}`));
    } else {
      console.log(`[RELECTURE] ${revue.verdict}${revue.erreur ? ' : ' + revue.erreur : ''}`);
    }

    // On réécrit le bilan pour que l'agent cesse de rapporter un état périmé.
    let bilan = {};
    try { bilan = JSON.parse(fs.readFileSync(BILAN_PATH, 'utf8')); } catch {}
    bilan.verifiedAt = new Date().toISOString();
    bilan.cart = cart;
    bilan.revue = revue;
    fs.writeFileSync(BILAN_PATH, JSON.stringify(bilan, null, 2));

    await sendTelegram(msg);
  } finally {
    await closeBrowser({ page });
  }
}

main().then(() => process.exit(0)).catch(async (err) => {
  console.error('[ERREUR]', err.message);
  await sendTelegram(`⚠️ Vérification du panier échouée : ${err.message}`).catch(() => {});
  process.exit(1);
});
