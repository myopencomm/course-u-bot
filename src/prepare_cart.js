// src/prepare_cart.js — pipeline principal : note Apple -> panier Super U.
//
// Enchaînement : lire la liste, résoudre chaque ligne contre l'historique puis
// le catalogue, remplir le panier, RELIRE le panier, écrire le bilan, poser les
// questions restantes sur Telegram.
//
// Le panier est rempli, jamais validé : aucun paiement n'est déclenché ici.

import fs from 'fs';
import 'dotenv/config';
import { PREFS_PATH, BILAN_PATH, QUESTIONS_PATH, DATA_DIR } from './lib/paths.js';
import { openBrowser, closeBrowser, ensureLoggedIn } from './lib/session.js';
import { readShoppingList } from './lib/notes.js';
import { search, rank, decide } from './lib/catalog.js';
import { addFromSearch, readCart } from './lib/cart.js';
import { sendTelegram } from './lib/telegram.js';
import { similarity } from './lib/normalize.js';
import { arbitrer, relirePanier } from './lib/judge.js';
import { developper } from './lib/lexique.js';
import path from 'path';

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/**
 * Cherche d'abord dans les achats récents du compte : les produits que
 * l'utilisateur achète réellement, avec leur itemid. Un match ici évite une recherche
 * catalogue entière et se trompe beaucoup moins qu'une requête texte.
 */
/**
 * Cherche la ligne dans TOUT le corpus connu — historique de commandes ET achats
 * récents du site — et non dans les seuls favoris.
 *
 * La méthode est en deux temps, et c'est essentiel : on filtre d'abord sur le
 * libellé (seuil élevé, ce raccourci ajoute sans demander), puis on classe les
 * survivants par confiance d'achat. « Parmi ce qui correspond aux mots, prendre
 * ce que l'utilisateur achète vraiment. »
 *
 * Une première version ne regardait que les favoris du site et retenait la
 * meilleure similarité : pour « Comté » elle choisissait un « Comté 6 mois U BIO »
 * jamais acheté (libellé plus court, donc mieux noté) au lieu du « Saut du Doubs
 * 24 mois » acheté 4 fois, dont dans la commande de la veille.
 */
function matchConnu(wanted, prefs) {
  const candidats = [];
  for (const p of Object.values(prefs.products || {})) {
    const sim = similarity(wanted, p.label);
    if (sim >= 0.80) candidats.push({ produit: p, sim, conf: p.confidence ?? 0 });
  }
  if (!candidats.length) return null;
  candidats.sort((a, b) => b.conf - a.conf || b.sim - a.sim);
  const meilleur = candidats[0];
  // Un produit jamais acheté ne justifie pas un ajout sans question.
  if (meilleur.conf < 0.25) return null;
  return { product: { itemid: meilleur.produit.itemid, name: meilleur.produit.label }, sim: meilleur.sim, conf: meilleur.conf };
}

/**
 * Rayon attendu pour une ligne de liste, déduit des produits que l'utilisateur achète
 * vraiment. C'est ce qui évite de proposer du banana bread pour « Banana » ou
 * un thon au citron vert pour « Citron vert » : le libellé correspond dans les
 * deux cas, le rayon non.
 */
function expectedCategory(wanted, favorites, prefs) {
  let best = null;
  for (const p of favorites) {
    if (!p.cat1) continue;
    const s = similarity(wanted, p.name);
    if (!best || s > best.sim) best = { cat1: p.cat1, sim: s };
  }
  for (const p of Object.values(prefs.products || {})) {
    if (!p.cat1) continue;
    const s = similarity(wanted, p.label);
    if (!best || s > best.sim) best = { cat1: p.cat1, sim: s };
  }
  return best && best.sim >= 0.5 ? best.cat1 : null;
}

