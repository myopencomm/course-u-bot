// src/lib/cart.js — ajout au panier et vérification de ce qui s'y trouve vraiment.
//
// Règle de fond héritée de la v1 et conservée : on remplit le panier, on ne
// valide JAMAIS la commande. Aucun paiement n'est déclenché par ce bot.
//
// Règle ajoutée : un clic réussi ne prouve rien. Le site accepte le clic puis
// rejette silencieusement l'article (rupture, quota, hors assortiment). On relit
// donc systématiquement le panier et c'est cette relecture qui fait foi.

import { CART_URL } from './paths.js';
import { acceptCookies, dismissOverlays } from './session.js';

// Relevé sur le site connecté : le bouton d'ajout est un div cliquable portant
// data-global-login-cta="productAddition" et data-pid=<itemid>. Une fois l'article
// au panier, la tuile bascule sur un stepper (__dec / input number / __inc) plus
// un bouton de suppression.
const ADD_SELECTORS = '[data-global-login-cta="productAddition"], .product-button__bag';
const INC_SELECTOR = '.product-button__inc';
const QTY_INPUT = 'input[type="number"]';

/** Ajoute un produit depuis la page de résultats courante. */
export async function addFromSearch(page, itemid, quantity = 1) {
  // Scope obligatoire : des carrousels rendent la même tuile ailleurs sur la page.
  const tile = page.locator(`#search-result-items .product-tile[data-itemid="${itemid}"]`).first();
  if (!(await tile.count())) return { ok: false, reason: 'tuile absente de la page' };

  const btn = tile.locator(ADD_SELECTORS).first();
  if (!(await btn.isVisible({ timeout: 3000 }).catch(() => false))) {
    return { ok: false, reason: 'bouton d ajout absent (produit non commandable)' };
  }

  // La tuile est amenée au CENTRE du viewport : les bandeaux cookies et l'en-tête
  // collant occupent le haut et le bas de l'écran, et scrollIntoViewIfNeeded
  // laissait régulièrement le bouton sous l'un des deux.
  await btn.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {});
  await page.waitForTimeout(200);

  // Trois tentatives de moins en moins délicates. Un clic bloqué coûtait 30s de
  // timeout par article : on échoue vite, puis on force.
  let clicked = false;
  try {
    await btn.click({ timeout: 5000 });
    clicked = true;
  } catch {
    await acceptCookies(page);
    await dismissOverlays(page);
    try {
      await btn.click({ timeout: 5000 });
      clicked = true;
    } catch {
      // Dernier recours : clic DOM direct, qui ignore le test de recouvrement.
      clicked = await btn.evaluate((el) => { el.click(); return true; }).catch(() => false);
    }
  }
  if (!clicked) return { ok: false, reason: 'bouton inatteignable (clic intercepté)' };
  await page.waitForTimeout(900);

  // Quantité > 1 : on re-clique le "+" plutôt que de saisir le champ, qui est
  // souvent contrôlé par un composant maison et ignore un fill().
  for (let i = 1; i < quantity; i++) {
    const plus = tile.locator(INC_SELECTOR).first();
    if (!(await plus.isVisible({ timeout: 1500 }).catch(() => false))) break;
    await plus.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  // La tuile affiche la quantité réellement retenue : on la relit plutôt que de
  // supposer que les clics ont tous porté.
  const applied = await tile.locator(QTY_INPUT).first().inputValue().catch(() => null);
  return { ok: true, quantityApplied: applied ? Number(applied) : null };
}

/**
 * Relit le panier réel. C'est la seule source de vérité du bilan.
 *
 * Le conteneur est `#cart-table`, et chaque ligne est un `.cart-row`.
 * Ce périmètre est indispensable : la page panier porte 131 éléments
 * `[data-itemid]` pour un panier de 5 articles — le reste vient des carrousels
 * de substitution et de suggestions. Deux tentatives précédentes ont échoué :
 * `tc_vars.products` y décrit 85 produits sans rapport, et filtrer sur la
 * présence d'un pas-à-pas de quantité laissait passer les mêmes carrousels.
 * La relecture par modèle recevait alors ~130 lignes sans libellé et signalait,
 * à juste titre, un panier incohérent.
 */
export async function readCart(page) {
  await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  return page.evaluate(() => {
    const v = window.tc_vars || {};
    const txt = document.body.innerText.replace(/\s+/g, ' ');
    const badge = txt.match(/Mon panier \((\d+)\)/);

    const lignes = [...document.querySelectorAll('#cart-table .cart-row')];
    const items = lignes.map((el) => {
      const qty = el.querySelector('input[type="number"]');
      const lien = el.querySelector('a[href*=".html"]');
      // Relevé sur une ligne réelle : le libellé est dans .product-name-link.
      const nom = el.querySelector('.product-name-link, .product-name, .pdp-link');
      const prix = (el.innerText.match(/(\d+[.,]\d{2})\s*€/) || [])[1];
      return {
        itemid: String(el.getAttribute('data-itemid') || ''),
        ean: el.getAttribute('data-item-ean') || null,
        name: (nom?.innerText || lien?.innerText || '').trim().replace(/\s+/g, ' '),
        quantity: qty ? Number(qty.value) || 1 : 1,
        price: prix ? Number(prix.replace(',', '.')) : null,
        // Un article peut être au panier ET indisponible ("Bientôt disponible") :
        // il ne sera pas livré. Le bloc .notavailable est présent dans CHAQUE
        // ligne et seulement affiché quand il s'applique — tester sa seule
        // existence marquait les 5 articles indisponibles à tort.
        unavailable: (() => {
          const n = el.querySelector('.notavailable');
          return Boolean(n && n.offsetParent !== null && /indisponible|bient/i.test(n.innerText || ''));
        })(),
      };
    }).filter((i) => i.itemid);

    return {
      source: 'cart-table',
      amount: typeof v.basket_amount === 'number' ? v.basket_amount : null,
      basketId: v.basket_id || null,
      declaredCount: badge ? Number(badge[1]) : null,
      items,
    };
  });
}

/**
 * Retire `quantity` unités d'un article depuis la page panier, avec le même
 * bouton « − » que vide-panier. Ne sert qu'à reprendre ce que le bot vient
 * lui-même d'ajouter : jamais un article déjà présent avant le run.
 * La page est rechargée à chaque clic, le stepper ne se met pas à jour seul.
 */
export async function removeFromCart(page, itemid, quantity = 1) {
  const ligne = (id) => {
    const l = document.querySelector(`#cart-table .cart-row[data-itemid="${id}"]`);
    if (!l) return { qty: 0 };
    const q = l.querySelector('input[type="number"]');
    return { qty: q ? Number(q.value) || 1 : 1 };
  };
  await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const avant = (await page.evaluate(ligne, itemid)).qty;
  if (!avant) return { ok: false, reason: 'article absent du panier' };
  const cible = Math.max(0, avant - quantity);

  for (let tour = 0; tour < quantity + 2; tour++) {
    const clic = await page.evaluate((id) => {
      const l = document.querySelector(`#cart-table .cart-row[data-itemid="${id}"]`);
      const dec = l?.querySelector('.product-button__dec');
      if (!dec) return false;
      dec.click();
      return true;
    }, itemid);
    if (!clic) break;
    await page.waitForTimeout(2000);
    await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    if ((await page.evaluate(ligne, itemid)).qty <= cible) return { ok: true };
  }
  const reste = (await page.evaluate(ligne, itemid)).qty;
  return reste <= cible ? { ok: true } : { ok: false, reason: `quantité restante ${reste}, attendue ${cible}` };
}
