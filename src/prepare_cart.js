// src/prepare_cart.js — pipeline principal : note Apple -> panier Super U.
//
// Enchaînement : lire la liste, la faire interpréter par l'IA, résoudre chaque
// ligne contre l'historique puis le catalogue, faire arbitrer ce qui reste,
// remplir le panier, RELIRE le panier, écrire le bilan, poser les questions
// restantes sur Telegram.
//
// Le panier est rempli, jamais validé : aucun paiement n'est déclenché ici.

import fs from 'fs';
import 'dotenv/config';
import { PREFS_PATH, BILAN_PATH, QUESTIONS_PATH, DATA_DIR } from './lib/paths.js';
import { openBrowser, closeBrowser, ensureLoggedIn } from './lib/session.js';
import { readShoppingListFresh } from './lib/notes.js';
import { search, rank, decide, candidats, quantitePour, RAYONS } from './lib/catalog.js';
import { addFromSearch, readCart, removeFromCart } from './lib/cart.js';
import { sendTelegram } from './lib/telegram.js';
import { similarity, normalize } from './lib/normalize.js';
import { planifier, arbitrer, relirePanier } from './lib/judge.js';
import { developper } from './lib/lexique.js';
import path from 'path';

/** Option de question, telle qu'enregistrée dans questions.v2.json. */
function versOption(o, voulu = 1) {
  return {
    itemid: o.itemid, name: o.name, brand: o.brand, price: o.price,
    rating: o.rating, cat1: o.cat1, cat2: o.cat2, historyCount: o.historyCount, inCart: o.inCart,
    // Exemplaires à ajouter si l'option est retenue : une barquette, pas quatre, pour « Poire x4 ».
    quantity: quantitePour(o.name, voulu),
  };
}

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

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
  // Le rayon d'une banane bio est celui d'une banane : l'exigence bio ne
  // compte pas ici.
  for (const p of favorites) {
    if (!p.cat1) continue;
    const s = similarity(wanted, p.name, { bio: false });
    if (!best || s > best.sim) best = { cat1: p.cat1, sim: s };
  }
  for (const p of Object.values(prefs.products || {})) {
    if (!p.cat1) continue;
    const s = similarity(wanted, p.label, { bio: false });
    if (!best || s > best.sim) best = { cat1: p.cat1, sim: s };
  }
  return best && best.sim >= 0.5 ? best.cat1 : null;
}

/** Rayons proposés à l'interprétation : ceux du site, plus ceux vus dans l'historique. */
function rayonsConnus(favorites, prefs) {
  const vus = [...favorites, ...Object.values(prefs.products || {})].map((p) => p.cat1).filter(Boolean);
  return [...new Set([...RAYONS, ...vus])].filter((r) => normalize(r) !== 'bio');
}

/**
 * Ce qu'on cherche pour une ligne, et comment classer les résultats.
 * L'interprétation de l'IA, quand elle existe, prime sur le texte de la liste :
 * c'est « sel fin » qu'on compare aux libellés, pas « Salt » — qui rapprochait
 * un beurre aux cristaux de sel déjà acheté.
 */
function contexte(item, { prefs, favorites }) {
  const plan = item.plan || null;
  const cible = plan?.produit || item.wanted;
  // Une ligne issue de l'expansion saisonnière est un produit frais par
  // construction : on impose le rayon (sans ça, « poire » proposait des poires
  // au sirop en boîte). Celui de l'interprétation n'est qu'indicatif. À défaut,
  // on le déduit de l'historique, comme avant l'interprétation.
  let rayon = null;
  let rayonCertain = false;
  if (item.saison) { rayon = 'Fruits et Légumes'; rayonCertain = true; }
  else if (plan) rayon = plan.rayon;
  else { rayon = expectedCategory(item.wanted, favorites, prefs); rayonCertain = Boolean(rayon); }
  return {
    cible,
    rayon,
    rayonCertain,
    requetes: plan?.requetes?.length ? plan.requetes : [item.wanted],
    classer: (produits) => rank(produits, { wanted: cible, prefs, expectedCat1: rayon, rayonIndicatif: !rayonCertain }),
  };
}

/**
 * Décision par les seules règles : ce que fait le bot sans IA, ou quand
 * l'arbitre ne répond pas.
 */
