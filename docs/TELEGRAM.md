# Lancer les courses depuis Telegram

Le but : que n'importe qui à la maison écrive « fais les courses » dans un groupe
Telegram, et que le panier se remplisse.

Ce guide suppose [OpenClaw](https://openclaw.ai) installé et fonctionnel avec un
bot Telegram. Si ce n'est pas le cas, commencez par sa documentation.

---

## Deux montages possibles

**Le simple.** Vous parlez à votre bot OpenClaw en message privé. Rien à
configurer de plus que `TELEGRAM_TARGET` dans le `.env`. Ça marche tout de suite,
mais vous êtes seul à pouvoir déclencher.

**Le familial.** Un groupe où tout le monde peut lancer les courses. C'est le
montage décrit ci-dessous. Il demande une demi-heure, dont vingt minutes de
choses non évidentes que ce guide vous épargne.

---

## Installer le skill dans OpenClaw

```bash
openclaw skills install git:https://github.com/VOTRE-COMPTE/course-u-bot --as course-u-bot
```

Puis ouvrez le fichier `SKILL.md` installé et remplacez `INSTALL_DIR` par le
chemin réel du programme, par exemple `~/Documents/course-u-bot`.

Vérifiez qu'il est reconnu :

```bash
openclaw skills list | grep course-u
```

---

## Le montage familial, étape par étape

### 1. Un bot dédié au groupe

Vous **pouvez** utiliser votre bot OpenClaw habituel, mais c'est déconseillé :
l'étape suivante l'obligerait à lire tous les messages de tous ses groupes.
Créez plutôt un bot séparé.

Dans Telegram, parlez à `@BotFather` :

```
/newbot
```

Donnez-lui un nom, notez le **token** qu'il vous renvoie. Ajoutez ce bot à votre
groupe familial.

### 2. Désactiver le mode privacy — indispensable

Par défaut, un bot Telegram ne voit dans un groupe que les messages qui le
mentionnent. Sans cette étape, il ne verra jamais « fais les courses ».

Toujours dans `@BotFather` :

```
/setprivacy  →  choisissez votre bot  →  Disable
```

Pour vérifier, remplacez `<TOKEN>` par le vôtre et ouvrez cette adresse dans un
navigateur :

```
https://api.telegram.org/bot<TOKEN>/getMe
```

Vous devez y lire `"can_read_all_group_messages": true`.

### 3. L'identifiant du groupe

Ajoutez temporairement `@RawDataBot` au groupe : il affiche l'identifiant, un
nombre **négatif** du type `-1001234567890`. Retirez-le ensuite.

### 4. Déclarer le bot dans OpenClaw

Ajoutez son token à `~/.openclaw/.env` :

```
PENGUIN_BOT_TOKEN=le-token-donné-par-BotFather
```

Créez un fichier `patch.json` :

```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "famille": {
          "name": "Bot des courses",
          "enabled": true,
          "botToken": { "source": "env", "provider": "default", "id": "PENGUIN_BOT_TOKEN" },
          "groupPolicy": "allowlist",
          "groupAllowFrom": ["*"],
          "groups": {
            "-VOTRE_ID_DE_GROUPE": {
              "enabled": true,
              "requireMention": false,
              "skills": ["course-u-bot"],
              "systemPrompt": "Ce groupe sert à déclencher les courses. Quand un message demande de faire les courses, utilise le skill course-u-bot pour préparer le panier, puis renvoie le bilan ici. Quand quelqu'un répond aux questions du bilan (par exemple \"1a 2b 3skip\"), applique ces réponses. Ne réponds à aucun autre message."
            }
          }
        }
      }
    }
  }
}
```

Appliquez-le :

```bash
openclaw config patch --file patch.json --dry-run   # vérification
openclaw config patch --file patch.json
```

### 5. Lier le compte à un agent — l'étape qu'on oublie

**C'est ici que ça coince presque toujours.** Un compte de canal secondaire est
ignoré en silence tant qu'aucune liaison d'agent n'existe. Les messages arrivent,
sont autorisés, puis jetés sans trace visible au niveau de log normal.

```bash
openclaw agents bind --agent main --bind telegram:famille
openclaw agents bind --agent main --bind telegram:default
openclaw agents bindings
```

La deuxième ligne n'est pas superflue : dès qu'une liaison existe, le compte
principal perd le repli implicite dont il bénéficiait.

### 6. Redémarrer

```bash
openclaw gateway restart
```

Un compte de canal ajouté **n'est pas pris à chaud**, contrairement à d'autres
réglages. Sans redémarrage, rien ne se passera.

### 7. Essayer

Écrivez « fais les courses » dans le groupe.

---

## Quand rien ne se passe

Activez les logs détaillés — la cause est presque toujours visible, et invisible
sans eux :

```bash
openclaw config patch --file <(echo '{"logging":{"level":"debug"}}')
openclaw gateway restart
openclaw logs --limit 200 --local-time | grep -iE "update received|drop|resolveAgentRoute"
```

| Ce que vous lisez | Ce que ça veut dire |
|---|---|
| *rien du tout* | Le bot n'est pas dans le groupe, ou le mode privacy est actif |
| `Invalid allowFrom entry` | Un identifiant de groupe est dans `allowFrom` ; ces listes n'acceptent que des identifiants d'**utilisateurs**. Les groupes s'autorisent via `groups` |
| `drop non-default account requires explicit binding` | Étape 5 oubliée |
| `update received` puis plus rien | Le gateway n'a pas redémarré depuis le changement de config |

Une liste `allowFrom` **non vide mais entièrement invalide** rejette tout le
monde : c'est le pire cas, elle a l'air configurée et bloque tout.

Pensez à repasser les logs en `info` une fois le problème réglé.

---

## Ce que Telegram ne permettra jamais

**Un bot ne reçoit pas les messages émis par un autre bot**, ni les siens. C'est
une règle de l'API, indépendante du mode privacy.

Conséquence pratique : si vous faites relayer vos codes de connexion dans le
groupe par une automatisation (Zapier, Make…), **votre bot OpenClaw ne les verra
pas**. La lecture du code doit passer par la boîte mail, ce que fait ce
programme. Les messages des humains, eux, passent sans problème.
