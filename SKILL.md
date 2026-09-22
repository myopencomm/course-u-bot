---
name: course-u-bot
description: Remplit le panier Super U (coursesu.com) à partir d'une note Apple, pose les questions restantes sur Telegram, vérifie le panier et synchronise l'historique de commandes. Utiliser quand quelqu'un demande de faire les courses, préparer le panier, vérifier le panier, répondre aux questions du bot courses, ou synchroniser l'historique.
---

# course-u-bot — courses Super U

Installation du programme : voir `INSTALL_DIR` ci-dessous. Remplacez-le par le
chemin où vous avez cloné le dépôt, par exemple `~/Projects/course-u-bot`.

**Le panier est rempli, jamais validé.** Aucun paiement n'est déclenché : la
commande reste à valider par un humain.

## 1. Faire les courses

Déclencheurs : « fais les courses », « prépare le panier », « Make my shopping ».

```bash
cd INSTALL_DIR && npm run prepare-cart
```

Le programme lit la section de courses dans la note Apple, résout chaque ligne
(historique d'achats d'abord, puis recherche catalogue, puis arbitrage par une
IA en ligne de commande), remplit le panier, **relit le panier pour vérifier ce
qui s'y trouve vraiment**, puis envoie le bilan et les éventuelles questions.

Si le site réclame un code de connexion, le programme le récupère seul dans la
boîte mail et **supprime ensuite le message**. En cas d'échec, écrivez le code
dans le fichier de dépannage et il repart :

```bash
echo "12345678" > INSTALL_DIR/data/otp_inbox.txt
```

## 2. Vérifier le panier sans rien ajouter

Déclencheurs : « où en est le panier ? », « vérifie le panier », « c'est bon ? ».

```bash
cd INSTALL_DIR && npm run verify-cart
```

**Ne jamais répondre à partir de `data/bilan.v2.json` seul.** Ce fichier date du
dernier `prepare-cart` et peut décrire un état révolu. `verify-cart` relit le
panier réel et réécrit le bilan : c'est lui qui fait foi.

`prepare-cart` **ajoute** toujours et ne vide jamais : ne pas le relancer pour
« voir où on en est », sous peine de doubler les quantités.

## 3. Répondre aux questions

Quand l'utilisateur répond (« 1a 2b », « pour la 2 prends la b », « 3 skip »),
traduire au format `Na` / `N skip` puis :

```bash
cd INSTALL_DIR && npm run answer -- "1a 2b 3skip"
```

Les questions en attente sont dans `data/questions.v2.json`.

## 4. Vocabulaire du foyer

Chaque famille a ses raccourcis : « quick milk » pour un lait précis, un surnom
pour une marque. Quand l'utilisateur dit « X veut dire Y » :

```bash
cd INSTALL_DIR
npm run alias -- add "quick milk" "Lait UHT entier bio" 5870443
npm run alias -- list
npm run alias -- remove "quick milk"
```

Le troisième argument (identifiant produit) est facultatif mais rend le choix
certain. On le trouve dans l'URL du produit : `/p/nom-du-produit/<identifiant>.html`.

## 5. Produits de saison

« légumes de saison », « fruits de saison » et leurs équivalents anglais
« seasonal vegetables » / « seasonal fruits » se développent automatiquement.
Le mois de la commande détermine ce qui est de saison, et le choix privilégie ce
que le foyer achète réellement.

**Sans chiffre, le bot en met trois** — c'est l'écriture la plus courante. Un
nombre explicite reste prioritaire (« 2 fruits de saison » → 2).

## 6. Synchroniser le compte

Déclencheurs : « synchronise les courses », « apprends mes commandes ».

```bash
cd INSTALL_DIR && npm run sync-account && npm run build-prefs
```

À lancer après chaque commande passée : plus l'historique est riche, moins le
bot pose de questions.

## Statuts du bilan

`added` ajouté · `question` en attente de réponse · `clicked_but_absent` cliqué
mais absent du panier à la relecture · `not_found` introuvable · `error` échec
isolé sur cette ligne.

## Navigateur — ne pas modifier

Le programme pilote **le vrai Chrome** via le port de débogage, et non le
navigateur intégré de Playwright. C'est ce qui fait passer la vérification
anti-robot de la page de connexion. Chrome reste volontairement ouvert entre les
runs : ne pas le fermer, ne pas basculer sur un navigateur piloté.

## Règle de conduite

Confirmer brièvement, lancer la commande sans demander d'autorisation, relayer
le bilan et les questions. Ne pas modifier les scripts en passant.