function regleDe(item, ranked, fav, recherche) {
  const exact = fav && ranked.find((c) => c.itemid === fav.product.itemid && c.addable);
  if (exact) {
    return { action: 'add', pick: exact, reason: `déjà acheté (conf ${fav.conf.toFixed(2)}, sim ${fav.sim.toFixed(2)})`, sur: true };
  }
  const decision = decide(ranked, { wanted: recherche.cible });
  // Une ligne de saison ne se discute pas : demander « quelle variété de
  // poire ? » va contre l'intention même de « 3 fruits de saison ».
  // Le classement a déjà placé en tête ce qui colle au rayon et aux
  // habitudes — on le prend.
  if (item.saison && decision.action === 'ask' && decision.options.length) {
    return { action: 'add', pick: decision.options[0], reason: `${item.saison.type} de ${item.saison.mois}` };
  }
  return decision;
}

/**
 * Candidats soumis à l'arbitre : les mieux classés, la tête de chaque seconde
 * recherche, puis les meilleurs libellés quel que soit leur rang. Le rayon
 * deviné par l'IA peut se tromper — le site range le paprika en fruits et
 * légumes — et les chips au paprika prenaient alors toutes les places, même
 * après une recherche « paprika doux moulu » qui avait trouvé le bon produit.
 */
function pourArbitre(ranked, prioritaires = []) {
  const tous = candidats(ranked, Infinity);
  const lot = tous.slice(0, 8);
  const ajouter = (c) => { if (c && !lot.includes(c) && lot.length < 12) lot.push(c); };
  prioritaires.forEach((id) => ajouter(tous.find((c) => c.itemid === id)));
  [...tous].sort((a, b) => b.nameSim - a.nameSim).filter((c) => !lot.includes(c)).slice(0, 3).forEach(ajouter);
  return lot;
}

const guillemets = (liste) => liste.map((r) => `« ${r} »`).join(', ');

