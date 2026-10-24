# Salda Smarty pour Gladys

Affiche une ventilation double flux **Salda Smarty** (Smarty 2X, 3X, 4X P/V,
contrôleur MCB) dans Gladys, par son interface **Modbus TCP** sur votre réseau
local, sans cloud ni compte. Intégration non officielle, **sans lien avec
Salda**. **Jamais testé avec un vrai appareil** : elle lit et écrit les
registres publiés par Salda tels que les utilise la bibliothèque libre
pysmarty2 (utilisée par Home Assistant) ; merci de signaler ce que vous
constatez.

## Avant de commencer

- La centrale doit être sur votre réseau (Ethernet) avec le **Modbus TCP
  activé**, joignable depuis Gladys sur le **port 502**. Donnez-lui une
  adresse IP fixe dans votre routeur.
- Le Modbus TCP n’a **pas de mot de passe** : gardez la centrale sur un
  réseau de confiance.
- L’identifiant d’unité Modbus (adresse esclave) vaut 1 sauf si vous l’avez
  changé sur la centrale.

## Installation

1. Installez l’intégration depuis le store de Gladys.
2. Saisissez l’**adresse IP de la centrale** (port 502 sauf si vous en
   ajoutez un) et, si besoin, l’identifiant d’unité Modbus ; enregistrez.
3. Ouvrez l’onglet **Découverte** et ajoutez la centrale.

## Ce que vous obtenez

Un appareil, **Ventilation Salda Smarty**, avec :

| Fonctionnalité                                         | Remarques                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Températures de l’air soufflé, extrait et extérieur    | °C                                                                                            |
| Vitesses des ventilateurs de soufflage et d’extraction | tr/min                                                                                        |
| Filtres : jours restants                               | jours                                                                                         |
| Mode de ventilation (vitesse)                          | liste : protection du bâtiment (vitesse 1), économie (vitesse 2), confort (vitesse 3)         |
| Mode en cours                                          | texte : `standby`, `building-protection`, `economy`, `comfort`, `boost`                       |
| État de la centrale                                    | texte (clé stable en anglais, par exemple `economy`, `boost`, `change-filters`, `fire-alarm`) |
| Boost actif, alarme, avertissement                     | lecture seule, 1 = actif                                                                      |
| Démarrer / arrêter le boost                            | boutons                                                                                       |

Sur la Smarty, le **mode est la vitesse** : protection du bâtiment, économie
et confort correspondent aux vitesses 1, 2 et 3. La veille (centrale arrêtée)
est affichée dans « Mode en cours » et dans le statut, jamais proposée dans
la liste.

La centrale est lue toutes les 60 s (réglable de 30 s à 1 h), en quatre
requêtes sur une seule connexion, fermée ensuite. Le bouton de test, une
recherche dans Découverte, une reconnexion de Gladys ou un redémarrage de
l’intégration ne la relisent jamais avant l’intervalle. Lectures hors
intervalle :

- chaque commande relit la centrale juste avant d’écrire, puis relit la
  valeur écrite ;
- « Arrêter le boost » et ses renvois ;
- 5 s puis 20 s après une commande non confirmée, ou après un arrêt du boost
  qui suit un démarrage non confirmé ;
- une nouvelle adresse ou un nouvel identifiant d’unité enregistré est lu
  aussitôt.

## Commandes

Le changement de mode et « Démarrer le boost » sont refusés tant que
**Autoriser les commandes** n’est pas activé (désactivé par défaut). Aucun
interrupteur : un « éteins tout » d’un assistant vocal n’atteint jamais la
ventilation.

- Chaque commande relit la centrale juste avant d’écrire (le mode, l’état de
  la centrale, ses versions et la valeur à changer), n’écrit rien quand la
  valeur est déjà la bonne, et n’est confirmée que si la centrale renvoie
  l’écho de l’écriture puis relit la valeur demandée. Une commande qui a pu
  atteindre la centrale sans être confirmée répond « envoyée, sans
  confirmation » : vérifiez la centrale quelques secondes plus tard. Une
  commande que la centrale refuse avec une exception Modbus 1, 2 ou 3
  (fonction, adresse ou valeur illégale) répond « refusée » et n’est pas
  appliquée ; les autres exceptions (centrale en défaut, occupée…) répondent
  « envoyée, sans confirmation ». Une commande qui ne peut pas être écrite
  dans les 3,5 s est refusée et rien n’est envoyé.
