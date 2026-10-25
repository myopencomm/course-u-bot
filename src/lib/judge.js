// src/lib/judge.js — l'IA en ligne de commande : comprendre la liste, choisir
// les produits, relire le panier.
//
// Les règles déterministes de catalog.js ont un plafond : elles ne savent pas
// qu'un vinaigre « à l'estragon » est aromatisé alors que « vieux » ne l'est pas,
// ni que « Red onion » se cherche « oignon rouge » sur un site français. Un
// modèle le sait. Il intervient à trois endroits :
//
//  1. planifier : avant toute recherche, traduire chaque ligne (anglais, fautes,
//     abréviations) en requêtes pour le moteur du site, qui cherche mot à mot.
//     Sans ça, « Red onion » renvoyait du Red Bull et « Salt » des chips au sel.
//  2. arbitrer : parmi les candidats trouvés, choisir ; sinon dire lesquels sont
//     plausibles, ou proposer une autre requête.
//  3. relirePanier : le panier réel correspond-il à la liste ?
//
// Économie d'appels : chaque étape groupe toute la liste en UN appel. Un appel
// prend 5 à 30 s ; un appel par ligne rendrait le bot inutilisable.
//
// Seuils alignés sur la règle JEV de AGENTS.md : on agit au-dessus de 0,8,
// on laisse la question à l'humain en dessous.

import { execFile } from 'child_process';
import { estBio, normalize } from './normalize.js';

// ── N'importe quel assistant en ligne de commande ─────────────────────────────
//
// Le bot ne dépend d'aucun fournisseur en particulier : il lance une commande
// que vous choisissez. Des préréglages couvrent les CLI courants ; JUDGE_CMD et
// JUDGE_ARGS permettent d'en brancher n'importe quel autre.

const PRESETS = {
  claude: {
    cmd: 'claude',
    // --system-prompt remplace le prompt de Claude Code au lieu de s'y ajouter,
    // --tools '' et --strict-mcp-config retirent outils et serveurs MCP : le
    // modèle n'a qu'à lire et répondre. Le contexte passe de ~45 000 jetons à
    // ~1 000 : 25 fois moins cher, deux fois plus rapide.
    args: ['-p', '{prompt}', '--model', '{model}', '--output-format', 'json',
           '--tools', '', '--strict-mcp-config', '--no-session-persistence',
           '--system-prompt', '{system}'],
    // L'alias suit la dernière version de Sonnet.
    model: 'sonnet',
    sortie: 'json',
    cle: 'result',
  },
  gemini: {
    cmd: 'gemini',
    args: ['-m', '{model}', '-p', '{system}\n\n{prompt}'],
    model: 'gemini-2.5-pro',
    sortie: 'texte',
  },
  ollama: {
    cmd: 'ollama',
    args: ['run', '{model}', '{system}\n\n{prompt}'],
    model: 'llama3.1',
    sortie: 'texte',
  },
  codex: {
    cmd: 'codex',
    args: ['exec', '--model', '{model}', '{system}\n\n{prompt}'],
    model: 'gpt-5.5',
    sortie: 'texte',
  },
};

function config() {
  const nom = (process.env.JUDGE_PRESET || 'claude').toLowerCase();
  const base = PRESETS[nom] || PRESETS.claude;
  let args = base.args;
  if (process.env.JUDGE_ARGS) {
    // Tableau JSON, pour brancher un CLI non prévu :
    //   JUDGE_ARGS=["-p","{prompt}","--model","{model}"]
    try { args = JSON.parse(process.env.JUDGE_ARGS); }
    catch { console.warn('[arbitre] JUDGE_ARGS illisible (tableau JSON attendu) — préréglage utilisé.'); }
  }
  return {
    actif: process.env.JUDGE_ENABLED !== 'false',
    cmd: process.env.JUDGE_CMD || base.cmd,
    args,
    model: process.env.JUDGE_MODEL || base.model,
    sortie: process.env.JUDGE_OUTPUT || base.sortie,
    cle: process.env.JUDGE_RESULT_KEY || base.cle || 'result',
    seuil: Number(process.env.JUDGE_THRESHOLD || 0.8),
    timeout: Number(process.env.JUDGE_TIMEOUT_MS || 180000),
  };
}

