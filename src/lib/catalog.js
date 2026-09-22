// src/lib/catalog.js — recherche produit et choix du bon article.
//
// L'ancien script lisait le texte des tuiles HTML. Le site publie en réalité,
// pour chaque page de résultats, un tableau window.tc_vars.products qui reflète
// exactement les tuiles affichées (même ordre, 1:1) avec 23 champs structurés :
// id, EAN, marque, note client, prix, et la hiérarchie de catégories complète.
// On lit ça : plus de parsing de texte, et on gagne la note et la marque.

import { SEARCH_URL } from './paths.js';
import { acceptCookies, dismissOverlays } from './session.js';
import { similarity, normalize } from './normalize.js';

/** Récupère les produits structurés de la page de résultats courante. */
async function readProducts(page) {
  return page.evaluate(() => {
    const v = window.tc_vars || {};
    const list = Array.isArray(v.products) ? v.products : [];
    // Le périmètre est capital : connecté, la page porte ~38 .product-tile dont
    // 20 viennent de carrousels ("déjà acheté", suggestions) rendus AVANT les
    // résultats. Seules celles de #search-result-items sont alignées 1:1 avec
    // tc_vars.products. Sans ce scope, on ajoute au panier le mauvais produit.
    const tiles = [...document.querySelectorAll('#search-result-items .product-tile')];
    return list.map((p, i) => {
      const tile = tiles[i];
      const link = tile ? tile.querySelector('a[href*=".html"]') : null;
      // Un produit non commandable (rupture, hors assortiment du magasin) n'a
      // pas de bouton d'ajout : inutile de le proposer.
      const inCart = tile ? Boolean(tile.querySelector('.product-delete-button')) : false;
      const addable = tile
        ? Boolean(tile.querySelector('[data-global-login-cta="productAddition"], .product-button__bag')) || inCart
        : false;
      const priceText = tile ? (tile.querySelector('[class*="price"]')?.innerText || '').trim() : '';
      return {
        itemid: String(p.id),
        ean: p.EAN || null,
        name: p.name || '',
        brand: p.brand || '',
        rating: typeof p.notation === 'number' ? p.notation : null,
        price: p.price && p.price !== 'unknown' ? p.price : null,
        priceText,
        cat1: p.product_cat1 || null,
        cat2: p.product_cat2 || null,
        cat3: p.product_cat3 || null,
        url: link ? new URL(link.getAttribute('href'), location.origin).href : null,
        addable,
        inCart,
        available: !/bient[oô]t disponible|indisponible|rupture/i.test(priceText),
      };
    });
  });
}

export async function search(page, query) {
  await page.goto(SEARCH_URL(query), { waitUntil: 'domcontentloaded' });
  // tc_vars est posé par le tag analytics, juste après le rendu des tuiles.
  await page.waitForFunction(
    () => window.tc_vars && Array.isArray(window.tc_vars.products),
    { timeout: 12000 },
  ).catch(() => {});
  // Les bandeaux cookies se reposent à chaque navigation : on les neutralise
  // ici, une fois, plutôt que de les subir au moment du clic.
  await acceptCookies(page);
  await dismissOverlays(page);
  const products = await readProducts(page);
  const total = await page.evaluate(() => (window.tc_vars || {}).internal_search_results || 0);
  return { query, total, products };
}

/**
 * Classe les candidats pour une ligne de liste de courses.
 * Le score mêle quatre signaux, l'historique dominant volontairement le reste :
 * un produit déjà acheté plusieurs fois est presque toujours le bon.
 */
export function rank(candidates, { wanted, prefs, expectedCat1 = null }) {
  const products = prefs?.products || {};
  // Marques réellement achetées, pour départager deux produits équivalents.
  const brandScore = {};
  for (const p of Object.values(products)) {
    const b = normalize(p.label).split(' ')[0];
    if (b) brandScore[b] = (brandScore[b] || 0) + p.count;
  }

  return candidates
    .map((c) => {
      const hist = products[c.itemid];
      const nameSim = similarity(wanted, c.name);
      // Pas de plancher : un produit acheté UNE fois ne doit pas peser autant
      // qu'un habituel. Avec un plancher à 0,5, un balsamique acheté une seule
      // fois battait un « vinaigre de vin » pourtant bien mieux nommé.
      const histScore = hist ? Math.min(1, hist.confidence) : 0;
      const ratingScore = c.rating ? (c.rating - 3) / 2 : 0; // 3/5 neutre, 5/5 = +1
      const brandBoost = brandScore[normalize(c.brand).split(' ')[0]] ? 0.08 : 0;

      // Cohérence de rayon. Le texte seul ne distingue pas « Banane Cavendish »
      // de « Banana bread », ni « Citron vert » d'un thon au citron vert : les
      // mots demandés sont présents dans les deux. Le rayon, lui, tranche — et
      // on le déduit du produit que l'utilisateur achète réellement, pas d'une liste
      // de mots écrite à la main.
      let catAdjust = 0;
      if (expectedCat1 && c.cat1) {
        catAdjust = normalize(c.cat1) === normalize(expectedCat1) ? 0.18 : -0.45;
      }

      const score =
        0.34 * histScore +
        0.42 * nameSim +
        0.08 * Math.max(0, Math.min(1, ratingScore)) +
        brandBoost +
        catAdjust -
        (c.addable ? 0 : 0.40) -
        (c.available ? 0 : 0.25);

      return {
        ...c,
        score: Number(score.toFixed(4)),
        inHistory: Boolean(hist),
        historyCount: hist?.count || 0,
        nameSim: Number(nameSim.toFixed(3)),
        catMatch: expectedCat1 ? catAdjust > 0 : null,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Écarte les doublons catalogue : le site publie parfois le même produit sous
 * plusieurs identifiants (lots, calibres), au libellé strictement identique.
 * Les proposer tous deux ne pose qu'une fausse question — on garde le moins
 * cher, à défaut le mieux noté.
 */
function dedoublonner(liste) {
  const par = new Map();
  for (const c of liste) {
    const cle = normalize(c.name);
    const garde = par.get(cle);
    if (!garde) { par.set(cle, c); continue; }
    const prixA = c.price ?? Infinity;
    const prixB = garde.price ?? Infinity;
    if (prixA < prixB || (prixA === prixB && (c.rating || 0) > (garde.rating || 0))) par.set(cle, c);
  }
  return [...par.values()].sort((a, b) => b.score - a.score);
}

/**
 * Décide : achat direct, question à poser, ou introuvable.
 * Les seuils sont volontairement prudents — une erreur de panier coûte plus cher
 * qu'une question.
 */
export function decide(ranked, { wanted }) {
  const usable = dedoublonner(ranked.filter((c) => c.addable));
  if (!usable.length) return { action: 'not_found', wanted, options: ranked.slice(0, 3) };

  const [best, second] = usable;

  // Déjà acheté et le libellé colle : aucun doute.
  if (best.inHistory && best.historyCount >= 2 && best.nameSim >= 0.55) {
    return { action: 'add', pick: best, reason: `acheté ${best.historyCount}x` };
  }
  // Bon libellé, bon rayon, et nettement devant le suivant.
  const margin = second ? best.score - second.score : 1;
  if (best.nameSim >= 0.80 && best.catMatch !== false && margin >= 0.10) {
    return { action: 'add', pick: best, reason: 'correspondance forte' };
  }
  // Sinon on demande, avec au plus trois options lisibles.
  return { action: 'ask', wanted, options: usable.slice(0, 3) };
}
