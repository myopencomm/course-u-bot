// src/migrate_history.js — reconstruit les préférences à partir des snapshots bruts.
//
// Remplace parse_snapshots.js + build_preferences.js, qui perdaient le signal de
// fréquence : leur regex de date ne matchait jamais, tous les orderId tombaient à
// null puis étaient repliés sur 'unknown', si bien que chaque produit finissait
// avec count:1 quel que soit le nombre de commandes où il apparaissait.
//
// Clé primaire = itemid (présent dans chaque URL produit, et réutilisé par le site
// dans data-itemid et dans le bouton d'ajout au panier). L'EAN n'est pas dans les
// snapshots : il est renseigné plus tard, à la volée, depuis les pages de recherche.

import fs from 'fs';
import path from 'path';
import { DATA_DIR, PREFS_PATH } from './lib/paths.js';
import { normalize } from './lib/normalize.js';

const LINK_RE = /- link "([^"]+)"/;
const URL_RE = /\/url:\s*(\S+)/;
const ORDER_ID_RE = /N[ºo°]\s*(\d+)/i;

const ORDERS_DIR = path.join(DATA_DIR, 'orders');
const FAVORITES_PATH = path.join(DATA_DIR, 'achats_recents.json');

/** Commandes aspirées en ligne par sync_account.js (quantités réelles). */
function listHarvestedOrders() {
  if (!fs.existsSync(ORDERS_DIR)) return [];
  return fs.readdirSync(ORDERS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const o = JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, f), 'utf8'));
      return {
        orderId: String(o.orderId),
        filename: f,
        date: o.date || null,
        items: (o.products || []).map((p) => ({
          itemid: String(p.itemid),
          label: p.name,
          url: p.url || null,
          cgid: null,
          slug: null,
          quantity: p.quantity || 1,
          ean: p.ean || null,
        })),
      };
    });
}

function listSnapshots() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('order-') && f.endsWith('.snapshot.txt'))
    .sort();
}

/** Extrait { orderId, items[] } d'un snapshot d'accessibilité de page commande. */
function parseSnapshot(filename) {
  const text = fs.readFileSync(path.join(DATA_DIR, filename), 'utf8');
  const lines = text.split(/\r?\n/);

  // L'id de commande est dans l'en-tête ; à défaut, dans le nom du fichier.
  let orderId = null;
  for (const line of lines.slice(0, 5)) {
    const m = line.match(ORDER_ID_RE);
    if (m) { orderId = m[1]; break; }
  }
  if (!orderId) {
    const m = filename.match(/order-(\d+)/);
    orderId = m ? m[1] : filename;
  }

  const items = [];
  const seen = new Set(); // un produit listé 2x dans la même commande ne compte qu'une fois
  for (let i = 0; i < lines.length; i++) {
    const link = lines[i].match(LINK_RE);
    if (!link) continue;
    const label = link[1].trim();

    // L'URL est sur la ligne suivante dans le format snapshot.
    const urlLine = lines[i + 1] || '';
    const urlMatch = urlLine.match(URL_RE);
    if (!urlMatch) continue;
    const url = urlMatch[1].trim();

    const idMatch = url.match(/\/(\d+)\.html/);
    if (!idMatch) continue;
    const itemid = idMatch[1];
    if (seen.has(itemid)) continue;
    seen.add(itemid);

    const cgidMatch = url.match(/[?&]cgid=(\d+)/);
    const slugMatch = url.match(/\/p\/([^/]+)\/\d+\.html/);

    items.push({
      itemid,
      label,
      url: url.split('?')[0],
      cgid: cgidMatch ? cgidMatch[1] : null,
      slug: slugMatch ? slugMatch[1] : null,
    });
  }

  return { orderId, filename, items };
}

