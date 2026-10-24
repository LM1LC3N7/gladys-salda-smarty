// -----------------------------------------------------------------------------
// The unit -> one Gladys device and its states (pure).
//
// `ext:<selector>:salda-smarty:unit`: one device per integration. FROZEN
// RULE: the Modbus map of the Smarty (as pysmarty2 reads it) gives no serial
// number, so the device is keyed by the unit of the configuration, never by
// its IP address (a new address keeps the device and its history). The
// feature roles (the last part of their external ids) are published forever:
// never rename them. Every role is always built, so a republished device
// never loses a feature.
//
// No switch, no writable binary, no writable fan: a "turn everything off"
// (Google Home, Alexa, HomeKit, MCP, `switch.*` scenes) never reaches the
// ventilation. The commands are one `text/select` (the mode, which is the fan
// speed of the Smarty) and `button/push` features (boost start and stop); all
// are refused unless the configuration allows the commands, except "Stop the
// boost", which is never held back by the option (src/app.js). Stand-by (the
// unit stopped) is never offered.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on temperature-sensor, days on
// duration. The fan speeds in rpm have no unit in the core: `unknown`
// sensors whose name says "rpm".
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COMMANDS, FEATURES, MODES, SYSTEM_MODES, SYSTEM_STATES } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';

export const SERVICE = 'salda-smarty';
export const PLATFORM_ID = 'unit';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -60,
  max: 90,
});
const rpm = sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 10_000 });
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.MODE]: select,
  [FEATURES.SYSTEM_MODE]: text,
  [FEATURES.SYSTEM_STATE]: text,
  [FEATURES.BOOST]: binary,
  [FEATURES.ALARM]: binary,
  [FEATURES.WARNING]: binary,
  [FEATURES.TEMP_SUPPLY]: temperature,
  [FEATURES.TEMP_EXTRACT]: temperature,
  [FEATURES.TEMP_OUTDOOR]: temperature,
  [FEATURES.FILTER_DAYS]: sensor({
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.DAYS,
    min: 0,
    max: 3650,
  }),
  [FEATURES.SUPPLY_RPM]: rpm,
  [FEATURES.EXTRACT_RPM]: rpm,
  [FEATURES.BOOST_START]: button,
  [FEATURES.BOOST_STOP]: button,
};

export const ROLES = Object.keys(DEFINITIONS);

/** The value read for each numeric or binary sensor role. */
const VALUE_OF = {
  [FEATURES.BOOST]: 'boost',
  [FEATURES.ALARM]: 'alarm',
  [FEATURES.WARNING]: 'warning',
  [FEATURES.TEMP_SUPPLY]: 'supply',
  [FEATURES.TEMP_EXTRACT]: 'extract',
  [FEATURES.TEMP_OUTDOOR]: 'outdoor',
  [FEATURES.FILTER_DAYS]: 'filterDays',
  [FEATURES.SUPPLY_RPM]: 'supplyRpm',
  [FEATURES.EXTRACT_RPM]: 'extractRpm',
};

export const unitIds = (gladys) => gladys.externalIds(SERVICE, PLATFORM_ID);

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:${SERVICE}:${PLATFORM_ID}:([a-z-]+)$`).exec(externalId);
  return match && ROLES.includes(match[1]) ? match[1] : undefined;
}

/** The Gladys device of the unit. */
export function buildDevice(gladys, { language }) {
  const ids = unitIds(gladys);
  return {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: 'Salda Smarty',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.MODE
        ? {
            supported_options: MODES.map((value, index) => ({
              value,
              label: word(MODE_NAMES[value], language),
              sort_order: index,
            })),
          }
        : {}),
    })),
    params: [{ name: 'protocol', value: 'Modbus TCP' }],
  };
}

/** Whether a role is a command, and which. */
export const commandOf = (role) => (Object.hasOwn(COMMANDS, role) ? COMMANDS[role] : undefined);

/**
 * The states of the values read this time (a value not read is left out:
 * Gladys keeps its last one, never republished as new). A value outside the
 * bounds of its feature is dropped. Texts are stable English keys, whatever
 * the language (scenes keep working).
 */
export function deviceStates(ids, values) {
  const states = [];
  // The list only shows its options: a unit in Stand-by does not change it.
  if (MODES.includes(values.mode)) {
    states.push({ device_feature_external_id: ids.feature(FEATURES.MODE), text: values.mode });
  }
  if (SYSTEM_MODES.includes(values.systemMode)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.SYSTEM_MODE),
      text: values.systemMode,
    });
  }
  if (SYSTEM_STATES.includes(values.state)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.SYSTEM_STATE),
      text: values.state,
    });
  }
  for (const [role, key] of Object.entries(VALUE_OF)) {
    let value = values[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    const { min, max } = DEFINITIONS[role];
    if (Number.isFinite(value) && value >= min && value <= max) {
      states.push({ device_feature_external_id: ids.feature(role), state: value });
    }
  }
  return states;
}
