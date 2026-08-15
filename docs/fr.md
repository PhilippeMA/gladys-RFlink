# RFLink

Cette intégration relie Gladys à une passerelle [RFLink](https://www.rflink.nl/)
et transforme le trafic 433 MHz / 868 MHz qu'elle entend en appareils Gladys :
prises murales, variateurs, stations météo, détecteurs de mouvement et de
fumée, compteurs d'énergie, carillons.

## Avant de commencer : RFLink doit être joignable en TCP

Gladys exécute chaque intégration externe dans un conteneur isolé qui **n'a pas
accès aux ports série** — le seul matériel qu'un manifeste peut demander est un
accélérateur Coral, un GPU ou un périphérique vidéo. L'intégration joint donc
la passerelle par le réseau. Deux montages sont possibles.

### A. RFLink32 sur ESP8266 / ESP32 (rien d'autre à installer)

[RFLink32](https://github.com/cpainchaud/RFLink32) expose nativement un serveur
TCP. Flashez votre carte, connectez-la à votre Wi-Fi et notez l'adresse IP
qu'elle prend ; le port par défaut est **1234**.

### B. Un RFLink USB branché sur un ordinateur (Arduino Mega + émetteur)

Exposez le port série en TCP avec `ser2net`, sur la machine où le RFLink est
branché (ce peut être la machine Gladys) :

```bash
sudo apt install ser2net
```

Ajoutez ceci à `/etc/ser2net.yaml`, en adaptant le chemin du périphérique :

```yaml
connection: &rflink
  accepter: tcp,1234
  connector: serialdev,/dev/ttyUSB0,57600n81,local
  options:
    kickolduser: true
```

Puis `sudo systemctl restart ser2net`. **57600 bauds est la vitesse du
RFLink** — le symptôme classique d'une mauvaise vitesse est un journal rempli
de caractères illisibles.

`esp-link` et les modules série-vers-Ethernet type USR-TCP232 fonctionnent de
la même façon.

Vérifiez la passerelle depuis n'importe quelle machine du réseau avant de
configurer Gladys :

```bash
printf '10;PING;\r\n' | nc 192.168.1.42 1234
# -> 20;01;PONG;
```

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Renseignez l'**adresse de la passerelle** (IP ou nom d'hôte) et le **port
   TCP** (1234 sauf si vous l'avez changé).
3. Enregistrez, puis cliquez sur **Tester la passerelle** : elle envoie
   `10;PING;` et attend le `PONG`. Si ce bouton répond, tout le reste
   fonctionnera.
4. **Lire la version du firmware** affiche le firmware, la révision et le build
   de votre RFLink — la première chose à vérifier quand un appareil est mal
   décodé.

## Ajouter vos appareils

Un appareil 433 MHz est invisible tant qu'il n'émet pas : il n'y a aucune liste
à récupérer, l'intégration en construit une **en écoutant**.

- **Une télécommande, un interrupteur, un carillon** : appuyez sur un de ses
  boutons. Chaque bouton est un appareil distinct dans Gladys (RFLink le
  rapporte comme une unité `SWITCH=` différente).
- **Un capteur** (température, station météo…) : attendez sa prochaine
  émission — toutes les 30 à 60 secondes pour la plupart, quelques minutes au
  maximum.

L'appareil apparaît alors dans l'onglet **Découverte**, nommé d'après ce que la
passerelle a rapporté (par exemple `NewKaku 000005 (unit 2)`). Ajoutez-le,
renommez-le, et son historique commence. Vous pouvez le renommer librement :
Gladys le suit par son adresse radio, pas par son nom.

Votre récepteur entend aussi vos **voisins**. Deux réglages permettent de
maîtriser cela :

- **Découverte automatique** — désactivez-la une fois vos appareils ajoutés.
  Les appareils connus continuent de fonctionner ; seul l'apprentissage de
  nouveaux s'arrête.
- **Protocoles ignorés** — une liste de noms de protocoles RFLink séparés par
  des virgules, à ignorer complètement, pour ceux qui saturent votre récepteur
  (`Oregon TempHygro, Cresta`).

L'action **Oublier les appareils non ajoutés** vide l'onglet Découverte de tout
ce que vous n'avez pas créé, pour repartir sur une base propre. Les appareils
déjà ajoutés ne sont jamais touchés.

Un appareil que vous ajoutez affiche **immédiatement sa dernière mesure
connue** : l'intégration l'avait entendu avant que vous l'ajoutiez et vous la
transmet, horodatée au moment où elle a réellement été mesurée. Pas d'attente
de la prochaine émission.

## Quand RFLink ne peut pas savoir ce qu'est votre appareil

Les puces **EV1527**, **PT2262** ou **HS1527** sont de simples encodeurs radio :
elles émettent une adresse et quatre bits de données, rien de plus. La même
puce équipe des détecteurs de mouvement, des contacts de porte, des détecteurs
de fumée, des sondes de fuite, des boutons de sonnette et des prises — et tous
produisent exactement la même trame :

```
20;2D;EV1527;ID=07a410;SWITCH=01;CMD=ON;
```

Aucun logiciel ne peut les distinguer, car l'information n'est pas émise.
RFLink les rapporte donc tous comme des interrupteurs, et votre détecteur de
mouvement arrive en interrupteur. L'action **Définir le type d'un appareil**
sert à dire ce qu'il est vraiment :

1. Ajoutez l'appareil depuis l'onglet Découverte (il apparaît en interrupteur).
2. Lancez **Définir le type d'un appareil** : choisissez l'appareil, puis son
   type réel — détecteur de mouvement, contact de porte, détecteur de fumée,
   sonde de fuite, capteur de vibration, sonnette, bouton, sirène, lampe, ou
   capteur générique en lecture seule.
3. Retournez dans l'onglet **Découverte** et cliquez sur **Mettre à jour** sur
   cet appareil.

Cette dernière étape, c'est Gladys qui refuse de réécrire un de vos appareils
sans vous demander : changer un type change la structure de l'appareil. Votre
historique est conservé — la fonctionnalité garde son identité au passage.

### Détecteurs de mouvement : le délai de remise à zéro

Un PIR signale une détection mais, sur la plupart du matériel bon marché, **ne
signale jamais sa fin**. Sans rien faire, la fonctionnalité resterait « active »
pour toujours, plus aucun changement ne se produirait, et aucun scénario ne
pourrait se redéclencher. Une détection est donc automatiquement remise à zéro
après un délai, réglable par appareil dans la même action :

| Type                                     | Remise à zéro par défaut |
| ---------------------------------------- | ------------------------ |
| Mouvement, présence, fumée, fuite        | 60 s                     |
| Vibration                                | 30 s                     |
| Sonnette, bouton                         | 2 s                      |
| Contact de porte / fenêtre, interrupteur | jamais                   |

Un contact de porte n'est jamais remis à zéro : il émet à l'ouverture **et** à
la fermeture, donc le réinitialiser effacerait une porte réellement restée
ouverte. Saisissez `0` pour désactiver la remise à zéro et la piloter vous-même
depuis un scénario.

## Piloter un appareil

Tout appareil que RFLink rapporte avec une commande (`CMD=ON` / `CMD=OFF`)
reçoit un contrôle marche/arrêt dans Gladys, et celui qui rapporte un niveau de
variation reçoit en plus un curseur de luminosité.

Le 433 MHz est un média **unidirectionnel** : la passerelle émet et aucun
appareil ne répond. Gladys enregistre donc l'état que vous avez demandé, et
l'appareil physique peut être désynchronisé s'il était hors de portée ou si une
autre télécommande a agi sur lui. C'est une propriété du protocole radio, pas
une limite de l'intégration.

### Appairer un récepteur (NewKaku et similaires)

Un récepteur doit _apprendre_ l'adresse à laquelle il obéira, et cette adresse
n'a jamais été émise : aucun appareil découvert n'existe donc encore. Utilisez
l'action **Envoyer une commande brute** :

1. Mettez le récepteur en mode appairage (généralement en maintenant son bouton
   jusqu'à ce qu'il clignote).
2. Envoyez une commande sur une adresse libre, par exemple
   `10;NewKaku;00c142;1;ON;`.
3. Le récepteur la mémorise. Renvoyez la même commande et il apparaît dans
   l'onglet Découverte comme n'importe quel autre appareil.

L'action n'accepte qu'une seule ligne RFLink commençant par `10;`, et refuse
tout le reste.

## Actions

| Action                                | Effet                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------ |
| **Tester la passerelle**              | Envoie `10;PING;` et attend le `PONG`.                                   |
| **Lire la version du firmware**       | Envoie `10;VERSION;` et affiche firmware, révision et build.             |
| **Définir le type d'un appareil**     | Déclare ce qu'est vraiment un appareil type EV1527, et son délai de RAZ. |
| **Identifier un appareil**            | Allume l'appareil choisi, puis l'éteint deux secondes plus tard.         |
| **Envoyer une commande brute**        | Transmet une ligne RFLink `10;...;` (appairage, test d'une adresse).     |
| **Oublier les appareils non ajoutés** | Vide l'onglet Découverte en conservant tous vos appareils créés.         |

## Dépannage

**Le bouton « Tester la passerelle » expire.** La passerelle n'est pas
joignable. Vérifiez l'adresse et le port avec la commande `nc` ci-dessus, et
assurez-vous que la passerelle écoute sur l'interface réseau et pas seulement
sur `127.0.0.1`.

**La connexion se coupe et se rétablit en boucle.** Un autre programme est déjà
connecté à la passerelle — RFLink n'accepte qu'un seul client à la fois.
Arrêtez l'autre consommateur (Domoticz, une session `screen`, un second
Gladys), ou activez `kickolduser` dans `ser2net`.

**Rien n'apparaît dans l'onglet Découverte.** Activez **Journaliser les trames
brutes** dans la configuration et regardez les logs de l'intégration : vous
devriez voir une ligne `RFLink <-` par émission. Aucune ligne signifie que la
passerelle n'entend rien (antenne, distance, mauvaise bande). Des lignes
remplies de caractères incohérents signalent une mauvaise vitesse sur la
passerelle série.

**Un capteur a changé d'identité tout seul.** Beaucoup de capteurs 433 MHz
tirent un nouvel `ID` aléatoire au changement de piles. L'ancien appareil cesse
de se mettre à jour et un nouveau apparaît dans Découverte ; c'est le
comportement du capteur, et tous les contrôleurs 433 MHz le voient ainsi.

**Une température est aberrante.** Signalez-la avec la trame brute (extraite
des logs) dans une issue : le décodage se fait champ par champ, et un protocole
inhabituel peut nécessiter un traitement dédié.

**Deux mesures émises par mon capteur n'apparaissent pas.** `HSTATUS` (un
niveau de confort d'humidité) et `BFORECAST` (une tendance barométrique
sommaire) ne sont volontairement pas exposés : ce sont deux valeurs que le
capteur déduit d'une mesure qu'il envoie déjà, sur une échelle qu'aucune
catégorie Gladys ne porte. Elles apparaîtraient comme une ligne sans nom ni
icône, juste à côté de l'humidité dont elles sont calculées. Demandez-les dans
une issue si elles vous sont utiles.

Pour plus de détail, positionnez `LOG_LEVEL=debug` sur le conteneur de
l'intégration : chaque trame, chaque commande et chaque reconnexion est
journalisée.
