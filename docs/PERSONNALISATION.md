# Personnalisation

Trois réglages font la différence entre un bot qui pose dix questions et un bot
qui remplit le panier tout seul.

---

## Le vocabulaire de votre foyer

Chaque famille a ses raccourcis. Chez l'un, « quick milk » désigne un lait précis.
Chez l'autre, « le chocolat des enfants » ne laisse aucun doute — sauf pour un
programme, qui n'a aucun moyen de le deviner.

Apprenez-les-lui une fois :

```bash
npm run alias -- add "quick milk" "Lait UHT entier bio"
npm run alias -- list
npm run alias -- remove "quick milk"
```

**Épinglez la référence exacte** quand c'est toujours le même produit. Ajoutez
son identifiant, lisible dans l'URL du produit (`/p/nom-du-produit/5870443.html`) :

```bash
npm run alias -- add "quick milk" "Lait UHT entier bio" 5870443
```

Avec un identifiant épinglé, le bot ne raisonne plus : il va chercher ce
produit-là. C'est le moyen le plus sûr d'obtenir exactement ce que vous voulez.

Le vocabulaire est dans `data/lexique.json`, modifiable à la main si vous
préférez. Il n'est jamais publié.

**La tolérance est prévue** : une entrée « quick milk » reconnaît aussi
« quick milk bio ».

---

## Les produits de saison

Écrivez dans votre liste :

```
légumes de saison
fruits de saison
```

ou, en anglais, `seasonal vegetables` / `seasonal fruits`.

Le bot regarde le mois de la commande, consulte le calendrier
(`data/saisons.json`, France métropolitaine), et choisit **parmi ce que vous
achetez d'habitude**. Il ne se répète jamais d'une ligne à l'autre.

**Sans chiffre, il en met trois.** C'est l'écriture la plus courante. Un nombre
explicite reste prioritaire :

```
2 fruits de saison        → 2
1 légume de saison        → 1
légumes de saison         → 3
```

Ces lignes ne posent jamais de question : demander « quelle variété de poire ? »
irait contre l'intention.

**Adapter le calendrier.** `data/saisons.json` est un simple fichier par mois.
Si vous n'êtes pas en France métropolitaine, ou si vos habitudes diffèrent,
modifiez-le. Les listes sont ordonnées du plus courant au plus spécifique.

---

## L'arbitrage par une IA

Sans lui, le bot fonctionne mais cherche chaque ligne mot à mot et pose
nettement plus de questions. Sur une liste réelle de 36 lignes, mi-français
mi-anglais : **15 questions sans IA, 2 avec**.

Il intervient à trois moments, chaque fois en un seul appel pour toute la liste :

1. **Interpréter** la liste avant toute recherche : anglais, fautes, abréviations
   deviennent des requêtes françaises (« Lamb mince » → viande hachée d'agneau),
   avec le rayon attendu. Une ligne de saison mal écrite (« Seconal fruits ») est
   reconnue et développée comme les autres.
2. **Choisir** parmi les produits trouvés. Il voit le nom, la marque, le rayon,
   le prix, la note et vos achats passés. Il sait qu'un oignon rouge n'est pas
   un Red Bull, qu'un vinaigre « à l'estragon » est aromatisé, que « U BIO » est
   bio. Il calcule aussi la quantité : 12 œufs, ce sont 2 boîtes de 6.
3. **Relire** le panier final et retirer ce qui ne correspond pas à la liste.

Avec lui, **rien n'entre au panier sans son accord**, pas même un produit déjà
acheté (seules les références épinglées dans votre vocabulaire passent
directement). Votre historique reste un argument : à qualité égale, il reprend
ce que vous achetez.

Il ne vous pose une question qu'en cas de vrai doute : qualificatif demandé
introuvable (bio, fumé…), format très différent (2,5 kg pour 500 g demandés),
nature du produit incertaine. Avant de demander, il relance la recherche avec
d'autres termes. Les options proposées sont toutes plausibles.

**Le programme ne dépend d'aucun fournisseur.** Il lance la commande que vous
choisissez. Préréglages fournis :

| `JUDGE_PRESET` | Commande attendue |
|---|---|
| `claude` | `claude` |
| `gemini` | `gemini` |
| `ollama` | `ollama` — tourne en local, gratuit |
| `codex` | `codex` |

Dans votre `.env` :

```bash
JUDGE_ENABLED=true
JUDGE_PRESET=ollama
JUDGE_MODEL=llama3.1
JUDGE_THRESHOLD=0.8
```

Le préréglage `claude` lance le CLI sans outils ni serveurs MCP et avec son
propre prompt système : un appel coûte moins d'un centime et prend 5 à 30 s.
`JUDGE_MODEL` vaut `sonnet` par défaut, l'alias de la dernière version.

`JUDGE_THRESHOLD` ne sert qu'aux CLI qui ne renseignent pas le champ « doute » de
la réponse : c'est alors le niveau de confiance au-dessus duquel le bot décide
seul. `JUDGE_TIMEOUT_MS` (180 000 par défaut) borne la durée d'un appel.

**Un autre CLI ?** Décrivez-le vous-même :

```bash
JUDGE_CMD=mon-assistant
JUDGE_ARGS=["-p","{system}\n\n{prompt}","--model","{model}"]
JUDGE_OUTPUT=texte
```

Les marqueurs `{prompt}`, `{system}` et `{model}` sont remplacés à l'appel. Avec
`JUDGE_OUTPUT=json`, `JUDGE_RESULT_KEY` indique la clé contenant la réponse.

**Pour vous en passer :** `JUDGE_ENABLED=false`. Le bot cherchera chaque ligne
telle qu'écrite et posera les questions lui-même.

---

## Le magasin

Par défaut, le programme reprend le magasin déjà sélectionné sur votre compte.

Si vous en changez souvent, forcez-en un :

```bash
COURSESU_STORE_PATH=drive-superu-nantes
```

La valeur est ce qui suit `coursesu.com/` dans l'URL de votre magasin.

---

## La note lue

```bash
NOTE_TITLE=Shopping List
NOTE_SECTION=PROCHAIN SUPERMARCH
```

Le programme lit la note portant ce titre exact, et n'y traite que ce qui suit la
ligne de section, jusqu'au prochain titre en majuscules. Vous pouvez donc tenir
plusieurs listes dans la même note.

---

## Ce qu'il apprend tout seul

Après chaque commande passée :

```bash
npm run sync-account
npm run build-prefs
```

Il récupère vos commandes et la liste d'achats fréquents calculée par Super U, et
en tire une confiance par produit : fréquence d'achat, présence dans la dernière
commande, appartenance à vos habitudes.

**C'est le réglage qui compte le plus.** Un produit acheté quatre fois l'emporte
sur un produit mieux nommé mais jamais pris. Sans cet historique, le bot navigue
à vue.