- **Centrale en veille** (arrêtée) : le changement de mode et « Démarrer le
  boost » la relanceraient, ils sont donc refusés dès que le mode réglé, le
  mode en cours ou l’état relu vaut « veille ». Gladys n’arrête ni ne relance
  la centrale dans cette version (couper une double flux arrête le
  renouvellement d’air).
- **Centrale en train de s’arrêter** (état « refroidissement des batteries »
  ou « fermeture des volets », la séquence d’arrêt de Salda) : mêmes refus.
- **Alarme critique ou incendie** (état de la centrale) : le changement de
  mode et « Démarrer le boost » sont refusés. La fonction « Alarme »
  (alarme A) seule ne les bloque pas.
- **Versions changées** : l’intégration retient la version logicielle et la
  version de configuration de la centrale. Si elles changent (mise à jour,
  ou autre appareil à la même adresse), le statut l’indique et le changement
  de mode et « Démarrer le boost » sont refusés jusqu’à un appui sur
  **Tester la connexion**, qui accepte les versions affichées. Des versions
  illisibles ne bloquent rien.
- **Arrêter le boost** n’est pas soumis à l’option, ni à une autre commande,
  ni à une lecture en cours, ni à la veille, à une alarme ou aux versions ;
  il annule une commande pas encore envoyée. Une connexion refusée ou
  fermée, une réponse absente ou fausse sont réessayées toutes les 250 ms
  jusqu’à 3,5 s après l’appui. Il peut toutefois répondre sans avoir arrêté
  le boost dans ces cas :
  - aucune adresse ou identifiant d’unité valide dans la configuration ;
  - valeur reçue autre que 1 ;
  - centrale injoignable jusqu’à 3,5 s après l’appui (« non envoyée », ou
    « pas encore envoyé » s’il essaie encore) ;
  - centrale qui refuse l’écriture (exception Modbus 1 à 3 : « refusée ») ;
  - écho ou relecture absents ou différents, autre exception Modbus, ou
    boost relu encore actif (« envoyée, sans confirmation ») ;
  - une autre adresse ou un autre identifiant d’unité enregistré pendant
    l’arrêt : il est interrompu (« envoyée, sans confirmation » s’il était
    parti) et ses renvois sont abandonnés.

  Un deuxième appui pendant le premier le rejoint. S’il n’est pas confirmé,
  les lectures des deux minutes suivantes le renvoient (trois fois au plus)
  tant que le boost reste actif ; un « Démarrer le boost » parti ensuite
  l’emporte et n’est jamais défait. Après un « Démarrer le boost » parti
  mais pas confirmé, ce démarrage peut encore s’appliquer après l’arrêt :
  l’arrêt reste alors surveillé deux minutes même s’il est confirmé
  (relectures à 5 s et 20 s, renvoi si le boost est relu actif, trois fois
  au plus), et cette surveillance survit à un redémarrage de l’intégration.

- Le boost de la Smarty est limité dans le temps par la centrale elle-même.

## Limites

- Seuls les registres publiés par Salda et utilisés par pysmarty2 sont lus
  et écrits (aucune réinitialisation de filtre ni d’alarme dans cette
  version).
- Le Modbus de la Smarty ne donne pas de numéro de série : l’intégration
  affiche une centrale, celle de l’adresse saisie, et ne vérifie que ses
  versions (voir plus haut), qui peuvent être identiques sur deux centrales.
  Changer l’adresse garde l’appareil et son historique ; une autre centrale
  de mêmes versions mise à la même adresse apparaîtrait sur le même appareil
  et recevrait aussi ses commandes. Réservez l’adresse dans votre routeur
  (bail DHCP fixe).
- Les températures sont lues comme des valeurs signées (en dixièmes de
  degré) ; une valeur hors de -60 à 90 °C est ignorée.
- Gladys n’ouvre qu’une connexion Modbus à la fois vers la centrale ; une
  autre domotique qui l’interroge en même temps peut ralentir les réponses.
- Une adresse invalide n’est jamais réaffichée dans le statut : seul son
  nombre de caractères l’est.

## Confidentialité

Rien ne sort de votre réseau. L’intégration ne garde dans son volume `/data`
que l’heure de sa dernière lecture, les versions de la centrale et, pendant
deux minutes au plus, la surveillance d’un arrêt du boost.