async function main() {
  // Mode simulation : parcourt toute la chaîne (recherche, classement, décision,
  // arbitrage) contre le site réel sans jamais cliquer « ajouter ». Sert à
  // valider le pipeline sans toucher à un panier déjà constitué.
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('[SIMULATION] Aucun ajout ne sera effectué.\n');

  const listFile = process.argv.includes('--from-file')
    ? path.join(DATA_DIR, 'prochain_supermarche.txt')
    : null;

  const items = readShoppingList(listFile ? { fromFile: listFile } : {});
  if (!items.length) {
    console.log('Liste vide : rien à faire.');
    await sendTelegram('🛒 La section PROCHAIN SUPERMARCHÉ de la note est vide.');
    return;
  }
  console.log(`[LISTE] ${items.length} lignes à traiter.`);

  const prefs = loadJson(PREFS_PATH, { products: {} });
  const favorites = loadJson(path.join(DATA_DIR, 'achats_recents.json'), { products: [] }).products;

  // Vocabulaire maison et produits de saison, appliqués avant tout rapprochement.
  const { lignes: items2, journal } = developper(items, { prefs });
  if (journal.length) {
    console.log('[VOCABULAIRE]');
    journal.forEach((j) => console.log(`  ${j}`));
    console.log('');
  }
  items.length = 0;
  items.push(...items2);

  const { page } = await openBrowser();
  const bilan = [];
  const questions = [];

  try {
      const ctx = await ensureLoggedIn(page, { notify: sendTelegram });
      console.log(`[PANIER] Magasin ${ctx.storeName}, panier ${ctx.basketId}.`);

      for (const item of items) {
        const line = { ...item, status: null, pick: null, reason: null };
        try {

        // 0. Référence épinglée par le vocabulaire maison : aucun doute possible.
        if (item.pinnedItemId) {
          const res = await search(page, item.wanted);
          const cible = res.products.find((c) => c.itemid === item.pinnedItemId && c.addable);
          if (cible) {
            const r = dryRun ? { ok: true } : await addFromSearch(page, cible.itemid, item.quantity);
            line.status = r.ok ? 'added' : 'click_failed';
            line.pick = cible;
            line.reason = r.ok ? 'référence épinglée (vocabulaire)' : r.reason;
            console.log(`  ${r.ok ? '📌' : '⚠️'} ${item.wanted} -> ${cible.name.slice(0, 46)} (épinglé)`);
            bilan.push(line);
            continue;
          }
          console.log(`  ⚠️  ${item.wanted} : référence épinglée ${item.pinnedItemId} introuvable, recherche normale.`);
        }

        // 1. Raccourci par le corpus connu.
        const fav = matchConnu(item.wanted, prefs);
        // Une ligne issue de l'expansion saisonnière est un produit frais par
        // construction : on impose le rayon plutôt que de le deviner. Sans ça,
        // « poire » proposait des poires au sirop en boîte.
        const expectedCat1 = item.saison
          ? 'Fruits et Légumes'
          : expectedCategory(item.wanted, favorites, prefs);
        let ranked = null;
        let decision = null;

        if (fav) {
          // On passe quand même par la recherche pour obtenir une tuile cliquable.
          const res = await search(page, fav.product.name);
          ranked = rank(res.products, { wanted: item.wanted, prefs, expectedCat1 });
          const exact = ranked.find((c) => c.itemid === fav.product.itemid && c.addable);
          if (exact) decision = { action: 'add', pick: exact, reason: `déjà acheté (conf ${fav.conf.toFixed(2)}, sim ${fav.sim.toFixed(2)})` };
        }

        // 2. Sinon recherche catalogue classique.
        if (!decision) {
          const res = await search(page, item.wanted);
          ranked = rank(res.products, { wanted: item.wanted, prefs, expectedCat1 });
          decision = decide(ranked, { wanted: item.wanted });
        }

        // Une ligne de saison ne se discute pas : demander « quelle variété de
        // poire ? » va contre l'intention même de « 3 fruits de saison ».
        // Le classement a déjà placé en tête ce qui colle au rayon et aux
        // habitudes — on le prend.
        if (item.saison && decision.action === 'ask' && decision.options.length) {
          decision = { action: 'add', pick: decision.options[0], reason: `${item.saison.type} de ${item.saison.mois}` };
        }

        if (decision.action === 'add') {
          const r = dryRun ? { ok: true } : await addFromSearch(page, decision.pick.itemid, item.quantity);
          line.status = r.ok ? 'added' : 'click_failed';
          line.pick = decision.pick;
          line.reason = r.ok ? decision.reason : r.reason;
          console.log(`  ${r.ok ? '✅' : '⚠️'} ${item.wanted} -> ${decision.pick.name.slice(0, 50)} (${decision.reason})`);
        } else if (decision.action === 'ask') {
          line.status = 'question';
          questions.push({
            index: questions.length + 1,
            wanted: item.wanted,
            quantity: item.quantity,
            options: decision.options.map((o) => ({
              itemid: o.itemid, name: o.name, brand: o.brand, price: o.price,
              rating: o.rating, cat1: o.cat1, historyCount: o.historyCount,
            })),
          });
          console.log(`  ❓ ${item.wanted} : ${decision.options.length} options, question posée.`);
        } else {
          line.status = 'not_found';
          console.log(`  ❌ ${item.wanted} : introuvable.`);
        }

      } catch (err) {
        // Un article qui casse ne doit pas emporter toute la liste : on note
        // l'échec et on continue. La v1 perdait le run entier sur un seul clic
        // intercepté.
        line.status = 'error';
        line.reason = String(err.message).slice(0, 140);
        console.log(`  ⚠️  ${item.wanted} : ${line.reason}`);
      }

      bilan.push(line);
    }

    // Arbitrage des lignes que les règles n'ont pas tranchées. Un seul appel au
    // CLI Claude local pour toute la liste : ~20s, contre 20s par ligne si on
    // l'appelait à chaque fois. Ce qui reste sous le seuil de confiance part en
    // question à l'utilisateur, comme avant.
    let arbitrage = null;
    if (questions.length) {
      console.log(`\n[ARBITRE] ${questions.length} ligne(s) soumise(s) au CLI Claude...`);
      const { decisions, meta } = await arbitrer(questions);
      arbitrage = meta;
      const restantes = [];
      for (const q of questions) {
        const d = decisions.get(q.index);
        const opt = d && q.options.find((o) => o.itemid === d.itemid);
        if (!opt) { restantes.push(q); continue; }
        try {
          if (!dryRun) {
            await search(page, opt.name);
            const r = await addFromSearch(page, opt.itemid, q.quantity || 1);
            if (!r.ok) { restantes.push(q); continue; }
          }
          const ligne = bilan.find((l) => l.wanted === q.wanted && l.status === 'question');
          if (ligne) {
            ligne.status = 'added';
            ligne.pick = opt;
            ligne.reason = `arbitre ${d.confiance} — ${d.raison}`;
          }
          console.log(`  🤖 ${q.wanted} -> ${opt.name.slice(0, 46)} (conf ${d.confiance} : ${d.raison})`);
        } catch {
          restantes.push(q);
        }
      }
      questions.length = 0;
      restantes.forEach((q, i) => questions.push({ ...q, index: i + 1 }));
      if (meta && !meta.erreur) {
        console.log(`[ARBITRE] ${meta.tranchees} tranchée(s), ${meta.laissees} laissée(s) à l'utilisateur (${meta.ms} ms).`);
      }
    }

    // Relecture du panier : c'est elle qui fait foi, pas les clics.
    const cart = dryRun
      ? { source: 'simulation', amount: null, basketId: null, declaredCount: null, items: [] }
      : await readCart(page);
    const inCart = new Set(cart.items.map((i) => i.itemid));
    if (!dryRun) {
      for (const line of bilan) {
        if (line.status === 'added' && line.pick && !inCart.has(line.pick.itemid)) {
          line.status = 'clicked_but_absent';
        }
      }
    }

    // Relecture intelligente : le panier correspond-il vraiment à la demande ?
    // La vérification mécanique ci-dessus ne voit que des identifiants ; celle-ci
    // voit le sens (un jus à la place d'un fruit, une quantité aberrante).
    console.log(dryRun ? '\n[SIMULATION] Relecture ignorée (panier non modifié).' : '\n[RELECTURE] Vérification du panier par le CLI Claude...');
    const revue = dryRun ? { verdict: 'simulation', anomalies: [] } : await relirePanier({ items, cart });
    if (revue.verdict === 'ok') console.log('[RELECTURE] Panier conforme à la liste.');
    else if (revue.anomalies.length) revue.anomalies.forEach((a) => console.log(`  ⚠️  ${a}`));
    else console.log(`[RELECTURE] ${revue.verdict}${revue.erreur ? ' : ' + revue.erreur : ''}`);

    // En simulation on n'écrase pas le bilan du dernier vrai run.
    if (!dryRun) {
      fs.writeFileSync(BILAN_PATH, JSON.stringify({ ranAt: new Date().toISOString(), cart, lines: bilan, arbitrage, revue }, null, 2));
    }
    if (!dryRun) fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(questions, null, 2));

    const added = bilan.filter((l) => l.status === 'added').length;
    const errored = bilan.filter((l) => l.status === 'error').length;
    const absent = bilan.filter((l) => l.status === 'clicked_but_absent').length;
    const notFound = bilan.filter((l) => l.status === 'not_found').length;

    const nbPanier = cart.declaredCount ?? cart.items.length;
    let msg = `🛒 Panier préparé (${nbPanier} articles, ${cart.amount ?? '?'} €)\n`;
    msg += `✅ ${added} ajoutés · ❓ ${questions.length} questions · ⚠️ ${absent} à revérifier · ❌ ${notFound} introuvables`;
    if (errored) msg += ` · 💥 ${errored} en erreur`;
    if (journal.length) {
      msg += `\n\n📖 Traductions :\n` + journal.map((j) => `• ${j}`).join('\n');
    }
    if (revue.verdict === 'problemes' && revue.anomalies.length) {
      msg += `\n\n🔎 Relecture :\n` + revue.anomalies.map((a) => `• ${a}`).join('\n');
    }
    if (questions.length) {
      msg += '\n\n';
      for (const q of questions) {
        msg += `${q.index}. ${q.wanted}\n`;
        q.options.forEach((o, i) => {
          msg += `   ${'abc'[i]}) ${o.name.slice(0, 55)}${o.price ? ` — ${o.price} €` : ''}\n`;
        });
      }
      msg += '\nRéponds par ex. "1a 2b 3skip".';
    }
    console.log(`\n${msg}`);
    if (!dryRun) await sendTelegram(msg);
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
  await sendTelegram(`⚠️ Préparation du panier échouée : ${err.message}`).catch(() => {});
  process.exit(1);
});
