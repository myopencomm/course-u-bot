// src/lib/judge.js — arbitrage par le CLI Claude local.
//
// Les règles déterministes de catalog.js ont un plafond : elles ne savent pas
// qu'un vinaigre « à l'estragon » est aromatisé alors que « vieux » ne l'est pas,
// ni que deux entrées au libellé identique sont un doublon catalogue. Un modèle
// le sait. On l'appelle donc là où les règles butent, jamais en remplacement.
//
// Économie d'appels : UN appel par run, groupant toutes les lignes ambiguës.
// Chaque appel coûte ~20s, en faire un par ligne rendrait le bot inutilisable.
//
// Seuils alignés sur la règle JEV de AGENTS.md : on agit au-dessus de 0,8,
// on laisse la question à l'humain en dessous.

import { execFile } from 'child_process';
import { estBio, normalize } from './normalize.js';

// ── Arbitre : n'importe quel assistant en ligne de commande ───────────────────
//
// Les règles déterministes ont un plafond : elles ne savent pas qu'un vinaigre
// « à l'estragon » est aromatisé alors que « vieux » ne l'est pas. Un modèle le
// sait. On l'appelle donc là où les règles butent, jamais en remplacement.
//
// Le bot ne dépend d'aucun fournisseur en particulier : il lance une commande
// que vous choisissez. Des préréglages couvrent les CLI courants ; JUDGE_CMD et
// JUDGE_ARGS permettent d'en brancher n'importe quel autre.
//
// Économie d'appels : UN appel par run, groupant toutes les lignes ambiguës.
// Chaque appel prend 5 à 20 s ; un appel par ligne rendrait le bot inutilisable.

const PRESETS = {
  claude: {
    cmd: 'claude',
    args: ['-p', '{prompt}', '--model', '{model}', '--output-format', 'json',
           '--allowedTools', '', '--append-system-prompt', '{system}'],
    model: 'claude-sonnet-5',
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
    timeout: Number(process.env.JUDGE_TIMEOUT_MS || 90000),
  };
}

// Consigne envoyée au modèle. Volontairement explicite sur le format attendu :
// tous les CLI ne savent pas contraindre une sortie structurée.
const CONSIGNE = [
  'Tu assistes un bot de courses francais sur coursesu.com.',
  'Reponds UNIQUEMENT par des objets JSON, un par ligne, sans texte autour:',
  '{"ligne":<n>,"itemid":"<id>"|null,"confiance":<0..1>,"raison":"<12 mots max>"}',
  'Regles de choix, par ordre de priorite:',
  '1. la nature du produit: le fruit ou le legume frais plutot que le jus, le sirop ou la conserve, sauf si la ligne demande le derive. Quand un rayon attendu est indique, le bon produit en vient;',
  '2. les qualificatifs demandes: vert != jaune, rouge != blanc, bio si la ligne dit bio;',
  '3. un vinaigre/huile "nature" prime sur une version aromatisee, sauf demande contraire;',
  '4. a qualite egale, preferer ce qui est deja achete par l utilisateur.',
  'Si aucune option ne respecte a la fois 1 et 2, mets itemid a null: un bon produit manquant vaut mieux qu un mauvais au panier, l utilisateur choisira.',
  'Deux libelles identiques sont un doublon catalogue: en choisir un, ne pas hesiter pour autant.',
].join('\n');

/** Extrait les objets JSON d'une reponse, qu'elle soit en tableau ou ligne a ligne. */
function extraireObjets(texte) {
  const out = [];
  const brut = String(texte || '').trim();
  try {
    const p = JSON.parse(brut);
    if (Array.isArray(p)) return p;
    if (p && typeof p === 'object') return [p];
  } catch {}
  for (const m of brut.matchAll(/\{[^{}]*"ligne"[^{}]*\}/g)) {
    try { out.push(JSON.parse(m[0])); } catch {}
  }
  return out;
}

