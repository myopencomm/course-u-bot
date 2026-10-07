// src/smoke_test.js — vérifie que le programme démarre et que la logique tient.
//
//   npm test
//
// Ne touche ni au site, ni au panier, ni à vos identifiants. À lancer après
// toute modification : une erreur comme « X is not defined » n'apparaît qu'à
// l'exécution, `node --check` ne la voit pas.

import assert from 'assert';

let ok = 0;
let total = 0;
const essai = async (nom, fn) => {
  total += 1;
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

await essai('bio exigé quand la liste le demande', async () => {
  const { similarity } = await import('./lib/normalize.js');
  assert(similarity('Bananes bio', 'Banane Cavendish') < 0.55, 'une banane non bio passe pour bio');
  assert(similarity('Bananes bio', 'Banane bio Cavendish') > 0.9, 'la banane bio est mal notée');
  assert(similarity('Lait uht entier bio', 'Lait UHT biologique entier 6x1L') > 0.8, '« biologique » non reconnu');
  assert(similarity('Bananes bio', 'Banane Cavendish', { bio: false }) > 0.9, 'le rayon ne doit pas dépendre du bio');
  assert(similarity('Bananes', 'Banane bio Cavendish') > 0.9, 'du bio non demandé ne doit pas pénaliser');
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

await essai('arbitre : un choix non bio ou hors rayon est refusé', async () => {
  // L'arbitre répond « jus de citron vert bio » (option b) avec 0,95 pour la
  // ligne 1, et « citron jaune » non bio (option a) pour la ligne 2.
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = JSON.stringify(['{"ligne":1,"itemid":"b","confiance":0.95,"raison":"x"}\n{"ligne":2,"itemid":"a","confiance":0.95,"raison":"x"}']);
  process.env.JUDGE_OUTPUT = 'texte';
  const { arbitrer } = await import('./lib/judge.js');
  const { decisions, meta } = await arbitrer([
    { index: 1, wanted: 'Citron vert bio', quantity: 1, expectedCat1: 'Fruits et Légumes', options: [
      { itemid: 'a', name: 'Citron vert bio filet', cat1: 'Fruits et Légumes' },
      { itemid: 'b', name: 'Jus de citron vert bio', cat1: 'Epicerie salée' },
    ] },
    { index: 2, wanted: 'Citron jaune bio', quantity: 1, options: [
      { itemid: 'a', name: 'Citron jaune Eureka', cat1: 'Fruits et Légumes' },
    ] },
  ]);
  assert.equal(decisions.size, 0, 'un choix fautif est passé');
  assert.equal(meta.rejets.length, 2);
});

await essai('relecture : numéro de ligne conservé', async () => {
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = JSON.stringify(['{"verdict":"problemes","anomalies":[{"ligne":2,"probleme":"banane non bio"},"ancien format"]}']);
  process.env.JUDGE_OUTPUT = 'texte';
  const { relirePanier } = await import('./lib/judge.js');
  const r = await relirePanier({ items: [{ wanted: 'a', quantity: 1 }, { wanted: 'Bananes bio', quantity: 1 }], cart: { items: [] } });
  assert.equal(r.verdict, 'problemes');
  assert.deepEqual(r.anomalies, ['banane non bio', 'ancien format']);
  assert.equal(r.details[0].ligne, 2);
  assert.equal(r.details[1].ligne, null);
});

await essai('relais des codes : muet pendant une connexion du bot', async () => {
  const { debutConnexion, finConnexion, connexionEnCours } = await import('./lib/otp.js');
  finConnexion();
  assert.equal(connexionEnCours(), false);
  debutConnexion();
  assert.equal(connexionEnCours(), true, 'marqueur non vu');
  finConnexion();
  assert.equal(connexionEnCours(), false, 'marqueur non levé');
});

await essai('relais des codes : un code relayé est exclu pour le bot', async () => {
  const { marquerRelaye, lireRelayes } = await import('./lib/otp.js');
  marquerRelaye('00000000');
  assert(lireRelayes().some((e) => e.code === '00000000'), 'code relayé non inscrit');
});

await essai('arbitre désactivé : dégradation propre', async () => {
  process.env.JUDGE_ENABLED = 'false';
  const { relirePanier } = await import('./lib/judge.js');
  const r = await relirePanier({ items: [], cart: { items: [] } });
  assert.equal(r.verdict, 'indisponible');
});

console.log(`\n${ok}/${total} vérifications passées.\n`);
