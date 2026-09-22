// src/lib/session.js — navigateur + connexion Compte U.
//
// ── Pourquoi on n'utilise PAS le navigateur de Playwright ──────────────────────
// La page de connexion est protégée par un Turnstile Cloudflare ("Vérifiez que
// vous êtes humain"). Avec un navigateur lancé par Playwright, la vérification
// passive échoue et la case reste à cocher, bouton Continuer grisé.
// L'ancien script contournait ça sans le documenter : il démarrait le VRAI Chrome
// sur un port de debug et s'y attachait en CDP. Chrome se lance alors normalement,
// avec un profil vieilli et une empreinte ordinaire, et le Turnstile se valide
// tout seul. On restaure ce mécanisme, c'est lui qui fait marcher la connexion.
//
// Corollaire repris de la v1 : on ne ferme jamais Chrome en fin de run. Il reste
// ouvert, la session Super U et la clearance Cloudflare restent chaudes, et le
// run suivant se rattache instantanément.
//
// ── Connexion ─────────────────────────────────────────────────────────────────
// Depuis 2026 le login passe par ForgeRock sur moncompte.magasins-u.com
// (OAuth2/OIDC, realm alpha, service u_Auth) avec un code à usage unique envoyé
// par e-mail. L'état réel est lu dans window.tc_vars.user_logged, que le site
// maintient sur toutes ses pages.

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';
import process from 'process';
import { ROOT, LOGIN_URL, STORE_URL } from './paths.js';
import { waitForCode, clearRelay, marquerConsomme, supprimerMail, nettoyerMailsConsommes } from './otp.js';

const CDP_PORT = Number(process.env.CHROME_CDP_PORT || 9222);
// Profil historique du bot : son ancienneté aide le Turnstile à passer.
// Profil Chrome dédié au bot, conservé dans le projet. Son ancienneté aide la
// validation passive du Turnstile : ne pas le supprimer entre deux runs.
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(ROOT, '.chrome-profile');
const CHROME_BIN = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function tryConnectCDP(port = CDP_PORT) {
  try {
    return await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 2000 });
  } catch {
    return null;
  }
}

function launchChrome() {
  console.log('[NAV] Lancement de Chrome...');
  spawn(CHROME_BIN, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--profile-directory=Default',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
  ], { detached: true, stdio: 'ignore' }).unref();
}

async function waitForCDP(port = CDP_PORT, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const browser = await tryConnectCDP(port);
    if (browser) return browser;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome n'a pas ouvert le port CDP ${port} en ${timeout}ms.`);
}

export async function openBrowser() {
  let browser = await tryConnectCDP();
  if (!browser) {
    launchChrome();
    browser = await waitForCDP();
  } else {
    console.log('[NAV] Chrome déjà ouvert, rattachement immédiat.');
  }
  // contexts()[0] est le contexte du profil persistant : il porte les cookies.
  // Un newContext() serait vierge et reperdrait la session à chaque run.
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  return { browser, context, page };
}

/** Ferme notre onglet et laisse Chrome vivant, comme le faisait la v1. */
export async function closeBrowser({ page } = {}) {
  await page?.close().catch(() => {});
}

export async function acceptCookies(page) {
  // Le site a DEUX bandeaux cookies distincts : la pop-in centrale
  // (#popin_tc_privacy) et une barre de pied de page (#footer_tc_privacy).
  // La seconde est en position:fixed avec z-index 999998 et fait 250px de haut :
  // elle recouvre les boutons "Ajouter au panier" des tuiles du bas et fait
  // échouer les clics avec "subtree intercepts pointer events".
  const accepted = await page.evaluate(() => {
    const btn = document.querySelector('#footer_tc_privacy_button');
    if (btn && btn.offsetParent !== null) { btn.click(); return 'footer'; }
    return null;
  }).catch(() => null);
  if (accepted) {
    await page.waitForTimeout(500);
    return true;
  }

  for (const label of [/Accepter tout/i, /Tout accepter/i, /^Accepter$/i]) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(400);
      return true;
    }
  }
  return false;
}

/**
 * Neutralise les calques qui interceptent les clics.
 * Filet de sécurité : les bandeaux cookies réapparaissent d'une page à l'autre
 * et un simple "Accepter" ne suffit pas toujours à les retirer du DOM.
 */
export async function dismissOverlays(page) {
  await page.evaluate(() => {
    for (const sel of ['#footer_tc_privacy', '#tc-privacy-wrapper', '#privacy-overlay', '#popin_tc_privacy']) {
      const el = document.querySelector(sel);
      if (el) el.style.setProperty('display', 'none', 'important');
    }
  }).catch(() => {});
}

