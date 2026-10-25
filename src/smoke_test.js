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
  const poire = parseLine('Poire x4');
  assert.equal(poire.quantity, 4, '« x4 » non lu');
  assert.equal(poire.wanted, 'Poire', '« x4 » laissé dans la recherche');
  const charlotte = parseLine('Pomme Charlotte x500g');
  assert.equal(charlotte.quantity, 1, 'un poids collé n est pas une quantité');
  assert.equal(charlotte.sizeHint, '500 g');
  assert.equal(charlotte.wanted, 'Pomme Charlotte');
  assert.equal(parseLine('Œuf x12 bio').wanted, 'Œuf bio');
});

await essai('quantité selon le conditionnement', async () => {
  const { quantitePour } = await import('./lib/catalog.js');
  const { normalize } = await import('./lib/normalize.js');
  assert.equal(quantitePour('Pomme Golden Delicious - Barquette 4 fruits', 4), 1, 'quatre barquettes de 4');
  assert.equal(quantitePour('Oeufs frais bio U, x6', 12), 2);
  assert.equal(quantitePour('Poire Conférence', 4), 4, 'vendu à la pièce');
  assert.equal(quantitePour('Yaourt nature 4x125g', 8), 2);
  assert.equal(quantitePour('Eau minérale 6x1l', 1), 1);
  assert.equal(normalize('Œufs'), 'oeufs', 'ligature perdue');
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
    { index: 1, wanted: 'Citron vert bio', quantity: 1, expectedCat1: 'Fruits et Légumes', rayonCertain: true, options: [
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

await essai('bio : la marque compte (U BIO)', async () => {
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = JSON.stringify(['{"ligne":1,"itemid":"l","doute":"aucun","confiance":0.9,"raison":"x"}']);
  process.env.JUDGE_OUTPUT = 'texte';
  const { arbitrer } = await import('./lib/judge.js');
  const { decisions } = await arbitrer([{ index: 1, wanted: 'Lardons fumé bio', quantity: 1, options: [
    { itemid: 'l', name: 'Lardons fumés - 2x75g', brand: 'U BIO' },
  ] }]);
  assert(decisions.has(1), 'produit U BIO refusé comme non bio');
  const { rank } = await import('./lib/catalog.js');
  const r = rank([
    { itemid: 'n', name: 'Lardons fumés - 2x75g', brand: 'U', addable: true, available: true },
    { itemid: 'b', name: 'Lardons fumés - 2x75g', brand: 'U BIO', addable: true, available: true },
  ], { wanted: 'Lardons fumés bio', prefs: { products: {} } });
  assert.equal(r[0].itemid, 'b', 'le bio par la marque doit passer devant');
});

await essai('arbitre : un rayon deviné ne suffit pas à refuser', async () => {
  // Le site range le paprika en fruits et légumes : un rayon supposé par
  // l'interprétation ne doit pas bloquer ce choix.
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = JSON.stringify(['{"ligne":1,"itemid":"a","confiance":0.9,"raison":"x"}']);
  process.env.JUDGE_OUTPUT = 'texte';
  const { arbitrer } = await import('./lib/judge.js');
  const { decisions } = await arbitrer([
    { index: 1, wanted: 'Paprika', quantity: 1, expectedCat1: 'Epicerie salée', rayonCertain: false, options: [
      { itemid: 'a', name: 'Paprika doux moulu', cat1: 'Fruits et Légumes' },
    ] },
  ]);
  assert.equal(decisions.size, 1);
});

await essai('arbitre : options plausibles, relance et quantité plafonnée', async () => {
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = JSON.stringify([
    '{"ligne":1,"itemid":null,"confiance":0,"plausibles":[],"requete":"oignons rouges","raison":"aucun oignon"}\n'
    + '{"ligne":2,"itemid":"p","quantite":9,"confiance":0.95,"plausibles":["inconnu","q"],"requete":null,"raison":"poires"}\n'
    + '{"ligne":3,"itemid":"s","confiance":0.6,"plausibles":["t"],"requete":null,"raison":"hesitation"}',
  ]);
  process.env.JUDGE_OUTPUT = 'texte';
  const { arbitrer } = await import('./lib/judge.js');
  const r = await arbitrer([
    { index: 1, wanted: 'Red onion', quantity: 1, options: [{ itemid: 'rb', name: 'Red Bull 250ml' }] },
    { index: 2, wanted: 'Poire', quantity: 4, options: [{ itemid: 'p', name: 'Poire Conférence' }, { itemid: 'q', name: 'Poire Williams' }] },
    { index: 3, wanted: 'Sel', quantity: 1, options: [{ itemid: 's', name: 'Sel fin' }, { itemid: 't', name: 'Sel de Guérande' }] },
  ]);
  assert.deepEqual(r.plausibles.get(1), [], 'du hors sujet proposé');
  assert.equal(r.relances.get(1), 'oignons rouges');
  assert.equal(r.decisions.get(2).quantite, 4, 'quantité gonflée par l arbitre');
  const ids = (n) => r.plausibles.get(n).map((p) => p.itemid);
  assert.deepEqual(ids(2), ['p', 'q'], 'id inventé conservé');
  assert(!r.decisions.has(3), 'confiance insuffisante acceptée');
  assert.deepEqual(ids(3), ['s', 't'], 'le choix écarté doit rester proposé');
});

await essai('arbitre : le doute déclaré prime sur la confiance', async () => {
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = JSON.stringify([
    '{"ligne":1,"itemid":"s","doute":"preference","confiance":0.6,"plausibles":[],"raison":"sel courant"}\n'
    + '{"ligne":2,"itemid":"c","doute":"reel","confiance":0.9,"plausibles":[],"raison":"2,5 kg pour 500 g"}',
  ]);
  process.env.JUDGE_OUTPUT = 'texte';
  const { arbitrer } = await import('./lib/judge.js');
  const r = await arbitrer([
    { index: 1, wanted: 'Salt', quantity: 1, options: [{ itemid: 's', name: 'Sel fin' }, { itemid: 't', name: 'Sel de Guérande' }] },
    { index: 2, wanted: 'Pomme Charlotte', quantity: 1, options: [{ itemid: 'c', name: 'Pomme de terre Charlotte filet 2,5kg' }] },
  ]);
  assert(r.decisions.has(1), 'un défaut raisonnable doit être pris');
  assert(!r.decisions.has(2), 'un vrai doute doit revenir à l utilisateur');
  assert.deepEqual(r.plausibles.get(2).map((p) => p.itemid), ['c']);
});

await essai('arbitre : quantité par option, bio d abord', async () => {
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = JSON.stringify([
    '```json\n{"ligne":1,"itemid":null,"confiance":0.5,"plausibles":[{"id":"nb","quantite":1},{"id":"b6","quantite":2},{"id":"b12","quantite":40}],"requete":null,"raison":"x"}\n```',
  ]);
  process.env.JUDGE_OUTPUT = 'texte';
  const { arbitrer } = await import('./lib/judge.js');
  const r = await arbitrer([{ index: 1, wanted: 'Œuf bio', quantity: 12, options: [
    { itemid: 'nb', name: 'Oeufs plein air boîte de 10' },
    { itemid: 'b6', name: 'Oeufs bio boîte de 6' },
    { itemid: 'b12', name: 'Oeufs bio x12' },
  ] }]);
  assert.deepEqual(r.plausibles.get(1), [{ itemid: 'b6', quantite: 2 }, { itemid: 'b12', quantite: 12 }], 'non bio proposé, ou quantité non bornée');
});

await essai('interprétation : requêtes, rayon, bio et saison', async () => {
  process.env.JUDGE_ENABLED = 'true';
  process.env.JUDGE_CMD = 'echo';
  process.env.JUDGE_ARGS = JSON.stringify([
    '{"ligne":1,"produit":"sel fin","requetes":["sel fin","sel"],"rayon":"epicerie salee","saison":null}\n'
    + '{"ligne":2,"produit":"lardons fumés","requetes":["lardons fumés bio"],"rayon":"Rayon inventé","saison":null}\n'
    + '{"ligne":3,"produit":"fruits de saison","requetes":["fruits"],"rayon":"Fruits et Légumes","saison":"fruits"}',
  ]);
  process.env.JUDGE_OUTPUT = 'texte';
  const { planifier } = await import('./lib/judge.js');
  const { RAYONS } = await import('./lib/catalog.js');
  const { plans, meta } = await planifier(
    [{ wanted: 'Salt', quantity: 1 }, { wanted: 'Lardons fumé bio', quantity: 1 }, { wanted: 'Seconal fruits', quantity: 1 }, { wanted: 'Oubliée', quantity: 1 }],
    { rayons: RAYONS },
  );
  assert(!meta.erreur);
  assert.deepEqual(plans[0].requetes, ['sel fin', 'sel']);
  assert.equal(plans[0].rayon, 'Epicerie salée', 'rayon non recopié tel que sur le site');
  assert.equal(plans[1].rayon, null, 'rayon inconnu accepté');
  assert.equal(plans[1].produit, 'lardons fumés bio', 'exigence bio perdue');
  assert.equal(plans[2].saison, 'fruits');
  assert.equal(plans[3], null, 'ligne sans réponse');
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