// Consignes envoyées au modèle. Volontairement explicites sur le format attendu :
// tous les CLI ne savent pas contraindre une sortie structurée.
const CONSIGNE_PLAN = [
  'Tu prepares les recherches d un bot de courses sur coursesu.com (Super U, France).',
  'La liste est ecrite a la main, en francais ou en anglais, avec des fautes.',
  'Pour chaque ligne, dis ce que la personne veut acheter et comment le chercher sur le site.',
  'Reponds UNIQUEMENT par des objets JSON, un par ligne, sans texte autour:',
  '{"ligne":<n>,"produit":"<designation francaise>","requetes":["<requete 1>","<requete 2>"],"rayon":"<rayon>"|null,"saison":"fruits"|"legumes"|null}',
  '- produit: le produit de base en francais, au sens le plus courant en cuisine (Salt = sel fin, Red onion = oignon rouge, Lamb mince = viande hachee d agneau). Corrige les fautes. Garde bio et les qualificatifs demandes (fume, complet, noir, de France, une marque).',
  '- requetes: 1 ou 2 requetes courtes, comme on les tape dans le moteur d un supermarche francais, la plus probable d abord, au pluriel courant ("tomates cerises", "carottes"). Ni quantite ni poids.',
  '- rayon: le rayon du site ou ce produit se trouve, recopie tel quel depuis la liste fournie, sinon null.',
  '- saison: "fruits" ou "legumes" si la ligne demande des fruits ou legumes de saison sans en nommer (meme mal ecrit), sinon null.',
].join('\n');

const CONSIGNE_CHOIX = [
  'Tu choisis les produits d un bot de courses sur coursesu.com (Super U, France).',
  'Pour chaque ligne: la demande telle qu ecrite, son interpretation, et les candidats trouves sur le site',
  '(id | nom | marque | rayon | prix | note | achats passes).',
  'Reponds UNIQUEMENT par des objets JSON, un par ligne, sans texte autour:',
  '{"ligne":<n>,"itemid":"<id>"|null,"quantite":<n>,"doute":"aucun"|"preference"|"reel","confiance":<0..1>,"plausibles":[{"id":"<id>","quantite":<n>}],"requete":"<requete>"|null,"raison":"<12 mots max>"}',
  'Regles de choix, par ordre de priorite:',
  '1. la nature du produit: le produit lui-meme, pas un produit qui en contient ou en a le gout (oignon rouge != Red Bull, sel != beurre sale ni chips au sel, lardons != lardons de saumon). Le fruit ou le legume frais plutot que le jus, le sirop, la conserve ou le surgele, sauf si la ligne demande le derive;',
  '2. les qualificatifs demandes: vert != jaune, rouge != blanc, fume, complet, bio si la ligne dit bio;',
  '3. la version nature ou classique prime sur une version aromatisee ou preparee, sauf demande contraire;',
  '4. a qualite egale, preferer ce qui est deja achete, puis le format courant au meilleur prix.',
  '- itemid: ton choix si une option respecte 1 et 2, sinon null. Un bon produit manquant vaut mieux qu un mauvais au panier, l utilisateur choisira.',
  '- doute: "aucun" si une seule option correspond clairement;',
  '  "preference" si plusieurs conviennent (plusieurs miels, plusieurs riz) et que ton choix est un defaut raisonnable (deja achete, le plus courant, le meilleur prix): la personne ne s en plaindrait pas, le bot le prendra;',
  '  "reel" si un qualificatif demande manque (bio, fume...), si le format est tres different de la demande (2,5 kg pour 500 g) ou si la nature du produit est incertaine: la personne choisira.',
  '- confiance: probabilite que la personne accepte ton choix.',
  '- quantite: combien d exemplaires de ce produit pour couvrir la quantite demandee (4 poires et une barquette de 4 = 1; 12 oeufs et une boite de 6 = 2; 4 poires a la piece = 4). Jamais plus que la quantite demandee. Prefere le format qui couvre la demande sans la depasser de beaucoup (12 oeufs: 2 boites de 6 plutot que 2 boites de 10).',
  '- plausibles: les options qui correspondent vraiment a la demande, par la nature ET les qualificatifs (bio...), avec la quantite a ajouter pour chacune, la meilleure d abord, 3 au plus. Si aucune ne respecte les qualificatifs, les plus proches par la nature. [] si aucune n a la bonne nature: un produit hors sujet n y figure jamais.',
  '- requete: si aucune option ne convient, une autre requete courte pour le moteur du site; sinon null.',
  '- raison: courte. Si itemid est null, dis ce qui manque (pas de version bio, seulement du surgele...).',
  'Deux libelles identiques sont un doublon catalogue: en choisir un, ne pas hesiter pour autant.',
].join('\n');