/** Lit le contexte que le site publie dans window.tc_vars (TagCommander). */
export async function readContext(page) {
  return page.evaluate(() => {
    const v = window.tc_vars || {};
    return {
      logged: v.user_logged === true,
      userId: v.user_id || null,
      storeId: v.store_id || null,
      storeName: v.store_name || null,
      basketId: v.basket_id || null,
      basketAmount: v.basket_amount || null,
      orderCount: v.user_order_counter || null,
    };
  }).catch(() => ({ logged: false }));
}

/**
 * Attend la validation du Turnstile Cloudflare.
 * Avec le vrai Chrome elle est passive et prend quelques secondes. Si elle ne
 * vient pas, on prévient plutôt que d'attendre en silence : la fenêtre est
 * visible, la case peut être cochée à la main.
 */
async function waitForTurnstile(page, { notify, timeoutMs = 45000 } = {}) {
  // Piège relevé à l'exécution : le widget se matérialise par un input CACHÉ
  // (name="cf-turnstile-response"), et l'iframe du défi peut ne jamais exister
  // quand la validation est passive. Un test isVisible() renverrait donc false
  // et on sauterait l'attente. On compte les éléments, on ne les regarde pas.
  const present = await page.locator('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [name="cf-turnstile-response"]')
    .count().then((n) => n > 0).catch(() => false);
  if (!present) return { required: false, solved: true };

  console.log('[NAV] Turnstile Cloudflare détecté, attente de la validation...');
  const deadline = Date.now() + timeoutMs;
  let warned = false;

  while (Date.now() < deadline) {
    // Le jeton n'est posé dans le champ caché qu'une fois le défi validé.
    const token = await page.evaluate(() => {
      const el = document.querySelector('[name="cf-turnstile-response"], #cf-chl-widget-response');
      return el && el.value ? el.value.length : 0;
    }).catch(() => 0);
    if (token > 0) {
      console.log('[NAV] Turnstile validé.');
      return { required: true, solved: true };
    }

    if (!warned && Date.now() - (deadline - timeoutMs) > 12000) {
      warned = true;
      console.log('[NAV] Validation lente — la case peut être cochée à la main dans la fenêtre.');
      if (notify) await notify('🤖 Super U demande la vérification Cloudflare. Coche la case dans la fenêtre Chrome si elle ne se valide pas seule.');
    }
    await page.waitForTimeout(1000);
  }
  return { required: true, solved: false };
}

/**
 * Repère l'étape "code de vérification".
 *
 * Relevé sur l'écran réel : le champ n'a NI name, NI id stable (`el-id-827-5`,
 * regénéré à chaque rendu), NI aria-label. Le chercher par ses attributs ne
 * marche pas — une première version le ratait et sautait l'étape en silence.
 * On identifie donc l'écran par son texte, puis on prend l'unique champ texte
 * visible qu'il contient.
 *
 *   Validation de la connexion
 *   Nous vous avons envoyé un e-mail à <adresse>
 *   Celui-ci contient un code temporaire.
 *   [ Exemple : 12345678 ]   (Valider) (Renvoyer le code)
 */
async function findCodeStep(page) {
  return page.evaluate(() => {
    const body = document.body.innerText || '';
    const onCodeScreen = /code temporaire|validation de la connexion|saisir ce code/i.test(body);
    if (!onCodeScreen) return null;

    const inputs = [...document.querySelectorAll('input')]
      .filter((i) => i.offsetParent !== null && /text|tel|number/.test(i.type || 'text'));
    if (!inputs.length) return null;

    // Cas d'une case par chiffre, au cas où le site changerait de présentation.
    const boxes = inputs.filter((i) => i.maxLength === 1);
    if (boxes.length >= 4) return { kind: 'boxes', count: boxes.length };

    // Longueur attendue, déduite du placeholder ("Exemple : 12345678").
    const ph = inputs[0].placeholder || '';
    const digits = (ph.match(/\d+/) || [''])[0].length || null;
    return { kind: 'single', expectedLength: digits };
  }).catch(() => null);
}

async function fillCode(page, step, code) {
  if (step.kind === 'boxes') {
    const boxes = page.locator('input[maxlength="1"]:visible');
    for (let i = 0; i < code.length && i < step.count; i++) {
      await boxes.nth(i).fill(code[i]);
      await page.waitForTimeout(80);
    }
  } else {
    // Pas de sélecteur stable : on vise l'unique champ texte visible de l'écran.
    await page.locator('input[type="text"]:visible').first().fill(code);
  }
  await page.waitForTimeout(400);
  const submit = page.getByRole('button', { name: /^valider$/i }).first();
  if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submit.click().catch(() => {});
  }
}

