# Dépannage

Les problèmes réellement rencontrés, leur cause, et ce qui les règle. Chacun a
coûté du temps : voici ce qu'il fallait savoir.

---

## La case « Vérifiez que vous êtes humain » ne se coche jamais

**Symptôme.** La fenêtre Chrome s'ouvre, le formulaire se remplit, mais la case
Cloudflare reste vide et le bouton **Continuer** reste grisé.

**Cause.** La page de connexion est protégée par un Turnstile Cloudflare. Il se
valide passivement — mais seulement dans un vrai navigateur. Dans un navigateur
lancé par Playwright, `navigator.webdriver` vaut `true` et la validation échoue.

**Ce qui marche.** Le programme démarre **le vrai Chrome** avec un port de
débogage, puis s'y attache. Chrome se lance normalement, avec un profil vieilli
et une empreinte ordinaire ; le jeton se remplit tout seul en quelques secondes.

**Donc :**
- ne remplacez pas Chrome par le navigateur intégré de Playwright ;
- ne supprimez pas le dossier `.chrome-profile/` — son ancienneté aide ;
- ne fermez pas Chrome entre deux runs, la session reste chaude.

Si la case ne se coche toujours pas après 45 secondes, la fenêtre est visible :
cochez-la à la main, le programme continue.

---

## « Aucun code de vérification reçu »

**Symptôme.** Le programme attend le code, puis abandonne — alors que le mail est
bien arrivé.

**Trois causes possibles, dans l'ordre de fréquence.**

**1. Le mail arrive avant que le chronomètre ne démarre.** Le code est envoyé à la
soumission du formulaire, mais l'instant de référence n'est fixé qu'après la
validation anti-robot, qui prend des dizaines de secondes. Un code légitime
pouvait donc être rejeté comme périmé. Le programme accepte désormais les mails
reçus jusqu'à 4 minutes *avant* ce repère, et tient un registre des codes déjà
présentés pour ne jamais en rejouer un.

**2. Le mot de passe d'application est invalide.** Testez-le :
```bash
npm run verify-cart
```
Un message `lecture Gmail en échec` pointe ce problème. Recréez-en un.

**3. Le mail a été archivé ou supprimé.** Le programme cherche dans la boîte de
réception, dans « Tous les messages » **et dans la corbeille** — ce dernier point
est indispensable si une automatisation nettoie votre boîte.

**Solution de secours.** Écrivez le code à la main, le programme le verra :
```bash
echo "12345678" > data/otp_inbox.txt
```

---

## Le bot met un produit au lieu d'un autre

**Symptôme.** Vous demandez « Citron vert », il met du citron jaune. Ou des
poires au sirop au lieu de poires fraîches.

**Ce qu'il faut comprendre.** Le rapprochement se fait en trois couches :
l'historique d'achat, puis le libellé, puis le rayon. Un produit que vous achetez
souvent l'emporte sur un produit mieux nommé.

**Ce qui aide, dans l'ordre :**

1. **Lancez `npm run sync-account` puis `npm run build-prefs`.** Sans historique,
   le bot navigue à vue.
2. **Épinglez la référence** si c'est toujours le même produit :
   ```bash
   npm run alias -- add "citron vert" "Citron Lime" 7502938
   ```
   L'identifiant se lit dans l'URL du produit : `/p/citron-lime/7502938.html`.
3. **Activez l'arbitrage par une IA** — c'est lui qui sait qu'un vinaigre « à
   l'estragon » est aromatisé alors que « vieux » ne l'est pas.

---

## Le panier contient des articles en double

**Cause.** `prepare-cart` **ajoute** toujours au panier existant, il ne le vide
jamais. Le relancer double les quantités.

**Pour savoir où vous en êtes sans rien modifier :**
```bash
npm run verify-cart
```

**Pour repartir de zéro :**
```bash
npm run empty-cart -- --confirm
```

---

## Le bot dit que le panier est incohérent alors qu'il est correct

**Cause.** Il répond peut-être à partir de `data/bilan.v2.json`, écrit lors du
dernier remplissage. Ce fichier peut décrire un état révolu.

**Solution.** `npm run verify-cart` relit le panier réel et réécrit le bilan.
C'est cette lecture-là qui fait foi.

---

## Tout marchait, et d'un coup plus rien

**Le site a probablement changé.** Ce programme s'appuie sur la structure des
pages de coursesu.com, qui peut évoluer sans préavis.

Les repères à vérifier en premier, dans `src/lib/` :

| Où | Repère | Ce qu'il désigne |
|---|---|---|
| `catalog.js` | `#search-result-items .product-tile` | Les résultats de recherche |
| `cart.js` | `#cart-table .cart-row` | Les lignes du panier |
| `cart.js` | `[data-global-login-cta="productAddition"]` | Le bouton d'ajout |
| `session.js` | `window.tc_vars` | L'état de connexion et le magasin |

**Un piège récurrent : les carrousels.** Les pages affichent des produits
suggérés qui ressemblent aux vrais. Une page de résultats porte 38 tuiles dont
20 de carrousel ; une page panier porte 131 éléments pour 5 articles. Tout
sélecteur doit être limité au conteneur réel, sinon le bot ajoute n'importe quoi.

Pour inspecter : ouvrez la page dans Chrome, `Cmd+Option+I`, onglet Console.

---

## Rien ne se passe quand j'écris dans le groupe Telegram

Voir [TELEGRAM.md](TELEGRAM.md#quand-rien-ne-se-passe) — c'est presque toujours
l'une de trois causes, et elles sont toutes rapides à vérifier.

---

## Comment voir ce qui se passe vraiment

```bash
npm run prepare-cart -- --dry-run
```

Parcourt toute la chaîne contre le site réel et affiche chaque décision, sans
rien modifier. C'est le meilleur outil de diagnostic.

Pour les scores détaillés, regardez `data/bilan.v2.json` après un run : chaque
ligne y porte son statut, le produit retenu et la raison du choix.