const CONSIGNE_RELECTURE = 'Tu verifies le panier d un bot de courses sur coursesu.com (Super U, France). Reponds uniquement par l objet JSON demande.';

/** Extrait les objets JSON d'une reponse, qu'elle soit en tableau ou ligne a ligne. */
function extraireObjets(texte) {
  const brut = String(texte || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const p = JSON.parse(brut);
    if (Array.isArray(p)) return p;
    if (p && typeof p === 'object') return [p];
  } catch {}
  // Un objet par ligne, comme demandé. Les plausibles imbriqués empêchent de
  // s'en remettre d'abord à une expression régulière.
  const out = [];
  for (const l of brut.split('\n')) {
    const t = l.trim().replace(/,$/, '');
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  if (out.length) return out;
  // Dernier recours : des objets plats noyés dans du texte.
  for (const m of brut.matchAll(/\{[^{}]*"ligne"[^{}]*\}/g)) {
    try { out.push(JSON.parse(m[0])); } catch {}
  }
  return out;
}

function appeler(prompt, consigne) {
  const c = config();
  if (!c.actif) return Promise.resolve({ ok: false, erreur: 'arbitre désactivé (JUDGE_ENABLED=false)' });

  const args = c.args.map((a) => String(a)
    .replaceAll('{prompt}', prompt)
    .replaceAll('{system}', consigne)
    .replaceAll('{model}', c.model));

  return new Promise((resolve) => {
    const enfant = execFile(c.cmd, args, { timeout: c.timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const msg = /ENOENT/.test(String(err.message))
          ? `commande « ${c.cmd} » introuvable — installez-la ou passez JUDGE_ENABLED=false`
          : String(err.message).slice(0, 120);
        return resolve({ ok: false, erreur: msg });
      }
      if (c.sortie === 'texte') return resolve({ ok: true, texte: String(stdout) });
      try {
        const env = JSON.parse(stdout);
        resolve({ ok: !env.is_error, texte: env[c.cle] ?? '', ms: env.duration_ms, cout: env.total_cost_usd });
      } catch {
        // Un CLI annoncé JSON qui répond en texte brut reste exploitable.
        resolve({ ok: true, texte: String(stdout) });
      }
    });
    // Entrée laissée ouverte, le CLI Claude attend 3 s un contenu qui ne viendra pas.
    enfant.stdin?.end();
  });
}

/**
 * Interprète les lignes de la liste avant toute recherche.
 * @param {Array} lignes  [{ wanted, quantity, sizeHint }]
 * @param {{ rayons: string[] }} opts  rayons du site, que la réponse doit reprendre tels quels
 * @returns {{ plans: Array<{produit, requetes, rayon, saison}|null>, meta }}  plans alignés sur `lignes`
 */
