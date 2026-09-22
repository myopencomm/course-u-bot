// src/empty_cart.js — vide le panier. Destructif, donc explicite.
// Usage : npm run empty-cart -- --confirm

import 'dotenv/config';
import { openBrowser, closeBrowser, ensureLoggedIn } from './lib/session.js';
import { readCart } from './lib/cart.js';
import { CART_URL } from './lib/paths.js';
import { sendTelegram } from './lib/telegram.js';

if (!process.argv.includes('--confirm')) {
  console.log('Refus : vider le panier efface un travail éventuellement fait à la main.');
  console.log('Relancer avec --confirm si c\'est bien l\'intention.');
  process.exit(1);
}

const { page } = await openBrowser();
try {
  await ensureLoggedIn(page, { notify: sendTelegram });
  const avant = await readCart(page);
  console.log(`Avant : ${avant.items.length} articles, ${avant.amount ?? '?'} €`);

  for (let tour = 0; tour < 40; tour++) {
    await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const reste = await page.evaluate(() => {
      const l = document.querySelector('#cart-table .cart-row');
      if (!l) return 0;
      const dec = l.querySelector('.product-button__dec');
      if (dec) dec.click();
      return document.querySelectorAll('#cart-table .cart-row').length;
    });
    if (!reste) break;
    await page.waitForTimeout(2000);
  }

  const apres = await readCart(page);
  console.log(`Après : ${apres.items.length} articles, ${apres.amount ?? '?'} €`);
  await sendTelegram(`🗑 Panier vidé (${avant.items.length} articles retirés).`);
} finally {
  await closeBrowser({ page });
  process.exit(0);
}