async function main() {
  // Mode simulation : parcourt toute la chaîne (recherche, classement, décision,
  // arbitrage) contre le site réel sans jamais cliquer « ajouter ». Sert à
  // valider le pipeline sans toucher à un panier déjà constitué.
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('[SIMULATION] Aucun ajout ne sera effectué.\n');

  const listFile = process.argv.includes('--from-file')
    ? path.join(DATA_DIR, 'prochain_supermarche.txt')
    : null;

  const { items, modifiedAt: noteModifiee } = await readShoppingListFresh(listFile ? { fromFile: listFile } : {});
  if (noteModifiee) console.log(`[NOTE] Dernière modification : ${noteModifiee.toLocaleString('fr-FR')}.`);
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

  // Interprétation par l'IA, en un appel pour toute la liste. Le site cherche
  // mot à mot et en français : « Red onion » y ramenait du Red Bull, « Salt »
  // des chips au sel, « Carrottes » des carottes en boîte. Sans IA, chaque
  // ligne est cherchée telle qu'écrite, comme avant.
  const aInterpreter = items.filter((it) => !it.pinnedItemId && !it.saison);
  let ia = false;
  if (aInterpreter.length) {
    console.log(`[INTERPRÉTATION] ${aInterpreter.length} ligne(s) soumise(s) à l'IA...`);
    const { plans, meta } = await planifier(aInterpreter, { rayons: rayonsConnus(favorites, prefs) });
    ia = Boolean(meta && !meta.erreur);
    if (!ia) console.log(`  [interprétation] indisponible (${meta?.erreur}) — recherche mot à mot.\n`);
    aInterpreter.forEach((it, k) => {
      if (!plans[k]) return;
      it.plan = plans[k];
      if (normalize(it.plan.produit) !== normalize(it.wanted)) {
        console.log(`  ${it.wanted} → ${it.plan.produit} (${guillemets(it.plan.requetes)})`);
      }
    });
    if (ia) console.log(`[INTERPRÉTATION] ${meta.interpretees} ligne(s) comprise(s) (${meta.ms} ms).\n`);

    // Une ligne de saison mal écrite (« Seconal fruits ») échappe au motif de
    // lexique.js : l'interprétation la reconnaît, on la développe ici.
    const developpees = [];
    for (const it of items) {
      if (!it.plan?.saison) { developpees.push(it); continue; }
      const nombre = /^(\d+)\s/.exec(it.wanted)?.[1];
      const canon = `${nombre ? `${nombre} ` : ''}${it.plan.saison === 'legumes' ? 'légumes' : 'fruits'} de saison`;
      const { lignes } = developper(
        [{ raw: it.raw, wanted: canon, quantity: it.quantity, sizeHint: null }],
        { prefs, exclure: items.map((x) => x.wanted) },
      );
      if (!lignes[0]?.saison) { developpees.push(it); continue; }
      developpees.push(...lignes);
      const t = lignes[0].saison;
      journal.push(`« ${it.wanted} » → ${lignes.map((l) => l.wanted).join(', ')} (${t.type}s de ${t.mois})`);
    }
    items.length = 0;
    items.push(...developpees);
  }

  const { page } = await openBrowser();
  const bilan = [];

  /** Ajoute un produit ; `requete` d'abord quand la page courante n'en montre pas la tuile. */
  async function ajouter(line, pick, quantite, raison, requete = null) {
    let r = { ok: true };
    if (!dryRun) {
      if (requete) await search(page, requete);
      r = await addFromSearch(page, pick.itemid, quantite);
    }
    line.status = r.ok ? 'added' : 'click_failed';
    line.pick = pick;
    line.addedQuantity = quantite;
    line.reason = r.ok ? raison : r.reason;
    return r.ok;
  }

  /** Met la ligne en question. Seules des options plausibles sont proposées. */
  function poser(line, options, note = null) {
    line.status = 'question';
    line.pick = null;
    line.options = options;
    line.note = note;
  }

  const enLog = (line) => `${line.wanted} -> ${line.pick.name.slice(0, 46)}${line.addedQuantity > 1 ? ` x${line.addedQuantity}` : ''}`;

  try {
      const ctx = await ensureLoggedIn(page, { notify: sendTelegram });
      console.log(`[PANIER] Magasin ${ctx.storeName}, panier ${ctx.basketId}.`);

      const aArbitrer = [];
      for (const item of items) {
        const line = { ...item, status: null, pick: null, reason: null };
        try {

        // 0. Référence épinglée par le vocabulaire maison : aucun doute possible.
        if (item.pinnedItemId) {
          const res = await search(page, item.wanted);
          const cible = res.products.find((c) => c.itemid === item.pinnedItemId && c.addable);
          if (cible) {
            const ok = await ajouter(line, cible, item.quantity, 'référence épinglée (vocabulaire)');
            console.log(`  ${ok ? '📌' : '⚠️'} ${item.wanted} -> ${cible.name.slice(0, 46)} (épinglé)`);
            bilan.push(line);
            continue;
          }
          console.log(`  ⚠️  ${item.wanted} : référence épinglée ${item.pinnedItemId} introuvable, recherche normale.`);
        }

        const recherche = contexte(item, { prefs, favorites });
        const requete = recherche.requetes[0];
        // Produit déjà acheté qui ressemble à la ligne — ou à son interprétation :
        // c'est « sel fin » qu'on rapproche de l'historique, pas « Salt ».
        const fav = matchConnu(recherche.cible, prefs);

        if (ia) {
          // 1. Avec l'IA, rien ne part au panier sans l'arbitre, pas même un
          // produit déjà acheté. Sur le libellé seul, « Salt » donnait un beurre
          // aux cristaux de sel acheté avant, « Lamb mince » de la viande hachée
          // de bœuf achetée 4 fois, « Riz noir » une galette de riz au chocolat
          // noir. L'historique reste un argument : le produit acheté rejoint les
          // candidats, avec le nombre d'achats, et l'arbitre le préfère à
          // qualité égale.
          const res = await search(page, requete);
          let produits = res.products;
          if (fav && !produits.some((c) => c.itemid === fav.product.itemid)) {
            const res2 = await search(page, fav.product.name);
            produits = [...produits, ...res2.products.filter((c) => c.itemid === fav.product.itemid)];
          }
          const ranked = recherche.classer(produits);
          line.status = 'question';
          aArbitrer.push({ line, item, recherche, ranked, regle: regleDe(item, ranked, fav, recherche), requetes: [requete] });
          console.log(`  🔎 ${item.wanted}${normalize(requete) !== normalize(item.wanted) ? ` (« ${requete} »)` : ''} : ${pourArbitre(ranked).length} candidat(s) pour l'arbitre.`);
          bilan.push(line);
          continue;
        }

        // 1. Sans IA : raccourci par le corpus connu.
        let ranked = null;
        let decision = null;
        if (fav) {
          // On passe quand même par la recherche pour obtenir une tuile cliquable.
          const res = await search(page, fav.product.name);
          ranked = recherche.classer(res.products);
          decision = regleDe(item, ranked, fav, recherche);
          if (!decision.sur) decision = null;
        }

        // 2. Sinon recherche catalogue classique.
        if (!decision) {
          const res = await search(page, requete);
          ranked = recherche.classer(res.products);
          decision = regleDe(item, ranked, null, recherche);
        }

        if (!item.saison && !decision.sur && decision.action === 'ask') {
          // 3. L'arbitre seul peut encore départager, si l'interprétation a
          // échoué sans qu'il soit hors service.
          line.status = 'question';
          aArbitrer.push({ line, item, recherche, ranked, regle: decision, requetes: [requete] });
        } else if (decision.action === 'add') {
          const ok = await ajouter(line, decision.pick, quantitePour(decision.pick.name, item.quantity), decision.reason);
          console.log(`  ${ok ? '✅' : '⚠️'} ${enLog(line)} (${decision.reason})`);
        } else {
          line.status = 'not_found';
          line.reason = `cherché ${guillemets([requete])}`;
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

    // Arbitrage, en un appel pour toutes les lignes en attente. Ne sont
    // proposées à l'utilisateur que les options que l'arbitre juge plausibles :
    // plus de Red Bull pour « Red onion ». Quand aucune option ne convient, la
    // ligne est recherchée une seconde fois (autre requête de l'interprétation,
    // ou celle que suggère l'arbitre) avant toute question, puis rearbitrée
    // avec les candidats des deux recherches. Si l'arbitre ne répond pas, les
    // règles reprennent la main, comme sans IA.
    const arbitrage = [];
    let enAttente = aArbitrer;
    for (let tour = 1; enAttente.length; tour++) {
      enAttente.forEach((e, k) => {
        const { item } = e;
        e.question = {
          index: k + 1,
          wanted: item.wanted,
          produit: item.saison ? `${item.wanted} frais, ${item.saison.type} de saison` : item.plan?.produit || null,
          quantity: item.quantity,
          sizeHint: item.sizeHint,
          expectedCat1: e.recherche.rayon,
          rayonCertain: e.recherche.rayonCertain,
          options: pourArbitre(e.ranked, e.prioritaires).map((o) => versOption(o, item.quantity)),
        };
      });
      const soumises = enAttente.filter((e) => e.question.options.length);
      let r = { decisions: new Map(), plausibles: new Map(), relances: new Map(), raisons: new Map(), meta: null };
      if (soumises.length) {
        console.log(`\n[ARBITRE] ${soumises.length} ligne(s) soumise(s) à l'IA${tour > 1 ? ' après une seconde recherche' : ''}...`);
        r = await arbitrer(soumises.map((e) => e.question));
        arbitrage.push(r.meta);
        if (!r.meta.erreur) {
          console.log(`[ARBITRE] ${r.meta.tranchees} tranchée(s), ${r.meta.laissees} laissée(s) (${r.meta.ms} ms).`);
          if (r.meta.rejets.length) console.log(`  écartés : ${r.meta.rejets.join(' · ')}`);
        }
      }

      const relances = [];
      for (const e of enAttente) {
        const { line, item, question: q } = e;
        try {
          if (q.options.length && (r.meta?.erreur || r.meta?.muettes?.has(q.index))) {
            // Repli sur les règles : ce que faisait le bot avant l'IA.
            const { regle } = e;
            if (regle.action === 'add') {
              const ok = await ajouter(line, regle.pick, quantitePour(regle.pick.name, item.quantity), regle.reason, regle.pick.name);
              console.log(`  ${ok ? '✅' : '⚠️'} ${enLog(line)} (${regle.reason})`);
            } else if (regle.action === 'ask') {
              poser(line, regle.options.map((o) => versOption(o, item.quantity)));
            } else {
              line.status = 'not_found';
            }
            continue;
          }

          const d = r.decisions.get(q.index);
          const opt = d && q.options.find((o) => o.itemid === d.itemid);
          const pourquoi = d && `${d.doute ? `${d.doute}, ` : ''}conf ${d.confiance} : ${d.raison}`;
          if (opt && await ajouter(line, opt, d.quantite ?? opt.quantity, `arbitre (${pourquoi})`, opt.name)) {
            console.log(`  🤖 ${enLog(line)} (${pourquoi})`);
            continue;
          }

          // Pas tranché : les autres requêtes avant de déranger l'utilisateur
          // (celle de l'arbitre, puis celles de l'interprétation). « lardons
          // bio » peut trouver ce que « lardons fumés bio » a manqué.
          const autres = tour === 1
            ? [r.relances.get(q.index), ...e.recherche.requetes]
              .filter((x, k, tout) => x && tout.findIndex((y) => y && normalize(y) === normalize(x)) === k)
              .filter((x) => !e.requetes.some((y) => normalize(y) === normalize(x)))
              .slice(0, 2)
            : [];
          if (autres.length) {
            for (const autre of autres) {
              e.requetes.push(autre);
              const res = await search(page, autre);
              e.prioritaires = [...(e.prioritaires || []), ...candidats(e.recherche.classer(res.products), 4).map((c) => c.itemid)];
              const vus = new Set(e.ranked.map((c) => c.itemid));
              e.ranked = e.recherche.classer([...e.ranked, ...res.products.filter((c) => !vus.has(c.itemid))]);
            }
            e.regle = regleDe(item, e.ranked, null, e.recherche);
            relances.push(e);
            console.log(`  🔁 ${item.wanted} : pas tranché, nouvelle recherche ${guillemets(autres)}.`);
            continue;
          }

          // Une ligne que l'arbitre a passée sous silence garde ses meilleurs
          // candidats ; une ligne qu'il a examinée ne garde que ce qu'il juge
          // plausible, avec la quantité qu'il a calculée pour chaque option.
          const plausibles = r.plausibles.has(q.index)
            ? r.plausibles.get(q.index)
              .map((p) => {
                const o = q.options.find((x) => x.itemid === p.itemid);
                return o && { ...o, quantity: p.quantite ?? o.quantity };
              })
              .filter(Boolean)
            : q.options.slice(0, 3);
          if (plausibles.length && item.saison) {
            // Une ligne de saison ne pose pas de question : le plus plausible.
            const ok = await ajouter(line, plausibles[0], plausibles[0].quantity, `${item.saison.type} de ${item.saison.mois}`, plausibles[0].name);
            console.log(`  ${ok ? '🍂' : '⚠️'} ${enLog(line)} (${item.saison.type} de ${item.saison.mois})`);
          } else if (plausibles.length) {
            poser(line, plausibles, r.raisons.get(q.index));
            console.log(`  ❓ ${item.wanted} : ${plausibles.length} option(s) plausible(s), question posée.`);
          } else {
            line.status = 'not_found';
            line.reason = `${r.raisons.get(q.index) || 'rien de plausible'} (cherché ${guillemets(e.requetes)})`;
            console.log(`  ❌ ${item.wanted} : ${line.reason}.`);
          }
        } catch (err) {
          line.status = 'error';
          line.reason = String(err.message).slice(0, 140);
          console.log(`  ⚠️  ${item.wanted} : ${line.reason}`);
        }
      }
      enAttente = relances;
    }

    // Relecture du panier : c'est elle qui fait foi, pas les clics.
    let cart = dryRun
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
    console.log(dryRun ? '\n[SIMULATION] Relecture ignorée (panier non modifié).' : '\n[RELECTURE] Vérification du panier par l\'IA...');
    const revue = dryRun ? { verdict: 'simulation', anomalies: [] } : await relirePanier({ items, cart });
    if (revue.verdict === 'ok') console.log('[RELECTURE] Panier conforme à la liste.');
    else if (revue.anomalies.length) revue.anomalies.forEach((a) => console.log(`  ⚠️  ${a}`));
    else console.log(`[RELECTURE] ${revue.verdict}${revue.erreur ? ' : ' + revue.erreur : ''}`);

    // Correction : une anomalie qui vise une ligne ajoutée seule par le bot pendant
    // ce run est défaite — l'article est retiré et la ligne repart en question.
    // Avant, la relecture signalait le problème et le laissait au panier.
    // Hors champ, volontairement : les références épinglées par le vocabulaire
    // (choix explicite de l'utilisateur), les lignes de saison (elles ne posent
    // jamais de question), et tout article déjà au panier avant le run — il a
    // pu y être mis à la main.
    const corrections = [];
    if (!dryRun && revue.verdict === 'problemes') {
      const vues = new Set();
      for (const a of revue.details || []) {
        const k = a.ligne - 1;
        const line = bilan[k];
        const item = items[k];
        if (!line || !item || vues.has(k)) continue;
        if (line.status !== 'added' || !line.pick) continue;
        if (item.saison || String(line.reason).startsWith('référence épinglée')) continue;
        if (line.pick.inCart) continue;
        vues.add(k);

        const retire = line.pick;
        const r = await removeFromCart(page, retire.itemid, line.addedQuantity || item.quantity || 1);
        if (!r.ok) {
          console.log(`  ⚠️  ${item.wanted} : retrait impossible (${r.reason}), laissé au panier.`);
          continue;
        }
        // Sans nouvel arbitrage, on ne garde que des libellés proches de la
        // demande : proposer n'importe quoi est précisément ce qu'on corrige.
        const recherche = contexte(item, { prefs, favorites });
        const res = await search(page, recherche.requetes[0]);
        const options = candidats(recherche.classer(res.products), 8)
          .filter((c) => c.itemid !== retire.itemid && c.nameSim >= 0.5)
          .slice(0, 3);
        line.pick = null;
        line.addedQuantity = null;
        if (options.length) poser(line, options.map((o) => versOption(o, item.quantity)));
        else line.status = 'not_found';
        line.reason = `retiré après relecture : ${a.probleme}`;
        corrections.push(`${retire.name.slice(0, 46)} retiré — ${a.probleme}`);
        console.log(`  🔧 ${item.wanted} : ${retire.name.slice(0, 46)} retiré, ${options.length ? 'question posée' : 'aucune autre option'}.`);
      }
      if (corrections.length) {
        // Le panier a changé : le bilan doit décrire le panier réel.
        cart = await readCart(page);
        const corrigees = new Set([...vues].map((k) => k + 1));
        revue.anomalies = (revue.details || []).filter((a) => !corrigees.has(a.ligne)).map((a) => a.probleme);
        if (!revue.anomalies.length) revue.verdict = 'corrige';
      }
    }

    // Les questions suivent l'ordre de la liste, quel que soit le moment où
    // elles sont nées (arbitrage, seconde recherche, correction).
    const questions = bilan
      .filter((l) => l.status === 'question' && l.options?.length)
      .map((l, i) => ({ index: i + 1, wanted: l.wanted, quantity: l.quantity, note: l.note || null, options: l.options }));

    // En simulation on n'écrase pas le bilan du dernier vrai run.
    if (!dryRun) {
      fs.writeFileSync(BILAN_PATH, JSON.stringify({ ranAt: new Date().toISOString(), cart, lines: bilan, arbitrage, revue, corrections }, null, 2));
    }
    if (!dryRun) fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(questions, null, 2));

    const added = bilan.filter((l) => l.status === 'added').length;
    const errored = bilan.filter((l) => l.status === 'error').length;
    const absent = bilan.filter((l) => l.status === 'clicked_but_absent').length;
    const introuvables = bilan.filter((l) => l.status === 'not_found');

    const nbPanier = cart.declaredCount ?? cart.items.length;
    let msg = `🛒 Panier préparé (${nbPanier} articles, ${cart.amount ?? '?'} €)\n`;
    // L'heure de la note lue permet de voir d'un coup d'œil si un ajout de
    // dernière minute a été pris en compte.
    if (noteModifiee) {
      msg += `📝 Liste lue telle que modifiée le ${noteModifiee.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}\n`;
    }
    msg += `✅ ${added} ajoutés · ❓ ${questions.length} questions · ⚠️ ${absent} à revérifier · ❌ ${introuvables.length} introuvables`;
    if (errored) msg += ` · 💥 ${errored} en erreur`;
    if (journal.length) {
      msg += `\n\n📖 Traductions :\n` + journal.map((j) => `• ${j}`).join('\n');
    }
    if (corrections.length) {
      msg += `\n\n🔧 Corrigé après relecture (retiré du panier, question ci-dessous) :\n` + corrections.map((c) => `• ${c}`).join('\n');
    }
    if (revue.verdict === 'problemes' && revue.anomalies.length) {
      msg += `\n\n🔎 Relecture :\n` + revue.anomalies.map((a) => `• ${a}`).join('\n');
    }
    if (introuvables.length) {
      msg += `\n\n❌ Introuvables :\n` + introuvables.map((l) => `• ${l.wanted}${l.reason ? ` — ${l.reason}` : ''}`).join('\n');
    }
    if (questions.length) {
      msg += '\n\n';
      for (const q of questions) {
        msg += `${q.index}. ${q.wanted}${q.note ? ` — ${q.note}` : ''}\n`;
        q.options.forEach((o, i) => {
          msg += `   ${'abc'[i]}) ${o.name.slice(0, 55)}${o.price ? ` — ${o.price} €` : ''}${o.quantity > 1 ? ` (x${o.quantity})` : ''}\n`;
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
