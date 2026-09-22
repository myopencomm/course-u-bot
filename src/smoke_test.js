// src/smoke_test.js — vérifie que le programme démarre et que la logique tient.
//
//   npm test
//
// Ne touche ni au site, ni au panier, ni à vos identifiants. À lancer après
// toute modification : une erreur comme « X is not defined » n'apparaît qu'à
// l'exécution, `node --check` ne la voit pas.

import assert from 'assert';

let ok = 0;
const essai = async (nom, fn) => {
  try { await fn(); ok += 1; console.log(`  ✅ ${nom}`); }
  catch (e) { console.error(`  ❌ ${nom}\n     ${e.message}`); process.exitCode = 1; }
};

console.log('\nTest de fumée — aucune connexion au site\n');

await essai('les modules se chargent', async () => {
  for (const m of ['paths', 'normalize', 'notes', 'lexique', 'catalog', 'cart', 'judge', 'otp', 'telegram', 'session']) {
    await import(`./lib/${m}.js`);
  }
});

await essai('rapprochement de libellés', async () => {
  const { similarity } = await import('./lib/normalize.js');
  assert(similarity('Comté', 'Comté AOP 24 mois JURAFLORE 200g') > 0.8, 'requête courte mal notée');
  assert(similarity('Banana', 'Banane Cavendish') > 0.9, 'anglais non traduit');
  assert(similarity('Comté', 'Yaourt nature') < 0.3, 'faux positif');
});

await essai('lecture des quantités', async () => {
  const { parseLine } = await import('./lib/notes.js');
  assert.equal(parseLine('Kiwi gold 5').quantity, 5);
  assert.equal(parseLine('tomates cerises 500 g').quantity, 1, 'un poids n est pas une quantité');
  assert.equal(parseLine('Disques 4 en 1').quantity, 1, '« 4 en 1 » n est pas une quantité');
});

await essai('produits de saison', async () => {
  const { developper, chargerSaisons } = await import('./lib/lexique.js');
  const s = chargerSaisons();
  for (let m = 1; m <= 12; m++) assert(s[String(m)]?.fruits?.length, `mois ${m} incomplet`);
  const { lignes } = developper([{ raw: '', wanted: 'légumes de saison', quantity: 1 }], { prefs: { products: {} } });
  assert.equal(lignes.length, 3, 'sans chiffre, trois produits attendus');
});

await essai('classement et décision', async () => {
  const { rank, decide } = await import('./lib/catalog.js');
  const c = [
    { itemid: '1', name: 'Banane Cavendish', brand: '', rating: 4, cat1: 'Fruits et Légumes', addable: true, available: true },
    { itemid: '2', name: 'Banana bread', brand: '', rating: 4, cat1: 'Epicerie sucrée', addable: true, available: true },
  ];
  const r = rank(c, { wanted: 'Banana', prefs: { products: {} }, expectedCat1: 'Fruits et Légumes' });
  assert.equal(r[0].itemid, '1', 'le rayon doit départager');
  assert(decide(r, { wanted: 'Banana' }).action, 'décision absente');
});

await essai('arbitre : appel réellement construit', async () => {
  // JUDGE_CMD=echo rend l'appel inoffensif tout en parcourant la construction
  // des arguments — c'est ce chemin qui référence la consigne système.
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = '["{system}","{prompt}","{model}"]';
  process.env.JUDGE_OUTPUT = 'texte';
  const { arbitrer } = await import('./lib/judge.js');
  const r = await arbitrer([{ index: 1, wanted: 'test', quantity: 1, options: [{ itemid: '1', name: 'x' }] }]);
  assert(r.meta, 'aucun retour de l arbitre');
});

await essai('arbitre désactivé : dégradation propre', async () => {
  process.env.JUDGE_ENABLED = 'false';
  const { relirePanier } = await import('./lib/judge.js');
  const r = await relirePanier({ items: [], cart: { items: [] } });
  assert.equal(r.verdict, 'indisponible');
});

console.log(`\n${ok}/7 vérifications passées.\n`);
