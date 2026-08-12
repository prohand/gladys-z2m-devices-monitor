# Z2M Devices Monitor — documentation

Cette intégration surveille vos appareils Zigbee2MQTT et vous alerte quand l'un
d'eux **ne donne plus signe de vie**.

## Pourquoi ne pas se fier à la batterie

Le pourcentage de batterie remonté par un appareil Zigbee est une estimation
grossière, rarement rafraîchie et souvent fausse : une pile CR2032 affiche
couramment 100 % jusqu'au jour où le capteur cesse de répondre. Et surtout, la
batterie ne dit rien des autres façons de mourir : un appareil débranché, sorti
du réseau, qui a perdu sa route ou dont le routeur parent est tombé.

Un appareil Zigbee vivant **parle**. Les capteurs envoient leurs mesures, les
routeurs répondent, tout se manifeste au moins périodiquement. Le seul fait
vraiment fiable est donc : _quand ai-je entendu cet appareil pour la dernière
fois ?_ — et la seule question utile : _se tait-il depuis plus longtemps qu'il ne
le devrait ?_

C'est exactement ce que fait cette intégration.

## Ce qu'elle fait

Elle s'abonne à tout ce que publie Zigbee2MQTT sur votre broker MQTT
(`zigbee2mqtt/#`), mémorise la date du dernier message de chaque appareil, et
réévalue en continu leur silence.

Elle ne publie **jamais** rien sur votre réseau Zigbee : elle se contente
d'écouter. Elle sait aussi faire la différence entre :

- un message publié **par** l'appareil → preuve qu'il est vivant ;
- un message rejoué par le broker (drapeau _retained_, à chaque reconnexion) →
  il peut dater de plusieurs jours, il ne prouve rien ;
- une commande `set`/`get` envoyée **vers** l'appareil par Gladys, Home Assistant
  ou une scène → ce n'est pas l'appareil qui parle. Sans cette distinction, un
  capteur mort paraîtrait vivant tant que quelque chose continue de lui parler.

Si vous avez activé l'option `advanced.last_seen` dans Zigbee2MQTT, l'intégration
utilise l'horodatage que l'appareil joint à ses rapports : c'est la source la
plus fiable, et elle rend même les messages _retained_ exploitables. Ce n'est pas
obligatoire.

## Installation

### 1. Pré-requis

- Zigbee2MQTT en fonctionnement, publiant sur un broker MQTT ;
- ce broker doit être joignable depuis Gladys (même réseau local).

### 2. Configuration

| Champ                                | À renseigner                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **URL du broker**                    | L'adresse de votre broker MQTT, par exemple `mqtt://192.168.1.10:1883`. Les schémas `mqtts://`, `ws://` et `wss://` sont acceptés. |
| **Nom d'utilisateur / Mot de passe** | À laisser vides si votre broker accepte les connexions anonymes.                                                                   |
| **Topic de base**                    | Le `mqtt.base_topic` configuré dans Zigbee2MQTT. `zigbee2mqtt` dans la quasi-totalité des cas.                                     |

Cliquez ensuite sur **Tester la connexion MQTT** : le bouton indique s'il est
connecté, combien d'appareils il voit et combien de messages il a reçus. C'est le
moyen le plus rapide de repérer l'erreur classique — bon broker, mauvais topic de
base, et rien ne se passe.

### 3. Ajouter les appareils

Allez dans **Appareils → Découvrir**, puis créez les appareils que vous voulez
surveiller. Vous en trouverez :

- un appareil **par appareil Zigbee** connu de Zigbee2MQTT ;
- un appareil **Zigbee2MQTT monitor**, qui résume tout le réseau.

Les appareils surveillés portent le nom Zigbee2MQTT **suivi d'un suffixe**,
`(monitor)` par défaut : `prise bureau (monitor)`. Sans lui, ils seraient
impossibles à distinguer des appareils que l'intégration Zigbee2MQTT de Gladys
remonte déjà sous le même nom — un sélecteur de scène afficherait deux fois
« prise bureau ». Le suffixe se change (ou se vide) dans **Nommage des
appareils**. Il ne s'applique qu'aux appareils créés ensuite : Gladys ne renomme
jamais un appareil déjà ajouté, à vous de le renommer sur sa fiche.

