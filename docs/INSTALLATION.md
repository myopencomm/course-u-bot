# Installation pas à pas

Ce guide ne suppose aucune connaissance. Si vous n'avez jamais ouvert un
terminal, suivez-le dans l'ordre, ça ira.

Comptez une demi-heure la première fois.

---

## Étape 0 — Ouvrir le Terminal

Le Terminal est une application déjà installée sur votre Mac. Appuyez sur
`Cmd + Espace`, tapez `Terminal`, appuyez sur Entrée.

Une fenêtre s'ouvre avec du texte et un curseur qui clignote. C'est là que vous
taperez les commandes de ce guide. **Copiez-collez-les**, c'est plus sûr que de
les retaper, et appuyez sur Entrée après chacune.

Quand une commande a fini, le curseur revient. S'il ne revient pas, attendez.

---

## Étape 1 — Installer Node.js

Node.js fait tourner le programme. Vérifiez s'il est déjà là :

```bash
node --version
```

- Si vous voyez `v20.x.x` ou plus grand, passez à l'étape 2.
- Si vous voyez `command not found`, ou un numéro inférieur à 20, téléchargez la
  version **LTS** sur [nodejs.org](https://nodejs.org) et installez-la comme
  n'importe quelle application. Puis **fermez et rouvrez le Terminal**, et
  revérifiez.

---

## Étape 2 — Installer Google Chrome

Le vrai Chrome, depuis [google.com/chrome](https://www.google.com/chrome/).

Ce n'est pas un détail : le programme pilote ce Chrome-là précisément, parce que
la page de connexion Super U est protégée par une vérification anti-robot qui ne
laisse pas passer un navigateur automatisé. Le [dépannage](DEPANNAGE.md) explique
le mécanisme.

---

## Étape 3 — Télécharger le programme

```bash
cd ~/Documents
git clone https://github.com/VOTRE-COMPTE/course-u-bot.git
cd course-u-bot
npm install
```

La dernière commande télécharge les briques nécessaires. Elle prend une à deux
minutes et affiche beaucoup de texte : c'est normal.

> `git: command not found` ? Tapez `xcode-select --install` et acceptez
> l'installation proposée, puis recommencez.

---

## Étape 4 — Le mot de passe d'application Gmail

À chaque connexion, Super U envoie un code à 8 chiffres par e-mail. Le programme
doit pouvoir lire votre boîte pour le récupérer.

**On ne lui donne pas le mot de passe de votre compte Google.** On crée un mot de
passe séparé, réservé à ce programme, révocable à tout moment.

1. Allez sur [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Si la page refuse : activez d'abord la validation en deux étapes sur votre
   compte Google, les mots de passe d'application en dépendent
3. Donnez un nom, par exemple `course-u-bot`
4. Google affiche 16 caractères. **Copiez-les maintenant**, ils ne seront plus
   affichés ensuite

Si vous n'utilisez pas Gmail, notez le serveur IMAP de votre fournisseur : vous
pourrez l'indiquer dans la configuration.

---

## Étape 5 — Préparer la note dans Apple Notes

Ouvrez Notes et créez une note intitulée exactement **Shopping List**.

Dedans, écrivez :

```
PROCHAIN SUPERMARCHÉ

Lait demi-écrémé 3 bouteilles
Bananes
Comté
```

Le programme ne lit **que** ce qui suit la ligne `PROCHAIN SUPERMARCHÉ`, et
s'arrête au prochain titre en majuscules. Vous pouvez donc garder vos autres
notes de courses dans le même fichier sans le gêner.

Écrivez comme vous en avez l'habitude : le programme gère les quantités en fin de
ligne, les poids, les fautes de frappe et les mélanges français/anglais.

---

## Étape 6 — La configuration

```bash
npm run setup
```

L'assistant pose ses questions une par une. Répondez, appuyez sur Entrée.
Il écrit un fichier `.env` lisible par vous seul, que git ne publiera jamais.

---

## Étape 7 — La première connexion

```bash
npm run login
```

Une fenêtre Chrome s'ouvre sur la page de connexion Super U. **Connectez-vous
normalement**, à la main. La case « Vérifiez que vous êtes humain » se coche
d'elle-même après quelques secondes — laissez-la faire.

Une fois connecté, le Terminal affiche `✅ Session enregistrée`. Cette session est
réutilisée ensuite : vous n'aurez plus à refaire cette étape, sauf expiration.

---

## Étape 8 — Lui apprendre vos habitudes

```bash
npm run sync-account
npm run build-prefs
```

Le programme récupère vos commandes passées et la liste de vos achats fréquents
calculée par Super U, puis en tire ce qu'il sait de vous.

**C'est cette étape qui fait la différence** entre un bot qui pose dix questions
et un bot qui remplit le panier tout seul. Relancez-la après chaque commande.

---

## Étape 9 — Les courses

```bash
npm run prepare-cart
```

Pour voir ce qu'il ferait **sans rien toucher** au panier :

```bash
npm run prepare-cart -- --dry-run
```

C'est une bonne façon de prendre confiance les premières fois.

---

## Et ensuite

- **L'arbitrage par une IA** réduit beaucoup les questions :
  [PERSONNALISATION.md](PERSONNALISATION.md#larbitrage-par-une-ia)
- **Lancer les courses depuis le téléphone**, pour toute la famille :
  [TELEGRAM.md](TELEGRAM.md)
- **Lui apprendre votre vocabulaire** :
  [PERSONNALISATION.md](PERSONNALISATION.md#le-vocabulaire-de-votre-foyer)
- **Quelque chose ne marche pas** : [DEPANNAGE.md](DEPANNAGE.md)
