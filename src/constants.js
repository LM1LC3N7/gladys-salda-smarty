// -----------------------------------------------------------------------------
// Salda Smarty constants: the Modbus TCP map of the unit, manifest keys,
// feature roles, limits and timings.
//
// The Salda Smarty (MCB controller) answers Modbus TCP on port 502, without
// authentication. The registers are the ones Salda publishes ("MCB 1.21
// Modbus table") as pysmarty2 (MIT, 0.10.3, the library of Home Assistant's
// Smarty integration) reads and writes them, with the same protocol addresses
// (pymodbus' address, the one in the request). Only these requests are ever
// sent:
//   - read holding registers 1..37 (register 1: the system mode set by the
//     user, 0 Stand-by, 1 Building protection, 2 Economy, 3 Comfort);
//   - read holding registers 200..202 (alarm A, alarm B / warning);
//   - read coils 1..9 (coil 5: intensive air flow, the boost);
//   - read input registers 1..66 (system state, current mode, temperatures in
//     tenths of a degree, filter days left, fan speeds in rpm);
//   - write single register 1 (the mode, 1-3 only: Stand-by is never written);
//   - write single coil 5 (boost on, boost off).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;

/** Modbus function codes used (nothing else is ever sent). */
export const FC = {
  READ_COILS: 0x01,
  READ_HOLDING: 0x03,
  READ_INPUT: 0x04,
  WRITE_COIL: 0x05,
  WRITE_REGISTER: 0x06,
};

/** The MBAP header (7 bytes) and the largest frame Modbus TCP allows (260 bytes). */
export const MBAP_SIZE = 7;
export const MAX_FRAME = 260;

/**
 * The blocks read at each poll, in this order (the unit's state first): the
 * exact requests of pysmarty2 (`registers.py`), so a real unit answers them as
 * it answers Home Assistant.
 */
export const BLOCKS = [
  { key: 'holding', fc: FC.READ_HOLDING, address: 1, count: 37 },
  { key: 'coils', fc: FC.READ_COILS, address: 1, count: 9 },
  { key: 'inputs', fc: FC.READ_INPUT, address: 1, count: 66 },
  { key: 'alarms', fc: FC.READ_HOLDING, address: 200, count: 3 },
];

export const BLOCK_OF = Object.fromEntries(BLOCKS.map((b) => [b.key, b]));

/** The blocks of the unit's state (mode, boost): never skipped, a timeout only ends the read. */
export const STATE_BLOCKS = new Set(['holding', 'coils']);

/** The block that holds each value a command reads. */
export const VALUE_BLOCK = {
  mode: 'holding',
  boost: 'coils',
  state: 'inputs',
  systemMode: 'inputs',
};

/** Holding register 1, as read: index = value. Stand-by (0) is read only, never written. */
export const READ_MODES = ['standby', 'building-protection', 'economy', 'comfort'];

/** The modes Gladys may write (the select), by value of holding register 1. */
export const MODES = ['building-protection', 'economy', 'comfort'];

/** Input register 15, the current system mode (4: boost). */
export const SYSTEM_MODES = ['standby', 'building-protection', 'economy', 'comfort', 'boost'];

/** Input register 1, the current system state (stable keys, whatever the language). */
export const SYSTEM_STATES = [
  'standby',
  'building-protection',
  'economy',
  'comfort',
  'emergency-run',
  'preparing',
  'opening-dampers',
  'boost',
  'cooling-heaters',
  'closing-dampers',
  'night-cooling',
  'critical-alarm',
  'fire-alarm',
  'heat-exchanger-frost-protection',
  'change-filters',
  'low-room-humidity',
  'dx-cooler-defrosting',
  'fire-damper-testing',
];

/** System states in which no command that moves air is sent (the unit handles them). */
export const ALARM_STATES = new Set(['critical-alarm', 'fire-alarm']);

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  MODE: 'mode',
  SYSTEM_MODE: 'system-mode',
  SYSTEM_STATE: 'system-state',
  BOOST: 'boost',
  ALARM: 'alarm',
  WARNING: 'warning',
  TEMP_SUPPLY: 'temperature-supply',
  TEMP_EXTRACT: 'temperature-extract',
  TEMP_OUTDOOR: 'temperature-outdoor',
  FILTER_DAYS: 'filter-days-left',
  SUPPLY_RPM: 'fan-supply-rpm',
  EXTRACT_RPM: 'fan-extract-rpm',
  BOOST_START: 'boost-start',
  BOOST_STOP: 'boost-stop',
};

/**
 * The commands, by feature role: the write (function code, address), the
 * value for each choice, the value read back that confirms it.
 * `needsRunning`: may start the fans, so a unit in Stand-by (or in critical or
 * fire alarm) refuses it. `protective`: never held back by the option nor by
 * another command (stopping the boost).
 */
export const COMMANDS = {
  [FEATURES.MODE]: {
    write: { fc: FC.WRITE_REGISTER, address: 1 },
    read: 'mode',
    values: { 'building-protection': 1, economy: 2, comfort: 3 },
    needsRunning: true,
  },
  [FEATURES.BOOST_START]: {
    write: { fc: FC.WRITE_COIL, address: 5 },
    read: 'boost',
    button: [true, true],
    needsRunning: true,
  },
  [FEATURES.BOOST_STOP]: {
    write: { fc: FC.WRITE_COIL, address: 5 },
    read: 'boost',
    button: [false, false],
    protective: true,
  },
};

/** The value of a button press (Gladys sends 1). */
export const PRESSED = 1;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 30,
  max: 3600,
  default: 60,
};

/** The Modbus unit id (slave id) of the configuration. */
export const UNIT_ID = {
  min: 1,
  max: 247,
  default: 1,
};

export const LIMITS = {
  /** Gladys: 300 states per minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** A measure block that times out this many reads in a row (the unit answering others) is skipped. */
  blockTimeouts: 3,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection of a poll. */
  connectTimeout: 3 * SECOND,
  /** One answer. */
  requestTimeout: 2 * SECOND,
  /** A refused connection of a boost stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** A measure block skipped after repeated timeouts or refusals is tried again this often. */
  blockRetry: HOUR,
  /** A boost stop reaffirmed by a read leaves at least this long after the read closed the line. */
  reassertDelay: SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the connection, the fresh read
   * and the write must be done by 3.5 s after the click, or the command is
   * refused unsent; the read back that confirms it is awaited until 4.3 s,
   * after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** Connecting for a command: 2 s at most. */
  commandConnectMax: 2_000,
  /** One fresh read of a command: 1.5 s at most; 0.3 s at least left to send after it. */
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A boost stop not confirmed is reaffirmed by the reads of the next 2 minutes, twice at most. */
  stopGuard: 2 * MINUTE,
  stopReasserts: 2,
};