export async function planifier(lignes, { rayons = [] } = {}) {
  if (!lignes.length) return { plans: [], meta: null };

  const liste = lignes.map((l, k) => {
    const precisions = [];
    if (l.quantity > 1) precisions.push(`quantite ${l.quantity}`);
    if (l.sizeHint) precisions.push(`taille ${l.sizeHint}`);
    return `${k + 1}. ${l.wanted}${precisions.length ? ` (${precisions.join(', ')})` : ''}`;
  }).join('\n');

  const rep = await appeler(`Rayons du site: ${rayons.join(' | ')}\n\n${liste}`, CONSIGNE_PLAN);
  const plans = lignes.map(() => null);
  if (!rep.ok) return { plans, meta: { erreur: rep.erreur } };

  const parRayon = new Map(rayons.map((r) => [normalize(r), r]));
  for (const o of extraireObjets(rep.texte)) {
    const k = Number(o.ligne) - 1;
    if (!(k >= 0 && k < lignes.length)) continue;
    const requetes = (Array.isArray(o.requetes) ? o.requetes : [])
      .map((r) => String(r || '').trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 2);
    let produit = String(o.produit || '').trim().slice(0, 80) || requetes[0] || '';
    if (!produit) continue;
    // L'exigence bio de la liste ne se négocie pas, même si la reformulation l'a perdue.
    if (estBio(lignes[k].wanted) && !estBio(produit)) produit += ' bio';
    const saison = normalize(o.saison);
    plans[k] = {
      produit,
      requetes: requetes.length ? requetes : [produit],
      rayon: parRayon.get(normalize(o.rayon)) || null,
      saison: saison === 'fruits' || saison === 'legumes' ? saison : null,
    };
  }
  return { plans, meta: { ms: rep.ms, cout: rep.cout, interpretees: plans.filter(Boolean).length } };
}

/**
 * Garde-fou sur le choix de l'arbitre : il a déjà pris un jus de citron vert
 * bio pour « Citron vert bio » avec 0,9 de confiance. Ce que le code sait
 * vérifier seul, il le vérifie : l'exigence bio, et le rayon quand il est sûr
 * (une ligne de saison, ou l'historique). Un rayon deviné par l'interprétation
 * ne suffit pas à refuser : le site range le paprika en fruits et légumes.
 * @returns {string|null} la raison du refus, ou null si le choix tient.
 */
function verifierChoix(q, itemid) {
  const opt = q?.options.find((o) => o.itemid === itemid);
  if (!opt) return null;
  // « bio » est souvent dans la marque (U BIO) et non dans le nom.
  if (estBio(q.wanted) && !estBio(`${opt.name} ${opt.brand || ''}`)) return 'refusé : non bio';
  if (q.rayonCertain && q.expectedCat1 && opt.cat1 && normalize(opt.cat1) !== 'bio'
      && normalize(opt.cat1) !== normalize(q.expectedCat1)) {
    return `refusé : rayon ${opt.cat1} au lieu de ${q.expectedCat1}`;
  }
  return null;
}

/**
 * Arbitre les lignes que les règles ne suffisent pas à trancher.
 * @param {Array} questions  [{ index, wanted, produit, quantity, sizeHint, expectedCat1, rayonCertain,
 *                              options:[{itemid,name,brand,price,rating,cat1,cat2,historyCount,inCart}] }]
 * @returns {{ decisions: Map<number,{itemid,confiance,doute,raison,quantite}>,
 *             plausibles: Map<number,{itemid,quantite}[]>, relances: Map<number,string>,
 *             raisons: Map<number,string>, meta }}
 *   decisions : choix retenus (confiance suffisante, garde-fous passés) ;
 *   plausibles : pour chaque ligne traitée, les options qui méritent d'être proposées ;
 *   relances : une autre requête, quand aucune option ne convient.
 */