### Et quand le réseau Zigbee change ?

L'intégration relit l'inventaire de Zigbee2MQTT en continu, donc la liste de
l'écran **Découvrir** se met à jour toute seule :

- **un appareil que vous venez d'appairer** apparaît dans la liste en quelques
  secondes, sans redémarrage ni action de votre part. En revanche, sa **création
  dans Gladys reste manuelle** : c'est vous qui décidez ce qui entre dans votre
  installation. C'est aussi pourquoi la scène à bâtir est celle de l'appareil
  **Zigbee2MQTT monitor** — ses compteurs comptent tous les appareils vus par
  Zigbee2MQTT, y compris ceux que vous n'avez pas créés dans Gladys, donc un
  nouvel appareil est couvert par l'alerte dès son appairage ;
- **un appareil retiré de Zigbee2MQTT** disparaît de l'écran **Découvrir** et
  cesse d'être compté et d'émettre des valeurs. S'il avait déjà été créé dans
  Gladys, sa fiche **n'est pas supprimée automatiquement** : elle reste, figée
  sur sa dernière valeur. Une intégration n'a pas le droit de supprimer vos
  appareils — supprimez-la depuis **Appareils** quand vous le souhaitez.

## Les seuils de silence

Un appareil est déclaré mort dès qu'il se tait depuis plus longtemps que son
seuil. Deux valeurs par défaut :

- **appareils sur secteur** (prises, ampoules, routeurs) : 120 minutes, ils
  parlent souvent ;
- **appareils sur pile** (capteurs) : 1440 minutes, soit 24 heures — ils dorment
  la plupart du temps.

Vous pouvez affiner appareil par appareil dans le champ **Seuils par appareil**,
une paire `appareil=minutes` par ligne ou séparées par des virgules :

```
capteur boite aux lettres=4320
mouvement garage=180
0x00158d0001abcdef=60
```

L'appareil se désigne par son nom convivial Zigbee2MQTT ou par son adresse IEEE.

**Commencez large.** Un seuil trop serré produit des fausses alertes, et une
alerte à laquelle on cesse de croire ne sert plus à rien. Laissez tourner
quelques jours, regardez la valeur « Silence » de chaque appareil sur sa fiche,
puis resserrez.

## Ce que chaque appareil expose

| Fonctionnalité   | Description                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Alive**        | 1 = l'appareil donne signe de vie, 0 = il se tait depuis plus que son seuil. C'est la fonctionnalité sur laquelle bâtir une alerte. Son historique est conservé. |
| **Silence**      | Depuis combien de minutes l'appareil n'a rien dit. Utile pour calibrer les seuils.                                                                               |
| **Link quality** | Le LQI de son dernier message. Un LQI qui s'effondre depuis des semaines annonce souvent le prochain appareil à mourir.                                          |

L'appareil **Zigbee2MQTT monitor** expose de son côté :

| Fonctionnalité                            | Description                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Silent devices**                        | Le nombre d'appareils actuellement silencieux.                                                |
| **Silent device names**                   | Leurs noms, pour les citer dans une notification. Affiche `-` tant que tout le réseau répond. |
| **Devices alive** / **Devices monitored** | Les compteurs du réseau.                                                                      |
| **Zigbee2MQTT bridge online**             | L'état du bridge Zigbee2MQTT lui-même.                                                        |

## Être alerté : créer la scène

L'intégration lève le drapeau, Gladys envoie l'alerte. La scène la plus utile est
celle bâtie sur l'appareil **Zigbee2MQTT monitor** : elle couvre tout le réseau,
y compris les appareils que vous appairerez dans six mois.

1. **Scènes → Nouvelle scène** ;
2. déclencheur : **La valeur d'un appareil change** → appareil
   _Zigbee2MQTT monitor_, fonctionnalité **Silent devices**, condition
   _supérieur à_ `0` ;