/**
 * Garantit une session connectée.
 * @param {function} notify  Callback (message) pour prévenir sur Telegram.
 */
export async function ensureLoggedIn(page, { notify } = {}) {
  const say = notify || (async () => {});

  await page.goto(STORE_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);

  let ctx = await readContext(page);
  if (ctx.logged) {
    console.log(`[SESSION] Déjà connecté (magasin ${ctx.storeName || ctx.storeId || '?'}).`);
    return ctx;
  }

  const email = process.env.COURSESU_EMAIL;
  const password = process.env.COURSESU_PASSWORD;
  if (!email || !password) throw new Error('COURSESU_EMAIL / COURSESU_PASSWORD absents de .env');

  console.log('[SESSION] Session expirée, connexion via Compte U...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await acceptCookies(page);

  await page.getByRole('textbox', { name: /e-?mail/i }).first().fill(email);
  await page.getByRole('textbox', { name: /mot de passe/i }).first().fill(password);

  // Le bouton Continuer reste grisé tant que le Turnstile n'est pas validé.
  const turnstile = await waitForTurnstile(page, { notify: say });
  if (!turnstile.solved) {
    throw new Error('Vérification Cloudflare non validée : Chrome est-il bien lancé via CDP avec le profil du bot ?');
  }

  const continueBtn = page.getByRole('button', { name: /continuer/i }).first();
  await continueBtn.waitFor({ state: 'visible', timeout: 10000 });
  for (let i = 0; i < 40 && !(await continueBtn.isEnabled().catch(() => false)); i++) {
    await page.waitForTimeout(250);
  }
  if (!(await continueBtn.isEnabled().catch(() => false))) {
    throw new Error('Le bouton Continuer est resté grisé (Turnstile ou validation du formulaire).');
  }

  const loginStartedAt = new Date();
  clearRelay(); // tout code antérieur à cet instant est périmé
  await continueBtn.click();
  await page.waitForTimeout(3500);

  const step = await findCodeStep(page);
  if (step) {
    console.log(`[SESSION] Code de vérification demandé (${step.kind}).`);
    const { code, source, ref } = await waitForCode({
      since: loginStartedAt,
      // 5 min : mesuré le 2026-09-21, un code est arrivé APRÈS la fenêtre de
      // 180 s. La livraison du mail Super U dépasse parfois trois minutes, et
      // un échec ici fait repartir toute la connexion pour rien.
      timeoutMs: 300000,
      onWaiting: async ({ gmailUsable }) => {
        await say(gmailUsable
          ? '🔐 Super U demande un code de vérification. Je le lis dans Gmail, patiente ~15s.'
          : '🔐 Super U demande un code de vérification et Gmail est indisponible. Poste le code ici.');
      },
    });
    console.log(`[SESSION] Code reçu via ${source}.`);
    // Marqué avant la saisie : même si la validation échoue, ce code a été
    // présenté au site et ne doit plus être proposé à la tentative suivante.
    marquerConsomme(code);
    // Puis on supprime le mail sans attendre. une autre personne du foyer se connecte au même compte
    // depuis son poste et reçoit son code par Zapier, qui surveille cette boîte
    // et repère mal les empilements : un mail du bot laissé en place peut lui
    // faire relayer un code déjà consommé.
    if (ref) {
      const efface = await supprimerMail(ref);
      console.log(efface ? '[SESSION] Mail du code supprimé.' : '[SESSION] Mail du code non supprimé.');
    }
    await fillCode(page, step, code);
    clearRelay();
    await page.waitForTimeout(4000);
  }

  await page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1500);
  ctx = await readContext(page);
  if (!ctx.logged) {
    throw new Error('Connexion échouée : le site ne renvoie pas user_logged=true après la saisie du code.');
  }
  console.log(`[SESSION] Connecté (magasin ${ctx.storeName || ctx.storeId || '?'}, ${ctx.orderCount || '?'} commandes).`);

  // Dernier filet : on s'assure qu'aucun mail de code déjà consommé ne traîne
  // dans la boîte surveillée par Zapier, pour ne pas fausser la connexion d'un autre membre du foyer.
  const balayes = await nettoyerMailsConsommes();
  if (balayes) console.log(`[SESSION] ${balayes} mail(s) de code périmé(s) mis à la corbeille.`);

  return ctx;
}