export async function arbitrer(questions) {
  const vide = { decisions: new Map(), plausibles: new Map(), relances: new Map(), raisons: new Map() };
  if (!questions.length) return { ...vide, meta: null };

  const decrire = (q) => {
    const opts = q.options.map((o, i) => {
      const bits = [
        o.itemid,
        o.name,
        o.brand || '?',
        [o.cat1, o.cat2].filter(Boolean).join(' > ') || '?',
        o.price != null ? `${o.price} €` : 'prix ?',
        o.rating != null ? `note ${o.rating}` : 'note ?',
        `achete ${o.historyCount || 0}x${o.inCart ? ', deja au panier' : ''}`,
      ];
      return `  ${'abcdefghijklmnop'[i]}) ${bits.join(' | ')}`;
    }).join('\n');
    const precisions = [`quantite ${q.quantity || 1}`];
    if (q.sizeHint) precisions.push(`taille ${q.sizeHint}`);
    if (q.expectedCat1) precisions.push(`rayon ${q.rayonCertain ? 'attendu' : 'probable'} ${q.expectedCat1}`);
    const sens = q.produit && normalize(q.produit) !== normalize(q.wanted) ? ` = ${q.produit}` : '';
    return `LIGNE ${q.index}: "${q.wanted}"${sens} (${precisions.join(', ')})\n${opts}`;
  };

  // Une liste entière en un appel dépassait 45 s : la réponse s'allonge avec
  // le nombre de lignes. On découpe en lots arbitrés en parallèle.
  const TAILLE_LOT = 12;
  const lots = [];
  for (let i = 0; i < questions.length; i += TAILLE_LOT) lots.push(questions.slice(i, i + TAILLE_LOT));
  const reponses = await Promise.all(lots.map((lot) => appeler(
    `Liste de courses et candidats trouves sur le site.\nPour chaque ligne, choisis le meilleur produit.\n\n${lot.map(decrire).join('\n\n')}`,
    CONSIGNE_CHOIX,
  )));
  const echecs = reponses.filter((r) => !r.ok);
  if (echecs.length === reponses.length) {
    console.log(`  [arbitre] indisponible (${echecs[0].erreur}) — les règles reprennent la main.`);
    return { ...vide, meta: { erreur: echecs[0].erreur } };
  }
  // Un lot sans réponse retombe sur les règles, ligne à ligne.
  const muettes = new Set(lots.flatMap((lot, k) => (reponses[k].ok ? [] : lot.map((q) => q.index))));
  const rep = {
    texte: reponses.filter((r) => r.ok).map((r) => r.texte).join('\n'),
    ms: Math.max(...reponses.map((r) => r.ms || 0)),
    cout: reponses.reduce((t, r) => t + (r.cout || 0), 0),
  };

  const { decisions, plausibles, relances, raisons } = vide;
  const rejets = [];
  for (const o of extraireObjets(rep.texte)) {
    const n = Number(o.ligne);
    const q = questions.find((x) => x.index === n);
    if (!q) continue;
    const ids = new Set(q.options.map((x) => x.itemid));
    const choix = o.itemid != null && ids.has(String(o.itemid)) ? String(o.itemid) : null;
    // L'arbitre ne peut que réduire la quantité demandée, jamais la gonfler.
    const voulu = Math.max(1, q.quantity || 1);
    const borner = (x) => { const v = Math.round(Number(x)); return v >= 1 ? Math.min(voulu, v) : null; };

    // Le choix de l'arbitre est plausible par définition : s'il est écarté plus
    // bas (confiance, garde-fou), il doit rester proposé à l'utilisateur.
    let plaus = (Array.isArray(o.plausibles) ? o.plausibles : [])
      .map((p) => (typeof p === 'object' && p ? { itemid: String(p.id ?? p.itemid), quantite: borner(p.quantite) } : { itemid: String(p), quantite: null }))
      .filter((p) => ids.has(p.itemid));
    if (choix) plaus.unshift({ itemid: choix, quantite: borner(o.quantite) });
    plaus = plaus.filter((p, k) => plaus.findIndex((x) => x.itemid === p.itemid) === k);
    // Bio demandé et disponible : le non-bio ne se propose pas.
    const estBioOpt = (p) => { const x = q.options.find((y) => y.itemid === p.itemid); return estBio(`${x.name} ${x.brand || ''}`); };
    if (estBio(q.wanted) && plaus.some(estBioOpt)) plaus = plaus.filter(estBioOpt);
    plausibles.set(n, plaus.slice(0, 3));

    const requete = typeof o.requete === 'string' ? o.requete.trim().slice(0, 60) : '';
    if (requete) relances.set(n, requete);
    const raison = String(o.raison || '').slice(0, 80);
    if (raison) raisons.set(n, raison);

    if (!choix) continue;
    // Le doute déclaré décide : un modèle se cale mal sur un seuil chiffré et
    // notait 0,6 un sel fin ou un Comté acheté quatre fois, au seul motif que
    // d'autres options convenaient aussi. Le seuil de confiance ne sert plus
    // que pour un CLI qui ne renseigne pas le doute.
    const conf = Number(o.confiance);
    const doute = ['aucun', 'preference', 'reel'].find((x) => x === normalize(o.doute)) || null;
    const accepte = doute ? doute !== 'reel' && !(conf < 0.5) : conf >= config().seuil;
    if (!accepte) { rejets.push(`ligne ${n} ${doute ? `doute ${doute}` : ''} conf=${conf}`); continue; }
    const refus = verifierChoix(q, choix);
    if (refus) { rejets.push(`ligne ${n} ${refus}`); continue; }
    decisions.set(n, { itemid: choix, confiance: conf, doute, raison, quantite: borner(o.quantite) });
  }
  return {
    decisions, plausibles, relances, raisons,
    meta: { ms: rep.ms, cout: rep.cout, tranchees: decisions.size, laissees: questions.length - decisions.size, rejets, muettes },
  };
}

