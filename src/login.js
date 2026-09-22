// src/login.js — ouvre le navigateur DU BOT pour une connexion manuelle.
//
// Ouvre le vrai Chrome sur le port CDP avec le profil du bot
// (~/.openclaw/workspace/chrome-playwright-profile) et attend que la connexion
// soit établie. Une connexion faite dans un autre navigateur ne profite pas au
// bot : c'est ce profil-là qui doit porter la session.
//
// Le Turnstile Cloudflare se valide seul dans cette fenêtre (vrai Chrome,
// navigator.webdriver = false). S'il traîne, la case peut être cochée à la main.

import 'dotenv/config';
import { openBrowser, closeBrowser, readContext, acceptCookies } from './lib/session.js';
import { SITE } from './lib/paths.js';

const DEADLINE_MS = 5 * 60 * 1000;

const { page } = await openBrowser();
await page.goto(`${SITE}/connexion`, { waitUntil: 'domcontentloaded' });
await acceptCookies(page);

console.log('Connecte-toi dans la fenêtre Chrome. La case Cloudflare devrait se cocher seule. J\'attends (5 min max)...');

const deadline = Date.now() + DEADLINE_MS;
let ctx = { logged: false };
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  ctx = await readContext(page);
  if (ctx.logged) break;
}

if (ctx.logged) {
  console.log(`\n✅ Session enregistrée — magasin ${ctx.storeName || ctx.storeId}, compte connecté.`);
  console.log('   Elle sera réutilisée par tous les scripts du bot.');
} else {
  console.log('\n⚠️  Toujours pas connecté au bout de 5 min — session non enregistrée.');
}
await closeBrowser({ page });
process.exit(0);