3. action : **Envoyer un message** (notification mobile, Telegram…) avec un texte
   du type :

   > Appareil(s) Zigbee sans signe de vie : {{device.z2m-monitor-silent-names}}

   Utilisez le sélecteur proposé par l'éditeur de scène pour insérer la
   fonctionnalité **Silent device names** : le message nommera les capteurs
   concernés au lieu de dire simplement que quelque chose ne va pas.

Pour un capteur critique en particulier (détecteur de fumée, alarme, congélateur),
créez en plus une scène dédiée sur sa fonctionnalité **Alive** passant à 0.

Astuce : ajoutez une condition d'horaire à la scène si vous ne voulez pas être
réveillé la nuit — un capteur muet peut presque toujours attendre le matin.

## Les boutons de l'écran de configuration

- **Tester la connexion MQTT** — état réel de la connexion, nombre d'appareils
  surveillés, nombre de messages reçus, et la raison précise en cas d'échec.
- **Lister les appareils silencieux** — qui se tait, et depuis combien de temps.
- **Rafraîchir la liste des appareils** — republie la liste vers Gladys, après un
  appairage ou un renommage dans Zigbee2MQTT.

## Bon à savoir

- **Les appareils sont identifiés par leur adresse IEEE**, pas par leur nom.
  Renommer un appareil dans Zigbee2MQTT met à jour son nom dans Gladys sans
  perdre son historique.
- **Les appareils désactivés dans Zigbee2MQTT ne sont pas surveillés** par
  défaut : ils sont censés se taire. Une option permet de les inclure.
- **Le coordinateur (la clé USB) n'est pas surveillé** : ce n'est pas un appareil
  qui peut tomber de son côté. Utilisez la fonctionnalité _Zigbee2MQTT bridge
  online_ pour cela.
- **L'historique du dernier signe de vie est persisté** dans le volume `/data` de
  l'intégration. Un redémarrage du conteneur ne remet donc pas tous vos appareils
  à zéro — sans quoi un capteur mort depuis un mois repartirait pour un seuil
  complet sans jamais déclencher l'alerte.
- **Un appareil jamais entendu** dispose d'un seuil complet à partir du démarrage
  du moniteur avant d'être signalé. Une intégration fraîchement installée ne
  déclare donc pas tout le réseau mort à la première minute.

## En cas de problème

**Le bouton de test dit qu'il n'est pas connecté.** Vérifiez l'URL (avec le port,
`1883` par défaut), les identifiants, et que le broker autorise les connexions
depuis l'adresse de Gladys.

**Il est connecté, mais ne voit aucun appareil.** Le topic de base ne correspond
probablement pas à celui de Zigbee2MQTT. Comparez-le avec `mqtt.base_topic` dans
votre `configuration.yaml`.

**Un appareil est signalé silencieux alors qu'il fonctionne.** Son seuil est trop
serré : regardez sa fonctionnalité _Silence_ pour connaître son rythme réel, et
donnez-lui un seuil sur mesure. Les capteurs de porte, de fuite ou les boutons
sont typiquement muets pendant des jours s'il ne se passe rien.

**Tous les appareils passent silencieux en même temps.** Regardez d'abord
_Zigbee2MQTT bridge online_ : c'est probablement Zigbee2MQTT lui-même, le broker
ou le coordinateur qui est tombé, pas vos capteurs.

**Un appareil que je viens d'ajouter affiche « Pas de valeur récente ».** Une
fonctionnalité ne reçoit de valeur qu'une fois l'appareil créé dans Gladys : tout
ce qui a été publié avant que vous cliquiez sur _Ajouter_ n'est allé nulle part.
L'intégration republie donc les états d'un appareil dès que Gladys lui signale sa
création, et la valeur arrive en quelques secondes. Si le bandeau est toujours là,
**rechargez la page** : le tableau de bord calcule ce bandeau au chargement de ses
données et ne l'efface pas sur les mises à jour temps réel qui suivent.