function appelerArbitre(prompt) {
  const c = config();
  if (!c.actif) return Promise.resolve({ ok: false, erreur: 'arbitre désactivé (JUDGE_ENABLED=false)' });

  const args = c.args.map((a) => String(a)
    .replaceAll('{prompt}', prompt)
    .replaceAll('{system}', CONSIGNE)
    .replaceAll('{model}', c.model));

  return new Promise((resolve) => {
    execFile(c.cmd, args, { timeout: c.timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
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
  });
}

/**
 * Garde-fou sur le choix de l'arbitre : il a déjà pris un jus de citron vert
 * bio pour « Citron vert bio » avec 0,9 de confiance. Ce que le code sait
 * vérifier seul, il le vérifie : l'exigence bio et le rayon attendu.
 * @returns {string|null} la raison du refus, ou null si le choix tient.
 */
function verifierChoix(q, itemid) {
  const opt = q?.options.find((o) => o.itemid === itemid);
  if (!opt) return null;
  if (estBio(q.wanted) && !estBio(opt.name)) return 'refusé : non bio';
  if (q.expectedCat1 && opt.cat1 && normalize(opt.cat1) !== normalize(q.expectedCat1)) {
    return `refusé : rayon ${opt.cat1} au lieu de ${q.expectedCat1}`;
  }
  return null;
}

/**
 * Arbitre les lignes que les regles n'ont pas su trancher.
 * @param {Array} questions  [{ index, wanted, quantity, options:[{itemid,name,brand,price,rating,cat1,historyCount}] }]
 * @returns {Map<number, {itemid, confiance, raison}>} decisions retenues (confiance suffisante)
 */
export async function arbitrer(questions) {
  if (!questions.length) return { decisions: new Map(), meta: null };

  const lignes = questions.map((q) => {
    const opts = q.options.map((o, i) => {
      const bits = [
        o.itemid,
        o.name,
        o.cat1 || '?',
        o.price != null ? `${o.price} €` : 'prix ?',
        o.rating != null ? `note ${o.rating}` : 'note ?',
        `achete ${o.historyCount || 0}x`,
      ];
      return `  ${'abcdef'[i]}) ${bits.join(' | ')}`;
    }).join('\n');
    const rayon = q.expectedCat1 ? `, rayon attendu ${q.expectedCat1}` : '';
    return `LIGNE ${q.index}: "${q.wanted}" (quantite ${q.quantity || 1}${rayon})\n${opts}`;
  }).join('\n\n');

  const prompt = `Liste de courses et candidats trouves sur le site.\nPour chaque ligne, choisis le meilleur produit.\n\n${lignes}`;
  const rep = await appelerArbitre(prompt);
  if (!rep.ok) {
    console.log(`  [arbitre] indisponible (${rep.erreur}) — les questions partent a l'utilisateur.`);
    return { decisions: new Map(), meta: { erreur: rep.erreur } };
  }

  const decisions = new Map();
  const rejets = [];
  for (const o of extraireObjets(rep.texte)) {
    const n = Number(o.ligne);
    const conf = Number(o.confiance);
    if (!Number.isFinite(n) || !o.itemid) continue;
    if (!(conf >= config().seuil)) { rejets.push(`ligne ${n} conf=${conf}`); continue; }
    const refus = verifierChoix(questions.find((q) => q.index === n), String(o.itemid));
    if (refus) { rejets.push(`ligne ${n} ${refus}`); continue; }
    decisions.set(n, { itemid: String(o.itemid), confiance: conf, raison: String(o.raison || '').slice(0, 80) });
  }
  return {
    decisions,
    meta: { ms: rep.ms, cout: rep.cout, tranchees: decisions.size, laissees: rejets.length, rejets },
  };
}

/**
 * Relecture finale : le panier reel correspond-il a la liste ?
 * Renvoie un verdict lisible, destine au bilan Telegram.
 */
export async function relirePanier({ items, cart }) {
  const liste = items.map((i, k) => `${k + 1}. ${i.wanted} (x${i.quantity})`).join('\n');
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

  const rep = await appelerArbitre(prompt);
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