/**
 * Relecture finale : le panier reel correspond-il a la liste ?
 * Renvoie un verdict lisible, destine au bilan Telegram.
 */
export async function relirePanier({ items, cart }) {
  const liste = items.map((i, k) => {
    const sens = i.plan && normalize(i.plan.produit) !== normalize(i.wanted) ? ` = ${i.plan.produit}` : '';
    return `${k + 1}. ${i.wanted}${sens} (x${i.quantity})`;
  }).join('\n');
  const panier = cart.items.length
    ? cart.items.map((i) => `- ${i.name || i.itemid} (x${i.quantity})`).join('\n')
    : '(panier vide)';

  const prompt = [
    'Voici une liste de courses et le contenu reel du panier constitue par le bot.',
    'Verifie la correspondance.',
    '',
    'LISTE DEMANDEE:', liste,
    '',
    'PANIER REEL:', panier,
    '',
    'Reponds UNIQUEMENT par un objet JSON:',
    '{"verdict":"ok"|"problemes","anomalies":[{"ligne":<numero dans la liste demandee>|null,"probleme":"<une phrase>"}]}',
    'ligne est le numero de la ligne de liste concernee, null pour un article present non demande.',
    'Signale: article demande absent, article present non demande, quantite douteuse,',
    'produit manifestement hors sujet (jus au lieu du fruit, aromatise au lieu de nature).',
    'N invente pas de probleme: si tout correspond, verdict "ok" et anomalies vide.',
  ].join('\n');

  const rep = await appeler(prompt, CONSIGNE_RELECTURE);
  if (!rep.ok) return { verdict: 'indisponible', anomalies: [], erreur: rep.erreur };

  const brut = String(rep.texte || '');
  const m = brut.match(/\{[\s\S]*\}/);
  if (!m) return { verdict: 'illisible', anomalies: [] };
  try {
    const o = JSON.parse(m[0]);
    // anomalies reste une liste de phrases (bilan Telegram, verify-cart) ;
    // details garde le numéro de ligne, qui permet à prepare-cart de corriger.
    const details = (Array.isArray(o.anomalies) ? o.anomalies : []).slice(0, 8).map((a) => (
      typeof a === 'string'
        ? { ligne: null, probleme: a }
        : { ligne: Number.isInteger(a?.ligne) ? a.ligne : null, probleme: String(a?.probleme || '') }
    )).filter((a) => a.probleme);
    return {
      verdict: o.verdict === 'ok' ? 'ok' : 'problemes',
      anomalies: details.map((a) => a.probleme),
      details,
      ms: rep.ms,
      cout: rep.cout,
    };
  } catch {
    return { verdict: 'illisible', anomalies: [] };
  }
}
