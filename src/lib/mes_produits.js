// src/lib/mes_produits.js — la liste « Mes produits » / « Mes achats récents » du compte.
//
// Le site tient lui-même une liste des produits achetés par le compte, calculée
// sur toutes les commandes. C'est la première source consultée pour chaque ligne,
// avant la recherche dans tout le catalogue : un produit qui y figure est un
// produit que la personne achète déjà.
//
// Deux pièges relevés sur la page :
//   - elle se charge par morceaux de 20 au fil du défilement (infinite scroll) :
//     sans défiler jusqu'au bout, on n'en voit que le premier écran ;
//   - tc_vars.products ne décrit que ces 20 premiers, et la page porte aussi les
//     tuiles du mini-panier. On lit donc les tuiles de la liste elle-même
//     (`.wishlist-products [data-list-product-id]`), qui portent chacune leur
//     fiche JSON dans data-tc-product-tile.
//
// L'adresse directe peut changer un jour : à défaut, on retrouve la page par les
// liens « Mes produits » / « Mes achats récents » du menu, comme une personne.

import fs from 'fs';
import path from 'path';
import { SITE, DATA_DIR } from './paths.js';
import { acceptCookies, dismissOverlays } from './session.js';

export const MES_PRODUITS_PATH = path.join(DATA_DIR, 'achats_recents.json');

const TUILES = '.wishlist-products [data-list-product-id]';
const ADRESSES = [
  `${SITE}/mon-compte/mes-listes?isPref=true`,
  `${SITE}/mon-compte/mes-produits-preferes`,
];
// Libellés des liens qui mènent à la liste, du plus précis au plus large.
const LIENS = [/^\s*mes achats r[ée]cents\s*$/i, /^\s*mes produits\s*$/i, /^\s*mes listes\s*$/i];

async function surLaListe(page, timeout = 8000) {
  return page.locator(TUILES).first().waitFor({ state: 'attached', timeout })
    .then(() => true).catch(() => false);
}

/** Suit, sur la page courante, le premier lien dont le texte correspond. */
async function suivreLien(page, motif) {
  const href = await page.evaluate((src) => {
    const re = new RegExp(src.source, src.flags);
    const a = [...document.querySelectorAll('a[href]')].find((x) => re.test(x.innerText || x.textContent || ''));
    return a ? a.href : null;
  }, { source: motif.source, flags: motif.flags });
  if (!href) return false;
  await page.goto(href, { waitUntil: 'domcontentloaded' });
  return true;
}

/**
 * Ouvre la liste. Renvoie le chemin suivi, ou null si la page est introuvable.
 * « Mes produits » ou « Mes listes » peuvent mener à la page des listes sans
 * ouvrir les achats récents : on y cherche alors le lien des achats récents.
 */
async function ouvrir(page, adresses = ADRESSES) {
  for (const url of adresses) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page);
    if (await surLaListe(page)) return url;
  }
  for (const depart of [SITE, `${SITE}/mon-compte`]) {
    for (const motif of LIENS) {
      await page.goto(depart, { waitUntil: 'domcontentloaded' });
      await acceptCookies(page);
      await page.waitForTimeout(1500);
      if (!(await suivreLien(page, motif))) continue;
      const nom = motif.source.replace(/\^|\$|\\s\*/g, '').replace('r[ée]cents', 'récents');
      if (await surLaListe(page)) return `lien « ${nom} » depuis ${depart}`;
      if (await suivreLien(page, LIENS[0]) && await surLaListe(page)) return `lien « ${nom} » puis « mes achats récents » depuis ${depart}`;
    }
  }
  return null;
}

/** Défile jusqu'à ce que la liste cesse de grandir. */
async function toutCharger(page, { maxMs = 120000 } = {}) {
  const compter = () => page.locator(TUILES).count();
  const debut = Date.now();
  let avant = await compter();
  let immobile = 0;
  // Le chargement se déclenche quand le bas de la liste entre à l'écran. Rester
  // collé en bas ne suffit pas : il faut que le défilement bouge, d'où le petit
  // aller-retour à chaque tour. Sans lui, la liste s'arrêtait à 80 sur 180.
  while (immobile < 4 && Date.now() - debut < maxMs) {
    await page.evaluate((sel) => [...document.querySelectorAll(sel)].pop()?.scrollIntoView({ block: 'end' }), TUILES);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(1200);
    const n = await compter();
    if (n > avant) { avant = n; immobile = 0; } else immobile += 1;
  }
  return avant;
}

async function lireTuiles(page) {
  return page.evaluate((sel) => {
    const vus = new Set();
    const out = [];
    for (const t of document.querySelectorAll(sel)) {
      let d = {};
      try { d = JSON.parse(t.getAttribute('data-tc-product-tile') || '{}'); } catch { /* fiche illisible */ }
      const itemid = String(d.id || t.getAttribute('data-list-product-id') || t.getAttribute('data-itemid') || '');
      if (!itemid || vus.has(itemid)) continue;
      vus.add(itemid);
      const lien = t.querySelector('a[href*=".html"]');
      const prix = (t.querySelector('[class*="price"]')?.innerText || '').trim();
      out.push({
        itemid,
        ean: d.EAN || null,
        name: d.name || t.getAttribute('data-list-product-name') || '',
        brand: d.brand || '',
        price: d.price && d.price !== 'unknown' ? Number(d.price) : null,
        rating: typeof d.notation === 'number' ? Number(d.notation.toFixed(2)) : null,
        quantity: Number(d.quantity) || 1,
        cat1: d.product_cat1 || t.getAttribute('data-category') || null,
        cat2: d.product_cat2 || null,
        cat3: d.product_cat3 || null,
        cgid: d.product_cat3_id || d.product_cat2_id || d.product_cat1_id || null,
        url: lien ? new URL(lien.getAttribute('href'), location.origin).href : null,
        // Rang dans la liste : le site la trie par fréquence d'achat.
        rang: out.length + 1,
        disponible: !/bient[oô]t disponible|indisponible|rupture/i.test(prix),
      });
    }
    return out;
  }, TUILES);
}

/**
 * Lit toute la liste du compte et l'enregistre dans data/achats_recents.json.
 * En cas d'échec, renvoie la dernière copie enregistrée (`depuisCache: true`).
 */
export async function lireMesProduits(page, { log = console.log, adresses = ADRESSES } = {}) {
  const t0 = Date.now();
  try {
    const chemin = await ouvrir(page, adresses);
    if (!chemin) throw new Error('page « Mes produits » introuvable (adresse et liens du menu)');
    await dismissOverlays(page);
    await toutCharger(page);
    const products = await lireTuiles(page);
    if (!products.length) throw new Error('liste vide');
    fs.writeFileSync(MES_PRODUITS_PATH, JSON.stringify({
      capturedAt: new Date().toISOString(),
      source: 'mes-produits-preferes',
      chemin,
      count: products.length,
      products,
    }, null, 2));
    log(`[MES PRODUITS] ${products.length} produits lus en ${Math.round((Date.now() - t0) / 1000)} s (${chemin}).`);
    return { products, depuisCache: false };
  } catch (err) {
    let cache = { products: [] };
    try { cache = JSON.parse(fs.readFileSync(MES_PRODUITS_PATH, 'utf8')); } catch { /* aucune copie */ }
    log(`[MES PRODUITS] lecture impossible (${err.message}) — ${cache.products?.length || 0} produits de la copie du ${cache.capturedAt?.slice(0, 10) || '?'}.`);
    return { products: cache.products || [], depuisCache: true, erreur: err.message };
  }
}
