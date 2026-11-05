// src/sync_account.js — aspire le compte Super U : achats récents + historique.
//
// Remplace le "npm run aspirer" de la v1, qui exigeait que l'utilisateur ouvre
// lui-même une page de commande dans son navigateur et n'en capturait qu'une.
// Ici on parcourt le compte tout seul.
//
// Deux sources, complémentaires :
//   - « Mes produits » / « Mes achats récents » (/mon-compte/mes-listes?isPref=true) :
//     la liste de fréquence que le site calcule lui-même sur l'ensemble des
//     commandes. C'est le meilleur corpus disponible, et il est prêt à l'emploi.
//   - /mon-compte/mes-commandes + detail?orderId=... : l'historique commande par
//     commande, qui donne la chronologie et les quantités réelles.

import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { DATA_DIR, SITE } from './lib/paths.js';
import { openBrowser, closeBrowser, ensureLoggedIn, acceptCookies } from './lib/session.js';
import { sendTelegram } from './lib/telegram.js';
import { lireMesProduits } from './lib/mes_produits.js';

const ORDERS_DIR = path.join(DATA_DIR, 'orders');

// La liste se charge par morceaux au fil du défilement : la lecture complète
// (défilement jusqu'au bout, repli par les liens du menu) est partagée avec
// prepare_cart, dans lib/mes_produits.js.
async function syncFavorites(page) {
  const { products, depuisCache, erreur } = await lireMesProduits(page, { log: (m) => console.log(m) });
  if (depuisCache) throw new Error(`liste « Mes produits » illisible : ${erreur}`);
  return products;
}

/** Liste les ids de commande visibles, en déroulant la pagination si besoin. */
async function listOrderIds(page) {
  await page.goto(`${SITE}/mon-compte/mes-commandes`, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);
  await page.waitForTimeout(1200);

  const ids = new Set();
  for (let round = 0; round < 25; round++) {
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="orderId="]')]
        .map((a) => (a.getAttribute('href').match(/orderId=(\d+)/) || [])[1])
        .filter(Boolean));
    found.forEach((id) => ids.add(id));

    // Le site charge les commandes plus anciennes à la demande.
    const more = page.getByRole('button', { name: /voir plus|charger|afficher plus|suivant/i }).first();
    if (!(await more.isVisible({ timeout: 1500 }).catch(() => false))) break;
    await more.click().catch(() => {});
    await page.waitForTimeout(1800);
  }
  return [...ids];
}

/**
 * Extrait les lignes d'une page détail de commande.
 *
 * Attention : contrairement aux pages de recherche, tc_vars.products est VIDE
 * sur cette page. Il faut lire le DOM. Et là encore il y a des carrousels : sur
 * une commande de 36 articles, la page porte 56 .product-tile dont 20 viennent
 * de .top-header. On les exclut, sinon l'historique se pollue tout seul.
 */
async function readOrderLines(page) {
  return page.evaluate(() => {
    const tiles = [...document.querySelectorAll('#main .product-tile')]
      .filter((t) => !t.closest('.top-header'));
    return tiles.map((t) => {
      const link = t.querySelector('a[href*=".html"]');
      const qtyInput = t.querySelector('input[type="number"], input[value]');
      const text = t.innerText.replace(/\s+/g, ' ').trim();
      const priceMatch = text.match(/(\d+[.,]\d{2})\s*€/);
      const name = (t.querySelector('.product-name, .pdp-link, a[href*=".html"]')?.innerText || '').trim();
      return {
        itemid: t.getAttribute('data-itemid'),
        ean: t.getAttribute('data-item-ean') || null,
        name: name || text.slice(0, 70),
        quantity: qtyInput ? Number(qtyInput.value) || 1 : 1,
        price: priceMatch ? Number(priceMatch[1].replace(',', '.')) : null,
        url: link ? new URL(link.getAttribute('href'), location.origin).href.split('?')[0] : null,
      };
    }).filter((p) => p.itemid);
  });
}

async function harvestOrders(page, { limit = 60 } = {}) {
  fs.mkdirSync(ORDERS_DIR, { recursive: true });
  const ids = await listOrderIds(page);
  console.log(`[HISTORIQUE] ${ids.length} commandes repérées.`);

  const harvested = [];
  for (const orderId of ids.slice(0, limit)) {
    const target = path.join(ORDERS_DIR, `${orderId}.json`);
    if (fs.existsSync(target)) { harvested.push(orderId); continue; } // déjà aspirée

    await page.goto(`${SITE}/mon-compte/mes-commandes/detail?orderId=${orderId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1400);

    const products = await readOrderLines(page);
    const dateText = await page.evaluate(() => {
      const m = document.body.innerText.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
      return m ? m[1] : null;
    });

    if (!products.length) { console.log(`  ${orderId} : aucune ligne lue, ignorée.`); continue; }
    fs.writeFileSync(target, JSON.stringify({ orderId, date: dateText, itemCount: products.length, products }, null, 2));
    harvested.push(orderId);
    console.log(`  ${orderId} (${dateText || 'date ?'}) : ${products.length} articles`);
    await page.waitForTimeout(600); // on ne martèle pas le site
  }
  return harvested;
}

async function main() {
  const { page } = await openBrowser();
  try {
    await ensureLoggedIn(page, { notify: sendTelegram });
    const favorites = await syncFavorites(page);
    const orders = await harvestOrders(page);
    const msg = `📦 Compte Super U synchronisé : ${favorites.length} achats récents, ${orders.length} commandes en base.`;
    console.log(msg);
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
  await sendTelegram(`⚠️ Synchro compte Super U échouée : ${err.message}`).catch(() => {});
  process.exit(1);
});
