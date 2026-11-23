# MMauto

Parler à [Claude Code](https://github.com/anthropics/claude-code) depuis Android Auto, et
tenir un carnet de route qui se remplit seul.

En voiture, Claude est un contact de messagerie : Android Auto lit ses réponses à voix haute, et
on lui répond en dictant. Au départ de chaque trajet, MMauto demande où l'on va et pour quoi
faire ; la distance est relevée par le GPS du téléphone, et le carnet du mois s'exporte en CSV
(trajets professionnels et personnels, totaux).

```
téléphone (MMauto)  ──HTTPS──▶  mandataire inverse  ──▶  relais (Node 20)  ──▶  claude -p
  notification lue                                         carnet de route       lecture seule
  par Android Auto,
  réponse dictée
```

Deux pièces :

- **`relais/`** : un petit serveur Node 20, sans dépendance, sur une machine où Claude Code est
  installé et connecté. Chaque dictée y lance `claude -p` en lecture seule ; la réponse revient
  au téléphone.
- **`android/`** : l'application Android (Kotlin, Android 10 et plus), qui présente la
  conversation comme une messagerie par notifications, la forme qu'Android Auto lit et fait
  répondre par la voix.

Le relais utilise le compte Claude Code de la machine qui l'héberge (abonnement Claude ou clé
d'API Anthropic) : chaque dictée et chaque réponse au carnet est un appel à ce compte.

## Installer l'application

Chaque version est publiée sur la page
[Releases](https://github.com/mmedia-fr/mmauto/releases) : `MMauto-X.Y.Z-android.apk`, avec le
fichier des empreintes `SHA256SUMS-X.Y.Z.txt` et sa signature.

1. Télécharger l'APK depuis le téléphone et l'installer (autoriser l'installation depuis le
   navigateur si Android le demande).
2. Ouvrir MMauto : autoriser les notifications ; saisir l'adresse du relais et son jeton, puis
   « Enregistrer et tester ».
3. « Ne pas restreindre en arrière-plan » : sans cela, Android endort la veille.
4. Carnet de route : « Autoriser la localisation », puis « Toujours autoriser » dans l'écran
   d'Android qui s'ouvre. Sans cette autorisation, le carnet reste inactif et MMauto accueille
   seulement par « Je vous écoute ».
5. Android Auto n'affiche pas une application installée hors du Play Store sans réglage : dans
   les paramètres d'Android Auto, toucher dix fois la version pour activer le mode développeur,
   puis, dans le menu des paramètres pour les développeurs, cocher « Sources inconnues ».

**Mises à jour.** Comme MMail et MMdedit, MMauto demande une fois par jour à l'API de GitHub la
dernière version publiée de ce dépôt, jamais en voiture. Si elle est plus récente, une
notification l'annonce et un bouton apparaît à l'écran ; l'un et l'autre ouvrent la page de la
version, d'où l'APK s'installe par-dessus la précédente. Rien ne s'installe seul.

**Vérifier une version.** Le fichier des empreintes est signé (Ed25519) par la clé de MMEDIA
dont la partie publique est `cle-empreintes.pub.pem` :

```bash
openssl pkeyutl -verify -pubin -inkey cle-empreintes.pub.pem -rawin \
  -in SHA256SUMS-X.Y.Z.txt -sigfile SHA256SUMS-X.Y.Z.txt.sig
sha256sum -c SHA256SUMS-X.Y.Z.txt
```

Certificat de signature des APK, le même que celui de MMdedit
(`apksigner verify --print-certs MMauto-X.Y.Z-android.apk`, empreinte SHA-256) :
`4cf4d94cbbe336a11a81cde6bd7e18c3dbd5618ad7afda6c472bda7f41ceebf6`.

## Mettre en place le relais

Prérequis : Node 20, Claude Code installé et connecté pour l'utilisateur qui fera tourner le
relais, un mandataire inverse HTTPS (nginx, Caddy…) joignable depuis le téléphone.

```bash
git clone https://github.com/mmedia-fr/mmauto.git /opt/mmauto
cd /opt/mmauto/relais
cp profil.exemple.json profil.json        # puis l'adapter, voir plus bas

# Jeton du téléphone : le relais n'en garde que l'empreinte SHA-256.
mkdir -p ~/.config/claude-voiture
JETON=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')
echo "Jeton à saisir dans l'application : $JETON"
printf %s "$JETON" | sha256sum | cut -d' ' -f1 > ~/.config/claude-voiture/jeton.sha256

VOITURE_HOTE=127.0.0.1 node relais.mjs    # essai ; en service : mmauto-relais.service
```

Remplacer ou vider `jeton.sha256` révoque le jeton sur-le-champ.

Exemple de mandataire inverse (nginx), le relais écoutant sur `127.0.0.1:7120` :

```nginx
location ^~ /voiture/ {
    proxy_pass http://127.0.0.1:7120;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;         # interrogation longue
    proxy_read_timeout 70s;
    client_max_body_size 32k;
}
```

L'adresse à saisir dans l'application est alors `https://<votre domaine>/voiture/`.

**Variables d'environnement** (toutes facultatives) : `VOITURE_PORT` (7120), `VOITURE_HOTE`
(`0.0.0.0`), `VOITURE_PROFIL` (`profil.json` à côté du relais), `VOITURE_ETAT`
(`~/.local/state/claude-voiture`), `VOITURE_CARNET` (`carnet/` dans ce dossier),
`VOITURE_EMPREINTE` (`~/.config/claude-voiture/jeton.sha256`), `VOITURE_CLAUDE`
(`~/.local/bin/claude`).

### Le profil (`profil.json`)

- `repertoire` : répertoire de travail de Claude Code. La conversation y trouve ses
  instructions (`CLAUDE.md`) et sa mémoire, comme une session ordinaire.
- `modele`, `effort` : modèle et effort de la conversation ; `delaiMaxSecondes` : au-delà, le
  calcul est interrompu ; `premierAvisSecondes` : au-delà, « Je regarde, la réponse arrive. »
- `outilsIntegres` : outils de Claude Code permis (lecture seule dans l'exemple).
- `serveurMcp` : `null`, ou `{"source": "<nom dans ~/.claude.json>", "nom": "<nom donné à la
  conversation>"}` ; `outilsMcp` : les outils de ce serveur permis, sans préfixe. Le relais
  redéclare le serveur sous `nom` (Claude Code ignore les règles d'autorisation d'un serveur
  dont le nom commence par `claude_ai_`).
- `consigne` : ajoutée aux instructions de la conversation (réponse courte, faite pour l'oral).
- `carnet` : le carnet de route ; à retirer pour s'en passer. Questions posées, consigne et
  modèle de l'interprétation des réponses, fuseau horaire, adresse du géocodage inverse,
  distance minimale d'un trajet retenu, délai de reprise d'un trajet interrompu.

**Profil en lecture seule.** Claude Code est lancé avec `--permission-mode dontAsk` (tout ce qui
n'est pas permis est refusé sans question), la liste d'outils du profil, les réglages de
l'utilisateur seulement (`--setting-sources user`) et les seuls serveurs MCP du profil
(`--strict-mcp-config`). Une action demandée en voiture se prépare et attend la validation à
l'arrêt.

### API

En-tête `X-Voiture-Jeton` ; le préfixe `/voiture` est accepté devant chaque chemin.

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/v1/sante` | sans jeton : le relais répond |
| GET | `/v1/messages?apres=N&attente=S` | messages de numéro > N, interrogation longue (S ≤ 50 s) |
| POST | `/v1/messages` `{"texte": …}` | dépose une dictée |
| POST | `/v1/fil` | nouvelle conversation |
| GET | `/v1/etat` | calcul en cours, fil courant |
| POST | `/v1/trajets` `{"type": "depart"\|"arrivee"\|"reponse", "id", "heure", …}` | événement d'un trajet |
| GET | `/v1/carnet?mois=AAAA-MM` | carnet de route du mois, en CSV (`;`, UTF-8 avec BOM) |
| POST | `/v1/diag` `{"lignes": [{"n", "heure", "texte"}]}` | relevé de diagnostic du téléphone, écrit au journal |

Rôles des messages : `moi`, `claude`, `carnet`, `etat` (avis d'attente, effacé par la
réponse), `avis` (lu comme une réponse, sans clore l'attente), `erreur`.

## Fonctionnement

- **Conversation** : une conversation est une session Claude Code reprise d'une dictée à la
  suivante (`--resume`). « Nouvelle conversation » en tête de dictée, ou le bouton de
  l'application, en ouvre une autre. Une dictée coupée au milieu d'une phrase obtient « La
  suite ? ».
- **Veille** : un service de premier plan suit la connexion à la voiture (`CarConnection`) et
  interroge le relais tant que le téléphone est en voiture, ou qu'une réponse est attendue.
- **Carnet de route** : à la connexion à la voiture, un trajet s'ouvre et le relais pose la
  question du départ ; si un trajet du même véhicule s'est terminé moins de 20 minutes avant, il
  propose de le reprendre. La réponse dictée est interprétée par un appel Claude séparé, à
  sortie structurée (destination, motif, nature professionnelle ou personnelle, client, demande
  annexe), et la confirmation est lue au conducteur. GPS en haute précision toutes les 5 s
  pendant le trajet ; distance = somme des segments, points imprécis ou aberrants écartés ;
  véhicule = nom de l'appareil Bluetooth de la voiture ; arrivée retenue 3 minutes après la
  déconnexion. Sans réponse au départ, la question est posée à l'arrivée. Si l'interprétation
  échoue, la dictée est gardée telle quelle et l'interprétation reprise plus tard.
- **Hors réseau** : les événements du carnet attendent dans une file persistante et partent
  dans l'ordre ; si le relais est injoignable au départ, le téléphone pose lui-même la question.

**Ce qui sort du téléphone** : les dictées, les événements des trajets (heures, positions,
distance, véhicule) et un relevé de diagnostic sans contenu ni position, vers le relais que
vous hébergez ; une demande par jour à l'API de GitHub pour les nouvelles versions. Le relais
nomme les lieux par le géocodage inverse de la Géoplateforme de l'IGN (`data.geopf.fr`), qui
reçoit donc les coordonnées de départ et d'arrivée. Le journal du relais ne contient jamais le
contenu des messages.

## Construire

```bash
cd android
echo "sdk.dir=$HOME/android-sdk" > local.properties
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease     # APK non signé, à aligner (zipalign) puis signer (apksigner)
```

**Essai sans voiture** (émulateur, `adb root`) :

```bash
adb shell am start -n fr.mmedia.claudevoiture/.MainActivity --es url <adresse> --es jeton <jeton>
adb shell am start-foreground-service -n fr.mmedia.claudevoiture/.VeilleService \
  -a fr.mmedia.claudevoiture.SIMULER --ez voiture true    # false : déconnexion
adb emu geo fix <lon> <lat>                               # déplacer le GPS
```

`securite_reseau.xml` admet le HTTP vers `10.0.2.2` seul (l'hôte vu de l'émulateur), pour un
relais d'essai.

**Icône** (`android/icone/generer.py`) : fond et M de l'icône de
[MMdedit](https://github.com/mmedia-fr/mmdedit), voiture vue de face à la place de la page.

## Licence

MMauto est publié par MMEDIA (SAS M-Media) sous la
[licence publique de l'Union européenne (EUPL) 1.2](LICENSE).
