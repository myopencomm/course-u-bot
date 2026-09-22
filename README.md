# course-u-bot

**Votre liste de courses dans Apple Notes devient votre panier Super U.**

Vous écrivez votre liste comme vous l'avez toujours écrite — en vrac, en français,
en anglais, avec des fautes et des raccourcis de famille. Le programme la lit,
retrouve chaque produit sur [coursesu.com](https://www.coursesu.com), remplit le
panier, vérifie ce qu'il a mis dedans, et vous envoie le bilan.

Vous n'avez plus qu'à choisir votre créneau et valider.

```
Note Apple                          Panier Super U
──────────────                      ──────────────
quick milk                    →     U BIO Lait UHT entier 6x1L      9,18 €
Comté                         →     Comté AOP 24 mois Saut du Doubs 5,22 €
Banana                        →     Banane Cavendish                0,67 €
légumes de saison             →     Carotte · Tomate · Poivron      4,73 €
Vinaigre du vin               →     Vinaigre de vin vieux MAILLE    2,47 €
```

> **Le panier est rempli, jamais validé.** Le programme ne déclenche aucun
> paiement et ne passe aucune commande. La validation reste entre vos mains.

## Ce qu'il sait faire

- **Comprendre une liste écrite normalement.** « Kiwi gold 5 » = 5 kiwis.
  « tomates cerises 500 g » = une barquette de 500 g, pas 500 tomates.
  « Disques le chat 4 en 1 » n'est pas une quantité.
- **Se souvenir de ce que vous achetez.** Il apprend de vos commandes passées et
  reprend vos références habituelles plutôt qu'un produit au hasard.
- **Parler votre langue de famille.** « quick milk » veut dire quelque chose de
  précis chez vous ? Apprenez-le-lui une fois, il s'en souviendra.
- **Choisir pour vous quand c'est évident.** « légumes de saison » devient trois
  légumes du mois, choisis parmi ceux que vous prenez d'habitude.
- **Demander quand ce n'est pas évident**, plutôt que de se tromper en silence.
- **Se relire.** Après remplissage, il compare le panier réel à votre liste et
  signale ce qui cloche.
- **Se lancer depuis Telegram**, pour que toute la famille puisse déclencher les
  courses depuis son téléphone.

## Ce qu'il vous faut

| | |
|---|---|
| **macOS** | La liste est lue dans Apple Notes |
| **Google Chrome** | Le vrai, pas un navigateur automatisé — voir [pourquoi](docs/DEPANNAGE.md) |
| **Node.js 20+** | Le programme est en JavaScript |
| **Un compte Super U** | Avec un magasin déjà sélectionné |
| **Une boîte mail** | Pour lire le code de connexion (Gmail et tout serveur IMAP) |
| *Facultatif* | Un assistant IA en ligne de commande, fortement recommandé |
| *Facultatif* | [OpenClaw](https://openclaw.ai) + Telegram, pour le lancer depuis le téléphone |

## Installation en cinq minutes

```bash
git clone https://github.com/VOTRE-COMPTE/course-u-bot.git
cd course-u-bot
npm install
npm run setup
```

`npm run setup` vous pose les questions une par une et écrit la configuration.
Ensuite :

```bash
npm run login          # une seule fois : connectez-vous dans la fenêtre Chrome
npm run sync-account   # apprend vos habitudes depuis vos commandes passées
npm run build-prefs
npm run prepare-cart   # et c'est parti
```

**Vous n'avez jamais utilisé un terminal ?** Le guide
[docs/INSTALLATION.md](docs/INSTALLATION.md) reprend tout depuis le début, sans
rien supposer.

## Les commandes

| Commande | Ce qu'elle fait |
|---|---|
| `npm run prepare-cart` | Lit la liste et remplit le panier |
| `npm run verify-cart` | Vérifie le panier **sans rien ajouter** |
| `npm run answer -- "1a 2b"` | Répond aux questions restées en suspens |
| `npm run alias -- add "..." "..."` | Apprend un mot de votre vocabulaire |
| `npm run sync-account` | Récupère vos commandes et vos achats fréquents |
| `npm run build-prefs` | Reconstruit ce qu'il sait de vos habitudes |
| `npm run empty-cart -- --confirm` | Vide le panier |
| `npm run check-privacy` | Vérifie qu'aucune donnée perso ne part sur GitHub |

Ajoutez `--dry-run` à `prepare-cart` pour voir ce qu'il ferait sans rien toucher.

## Documentation

- [Installation pas à pas](docs/INSTALLATION.md) — pour débutant complet
- [Lancer les courses depuis Telegram](docs/TELEGRAM.md) — le montage familial
- [Personnalisation](docs/PERSONNALISATION.md) — vocabulaire, saisons, réglages
- [Dépannage](docs/DEPANNAGE.md) — quand ça coince, et pourquoi

## Vos données restent chez vous

Le programme manipule des identifiants, votre historique d'achats et vos listes
de courses. Rien de tout cela ne quitte votre ordinateur.

- Le fichier `.env` et tout le dossier `data/` sont exclus de git.
- `npm run check-privacy` inspecte ce que git s'apprête à publier et **refuse**
  s'il y trouve une adresse mail, un code, un numéro de commande, un chemin
  personnel — ou l'un des prénoms que vous listez dans `PRIVACY_NAMES`. Il
  s'installe en garde-fou automatique à chaque commit.
- Le code de connexion reçu par e-mail est **supprimé** après usage.

## À savoir avant de vous lancer

Ce programme pilote un site commercial qui ne lui doit rien. En clair :

- **Il peut casser du jour au lendemain.** Si Super U modifie son site, les
  repères changent. Le [dépannage](docs/DEPANNAGE.md) explique où regarder.
- **Usage personnel.** Il reproduit ce que vous feriez à la main, à votre
  rythme, avec votre compte. Ne l'utilisez pas pour autre chose.
- **Il ne valide jamais de commande.** C'est volontaire et ça ne changera pas.
- **La reconnaissance des produits n'est pas parfaite.** Il demande quand il
  doute, mais relisez le panier avant de valider. Le mot de la fin vous revient.

## Licence

MIT — voir [LICENSE](LICENSE). Faites-en ce que vous voulez, sans garantie.