function main() {
  const files = listSnapshots();
  if (!files.length) {
    console.error('[ERREUR] Aucun snapshot order-*.snapshot.txt dans', DATA_DIR);
    process.exit(1);
  }

  // Deux sources de commandes : les vieux snapshots texte et les commandes
  // aspirées en ligne. Une même commande ne doit pas compter deux fois.
  const harvested = listHarvestedOrders();
  const harvestedIds = new Set(harvested.map((o) => o.orderId));
  const fromSnapshots = files.map(parseSnapshot).filter((o) => !harvestedIds.has(o.orderId));

  // Les numéros de commande Super U sont croissants : ils donnent la chronologie.
  const orders = [...fromSnapshots, ...harvested].sort((a, b) => Number(a.orderId) - Number(b.orderId));
  console.log(`[SOURCES] ${fromSnapshots.length} snapshots + ${harvested.length} commandes aspirées`);

  const products = {};
  const byName = {};

  orders.forEach((order, orderIndex) => {
    for (const item of order.items) {
      let p = products[item.itemid];
      if (!p) {
        p = products[item.itemid] = {
          itemid: item.itemid,
          ean: null, // renseigné en ligne, depuis tc_vars
          label: item.label,
          slug: item.slug,
          url: item.url,
          cgid: item.cgid,
          cat1Id: item.cgid ? item.cgid.slice(0, 4) : null,
          orders: [],
          count: 0,
          firstOrderIndex: orderIndex,
          lastOrderIndex: orderIndex,
          aliases: [],
        };
      }
      if (!p.orders.includes(order.orderId)) {
        p.orders.push(order.orderId);
        p.count += 1;
      }
      p.lastOrderIndex = orderIndex;
      // Le libellé le plus récent fait foi (le catalogue renomme régulièrement).
      p.label = item.label;
      if (item.cgid) { p.cgid = item.cgid; p.cat1Id = item.cgid.slice(0, 4); }

      const key = normalize(item.label);
      if (key && !p.aliases.includes(key)) p.aliases.push(key);
      byName[key] = item.itemid;
    }
  });

  // Les "achats récents" du site sont calculés sur TOUTES les commandes du compte
  // (58), bien au-delà des 3 encore consultables en ligne. C'est le meilleur
  // signal de récurrence disponible, et il apporte EAN, prix et note client.
  let favoriteCount = 0;
  if (fs.existsSync(FAVORITES_PATH)) {
    const fav = JSON.parse(fs.readFileSync(FAVORITES_PATH, 'utf8'));
    for (const p of fav.products || []) {
      const existing = products[p.itemid] || (products[p.itemid] = {
        itemid: p.itemid, label: p.name, slug: null, url: null, cgid: p.cgid || null,
        cat1Id: null, orders: [], count: 0, firstOrderIndex: 0, lastOrderIndex: orders.length - 1,
        aliases: [],
      });
      existing.ean = p.ean || existing.ean || null;
      existing.brand = p.brand || null;
      existing.price = p.price ?? null;
      existing.rating = p.rating ?? null;
      existing.cat1 = p.cat1 || null;
      existing.cat3 = p.cat3 || null;
      existing.siteFavorite = true;
      const key = normalize(p.name);
      if (key && !existing.aliases.includes(key)) existing.aliases.push(key);
      if (key) byName[key] = p.itemid;
      favoriteCount += 1;
    }
    console.log(`[SOURCES] + ${favoriteCount} achats récents du site (EAN, prix, note)`);
  }

  const total = orders.length;
  const dernierIndex = total - 1;
  for (const p of Object.values(products)) {
    const achete = p.count > 0;
    // Part des commandes contenant le produit.
    p.frequency = achete ? Number((p.count / total).toFixed(3)) : 0;
    // Récence : 1 = présent dans la dernière commande. Sans achat constaté,
    // la notion n'a pas de sens — on ne lui attribue pas une récence maximale.
    p.recency = achete && total > 1 ? Number((p.lastOrderIndex / (total - 1)).toFixed(3)) : 0;
    p.inLastOrder = achete && p.lastOrderIndex === dernierIndex;

    // Un produit listé dans les « achats récents » du site mais jamais vu dans
    // nos commandes ne vaut qu'un plancher modeste. Une première version lui
    // accordait +0,35, si bien qu'un comté JAMAIS acheté (count 0, conf 0,60)
    // battait celui acheté 4 fois dont la semaine précédente (conf 0,43).
    p.confidence = achete
      ? Number(Math.min(1,
          0.50 * p.frequency +
          0.20 * p.recency +
          0.20 * (p.inLastOrder ? 1 : 0) +
          0.10 * (p.siteFavorite ? 1 : 0),
        ).toFixed(3))
      : (p.siteFavorite ? 0.30 : 0.05);

    p.staple = p.count >= 3 || (p.siteFavorite && p.count >= 1);
  }

  const out = {
    version: 2,
    builtAt: new Date().toISOString(),
    orderCount: total,
    orders: orders.map((o, i) => ({ orderId: o.orderId, index: i, file: o.filename, itemCount: o.items.length })),
    products,
    byNormalizedName: byName,
  };

  fs.writeFileSync(PREFS_PATH, JSON.stringify(out, null, 2), 'utf8');

  const staples = Object.values(products).filter((p) => p.staple);
  const withEan = Object.values(products).filter((p) => p.ean).length;
  console.log(`[OK] ${total} commandes -> ${Object.keys(products).length} produits distincts`);
  console.log(`[OK] ${staples.length} produits récurrents · ${withEan} avec EAN`);
  console.log(`[OK] Écrit dans ${PREFS_PATH}`);
  console.log('\nTop 10 par confiance :');
  Object.values(products)
    .sort((a, b) => b.confidence - a.confidence || b.count - a.count)
    .slice(0, 10)
    .forEach((p) => console.log(`  ${String(p.count).padStart(2)}x  conf=${p.confidence.toFixed(2)}  ${p.label.slice(0, 62)}`));
}

main();
