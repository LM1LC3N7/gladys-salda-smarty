// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and mode names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Salda Smarty ventilation', 'Ventilation Salda Smarty');

export const FEATURE_NAMES = {
  [FEATURES.MODE]: both('Ventilation mode (speed)', 'Mode de ventilation (vitesse)'),
  [FEATURES.SYSTEM_MODE]: both('Current mode', 'Mode en cours'),
  [FEATURES.SYSTEM_STATE]: both('Unit state', 'État de la centrale'),
  [FEATURES.BOOST]: both('Boost active', 'Boost actif'),
  [FEATURES.ALARM]: both('Alarm', 'Alarme'),
  [FEATURES.WARNING]: both('Warning', 'Avertissement'),
  [FEATURES.TEMP_SUPPLY]: both('Supply air temperature', 'Température de l’air soufflé'),
  [FEATURES.TEMP_EXTRACT]: both('Extract air temperature', 'Température de l’air extrait'),
  [FEATURES.TEMP_OUTDOOR]: both('Outdoor air temperature', 'Température de l’air extérieur'),
  [FEATURES.FILTER_DAYS]: both('Filter: days left', 'Filtres : jours restants'),
  [FEATURES.SUPPLY_RPM]: both(
    'Supply fan speed (rpm)',
    'Vitesse du ventilateur de soufflage (tr/min)',
  ),
  [FEATURES.EXTRACT_RPM]: both(
    'Extract fan speed (rpm)',
    'Vitesse du ventilateur d’extraction (tr/min)',
  ),
  [FEATURES.BOOST_START]: both('Start the boost', 'Démarrer le boost'),
  [FEATURES.BOOST_STOP]: both('Stop the boost', 'Arrêter le boost'),
};

/** The modes of the select (holding register 1): on the Smarty, the mode is the fan speed. */
export const MODE_NAMES = {
  standby: both('Stand-by (stopped)', 'Veille (arrêtée)'),
  'building-protection': both(
    'Building protection (speed 1)',
    'Protection du bâtiment (vitesse 1)',
  ),
  economy: both('Economy (speed 2)', 'Économie (vitesse 2)'),
  comfort: both('Comfort (speed 3)', 'Confort (vitesse 3)'),
  boost: both('Boost', 'Boost'),
};

/** The integration status and the answers of the button. */
export const T = {
  noHost: both(
    'Enter the IP address of your Salda Smarty unit (Modbus TCP), then save.',
    'Saisissez l’adresse IP de votre centrale Salda Smarty (Modbus TCP), puis enregistrez.',
  ),
  invalid: (typed) =>
    both(
      `Invalid address: ${typed} (an IPv4 address or a host name, optionally with a port).`,
      `Adresse invalide : ${typed} (une adresse IPv4 ou un nom d’hôte, avec un port si besoin).`,
    ),
  badUnitId: both(
    'Invalid Modbus unit id: a whole number from 1 to 247 (1 on a Smarty unless changed). Nothing is read.',
    'Identifiant d’unité Modbus invalide : un nombre entier de 1 à 247 (1 sur une Smarty sauf changement). Rien n’est lu.',
  ),
  connecting: both('Reading the unit…', 'Lecture de la centrale…'),
  waiting: (wait) =>
    both(
      `Next read of the unit in ${wait.en} (never sooner than the refresh interval).`,
      `Prochaine lecture de la centrale dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement).`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (address, wait) =>
    both(
      `No answer from ${address} (next try in ${wait.en}). Check the address, that Modbus TCP is enabled on the unit, and the Modbus unit id.`,
      `Pas de réponse de ${address} (nouvel essai dans ${wait.fr}). Vérifiez l’adresse, que le Modbus TCP est activé sur la centrale, et l’identifiant d’unité Modbus.`,
    ),
  failing: (reason, wait) =>
    both(
      `The unit answered badly (${reason}); next try in ${wait.en}.`,
      `La centrale a mal répondu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  summary: (values) => {
    if (values.mode === 'standby') {
      return both(
        'Salda Smarty: unit in stand-by (stopped); Gladys does not restart it.',
        'Salda Smarty : centrale en veille (arrêtée) ; Gladys ne la relance pas.',
      );
    }
    const mode = values.mode ? MODE_NAMES[values.mode] : both('unknown mode', 'mode inconnu');
    const boost = values.boost ? both(', boost', ', boost') : both('', '');
    const alarm = values.alarm ? both(', ALARM', ', ALARME') : both('', '');
    return both(
      `Salda Smarty: ${mode.en.toLowerCase()}${boost.en}${alarm.en}.`,
      `Salda Smarty : ${mode.fr.toLowerCase()}${boost.fr}${alarm.fr}.`,
    );
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  badButton: both('A button only takes 1: not sent.', 'Un bouton ne prend que 1 : non envoyé.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l’intégration.',
  ),
  noHost: both(
    'No valid address or Modbus unit id in the configuration: not sent.',
    'Aucune adresse ou identifiant d’unité Modbus valide dans la configuration : non envoyée.',
  ),
  unitStandby: both(
    'The unit is in stand-by (stopped): this command would start it, and Gladys neither stops nor restarts it. Not sent.',
    'La centrale est en veille (arrêtée) : cette commande la relancerait, et Gladys ne l’arrête ni ne la relance. Non envoyée.',
  ),
  unitAlarm: both(
    'The unit is in critical or fire alarm: no command that moves air is sent. Not sent.',
    'La centrale est en alarme critique ou incendie : aucune commande qui fait circuler l’air n’est envoyée. Non envoyée.',
  ),
  unknownMode: both(
    'The mode of the unit could not be read just before: command not sent.',
    'Le mode de la centrale n’a pas pu être relu juste avant : commande non envoyée.',
  ),
  unreadable: both('unreadable', 'illisible'),
  stopPending: both(
    'Boost stop not sent yet, still trying to reach the unit: check the boost in a few seconds.',
    'Arrêt du boost pas encore envoyé, la centrale est encore en cours de connexion : vérifiez le boost dans quelques secondes.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  busy: both(
    'Another command to the unit is still running: not sent.',
    'Une autre commande vers la centrale est encore en cours : non envoyée.',
  ),
  protectMeanwhile: both(
    'The boost was stopped meanwhile: not sent.',
    'Le boost a été arrêté entre-temps : non envoyée.',
  ),
  tooSlow: both(
    'The unit answered too slowly to send the command in time: not sent.',
    'La centrale a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the unit could not be read just before (${reason}): command not sent.`,
      `L’état de la centrale n’a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The unit refused the command (${reason}): not applied.`,
      `La centrale a refusé la commande (${reason}) : non appliquée.`,
    ),
  notSent: (reason) =>
    both(
      `The unit could not be reached (${reason}): command not sent.`,
      `La centrale n’a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the unit in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’état de la centrale dans quelques secondes.`,
    ),
};
