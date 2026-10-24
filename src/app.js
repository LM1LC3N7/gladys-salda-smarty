// -----------------------------------------------------------------------------
// The integration: the unit typed in the configuration (its IP address and
// Modbus unit id), one read of its registers every poll interval over one
// Modbus TCP connection, the Gladys device and its states, the transport
// badge, the "Test the connection" button, and the commands. index.js only
// wires the SDK handlers to it (src/handlers.js).
//
// One Modbus connection at a time (the "line"): a poll is one session of four
// requests, closed after; a command takes the line from a poll (the poll is
// dropped, nothing of it published); "Stop the boost" takes it from anything.
//
// Reads follow the rules learnt on the previous modules:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart of the container (the time of the last
//     read is kept in /data, written at most once a minute, BEFORE the read);
//     a reconnection during a read joins it;
//   - an answer that arrives for an old configuration (generation) publishes
//     nothing and sets no status; a read begun before a command left is not
//     applied; a value not read this time is never republished as new.
//
// Commands (mode, boost start):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before the write (nothing runs in between);
//   - decided on a fresh read in the same session (the mode, the system state
//     and the register written), never on the state in memory; refused when a
//     value cannot be read; refused when the unit is in stand-by (they would
//     start it) or in critical or fire alarm; not written when already so
//     (unless a guard says a previous command may not show yet);
//   - written within 3.5 s of the click or refused unsent; confirmed only by
//     the echo of the write and a read back equal to the value asked, by
//     4.3 s; else "sent, without confirmation" and spaced reads; a Modbus
//     exception is "refused by the unit"; never retried; one at a time;
//   - the ack never waits for a publication to Gladys.
// "Stop the boost" protects: never held back by the option, another command,
// a failed read or a backoff (one try); possible before the first read after
// a restart; cancels a command not written yet; reaffirmed (twice at most) by
// the reads of the next two minutes when it was not confirmed.
//
// In-memory times (deadlines, guards, the time of the last read) are on a
// monotonic clock (`clock`); the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  ALARM_STATES,
  BLOCKS,
  BLOCK_OF,
  COMMANDS,
  FEATURES,
  LIMITS,
  PRESSED,
  SECOND,
  STATE_BLOCKS,
  TIMINGS,
  VALUE_BLOCK,
} from './constants.js';
import { ERROR_KINDS, ModbusError, errorReason, openSession, tcpConnect } from './modbus/client.js';
import { decodeBlock, isEcho, parseRead, readRequest, writeRequest } from './modbus/protocol.js';
import { buildDevice, commandOf, deviceStates, parseFeatureId, unitIds } from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const both = (en, fr) => ({ en, fr });

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time). */
  values: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

export class SaldaSmartyApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'salda-smarty' }),
    connect = tcpConnect,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.unit = freshUnit();
    this.generation = 0;
    this.started = false;
    /** The time of the last read sent to the unit (monotonic; /data keeps it within a minute). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The session on the line: { kind: 'read' | 'command' | 'protect', abort(), done }. */
    this.active = undefined;
    /** Commands getting ready to take the line (a poll does not start meanwhile). */
    this.reserved = 0;
    /** The command in flight (one at a time), and the boost stop in flight. */
    this.inFlight = undefined;
    this.protecting = undefined;
    /** Counts the boost stops: a command that sees it change before its write gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** When the last boost start left (and was not refused by the unit). */
    this.lastBoostStartAt = -Infinity;
    /** Value key -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** A boost stop not confirmed: { sentAt, until, reasserts }. */
    this.stopGuard = undefined;
    /** Block key -> timeouts in a row while the unit answered the others. */
    this.timeouts = new Map();
    /** Measure block key -> when it is tried again (skipped after repeated timeouts or refusals). */
    this.skipped = new Map();
    /** The pending reaffirmation of a boost stop. */
    this.reassertTimer = undefined;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the
   * interval after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    // Set at once: a `connected` or a configuration saved during this start
    // compares with it (never a restart, never a read before the interval).
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.unit.running;
    if (generation !== this.generation) {
      return;
    }
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    if (generation !== this.generation) {
      return;
    }
    this.unit = freshUnit();
    this.timeouts.clear();
    this.skipped.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.config.address) {
      // The device already created is shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    // The wall time kept, as a time of the monotonic clock.
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    this.active?.abort('stopped');
    this.publisher.stop();
    // Guards and reaffirmations belong to this address and this run only.
    this.guards.clear();
    this.stopGuard = undefined;
    if (this.reassertTimer) {
      this.timers.clearTimeout(this.reassertTimer);
      this.reassertTimer = undefined;
    }
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge) and the
   * last states, without reading the unit.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or unit id restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid ||
      next.unitId !== this.config.unitId
    );
  }

  /** A new interval: the next read follows it, counted from the last read. */
  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(
        `Salda Smarty commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`,
      );
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  // --- The line (one Modbus connection at a time) ------------------------------

  /**
   * Runs `fn(session)` on its own connection; the line is held until it ends.
   * `retryUntil`: a refused connection is tried again every 250 ms until then
   * (the unit may free its place a moment after our own close); nothing is
   * sent before the connection, so this never repeats a command.
   */
  async useLine(kind, timeoutMs, fn, { retryUntil } = {}) {
    let finish;
    const record = {
      kind,
      aborted: false,
      opener: undefined,
      session: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.opener?.abort();
        record.session?.abort(message);
      },
    };
    this.active = record;
    try {
      let session;
      for (;;) {
        const attemptMs =
          retryUntil === undefined
            ? timeoutMs
            : Math.min(timeoutMs, Math.max(100, retryUntil - this.mono()));
        record.opener = openSession({
          host: this.config.address.host,
          port: this.config.address.port,
          unitId: this.config.unitId,
          connect: this.connect,
          timeoutMs: attemptMs,
          timers: this.timers,
          now: () => this.mono(),
        });
        try {
          session = await record.opener.promise;
          break;
        } catch (err) {
          const again =
            err.kind === ERROR_KINDS.UNREACHABLE &&
            !record.aborted &&
            retryUntil !== undefined &&
            this.mono() + TIMINGS.connectRetry < retryUntil;
          if (!again) {
            throw err;
          }
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
        if (record.aborted) {
          throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
        }
      }
      record.session = session;
      if (record.aborted) {
        session.abort();
        throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
      }
      return await fn(session, record);
    } finally {
      record.session?.close();
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      await current.done;
    }
  }

  /** One block read in `session`: its values (only those plausible). */
  async readBlock(session, key, options) {
    const block = BLOCK_OF[key];
    const pdu = await session.request(readRequest(block), options);
    const data = parseRead(block, pdu);
    if (data === undefined) {
      // An answer of the wrong size: the session is not trusted any more.
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size', { sent: true });
    }
    return decodeBlock(block, data);
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval; never sooner than the interval after the last read. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    let wait = delay ?? (u.online === false ? u.wait : this.interval);
    // Capped at the interval: a clock jump never stops the reads.
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - this.mono()), 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('Salda Smarty refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /**
   * Keeps the time of this read; when the write of the minute is due, in
   * /data BEFORE the read (a container stopped during the read keeps it). At
   * most one write a minute.
   */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  async run() {
    const generation = this.generation;
    if (!this.config.address) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // A command holds the line: the poll waits for the next turn.
      this.schedule();
      return;
    }
    const startedAt = this.mono();
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      this.schedule();
      return;
    }
    let values;
    let failure;
    try {
      values = await this.useLine('read', TIMINGS.connectTimeout, (session) =>
        this.readAll(session),
      );
    } catch (err) {
      failure = err;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      // A command took the line: nothing of this read is applied.
      this.logger.debug('Salda Smarty: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      // Begun before a command left: it may show the state before it.
      this.logger.debug('Salda Smarty: read begun before a command, not applied');
    } else {
      this.applyRead(values);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * Every block, one after the other. A block that times out while the unit
   * answered the ones before ends the read (the session is gone): what was
   * read is kept. A block refused by the unit (Modbus exception) leaves its
   * values unknown this time. A state block (mode, boost) is never skipped; a
   * measure block that times out three reads in a row, or is refused, is
   * skipped and tried again every hour (one log line when it is skipped). A
   * state block that timed out is read last at the next read.
   */
  async readAll(session) {
    const values = {};
    let answered = 0;
    const late = (b) => STATE_BLOCKS.has(b.key) && this.timeouts.has(b.key);
    const order = [...BLOCKS.filter((b) => !late(b)), ...BLOCKS.filter(late)];
    for (const block of order) {
      const skippedUntil = this.skipped.get(block.key);
      if (skippedUntil !== undefined && this.mono() < skippedUntil) {
        continue;
      }
      let read;
      try {
        read = await this.readBlock(session, block.key, { timeoutMs: TIMINGS.requestTimeout });
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          answered += 1;
          if (STATE_BLOCKS.has(block.key)) {
            this.logger.warn(`Salda Smarty: block ${block.key} refused (${errorReason(err)})`);
          } else {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `Salda Smarty: block ${block.key} refused (${errorReason(err)}), tried again every hour`,
              );
            }
            this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          }
          continue;
        }
        if (err.kind === ERROR_KINDS.TIMEOUT && answered > 0) {
          const count = (this.timeouts.get(block.key) ?? 0) + 1;
          this.timeouts.set(block.key, count);
          if (STATE_BLOCKS.has(block.key)) {
            this.logger.warn(`Salda Smarty: block ${block.key} did not answer`);
          } else if (count >= LIMITS.blockTimeouts) {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `Salda Smarty: block ${block.key} never answers, tried again every hour`,
              );
            }
            this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          } else {
            this.logger.warn(`Salda Smarty: block ${block.key} did not answer`);
          }
          return values;
        }
        throw err;
      }
      answered += 1;
      this.timeouts.delete(block.key);
      this.skipped.delete(block.key);
      Object.assign(values, read);
    }
    return values;
  }

  /** A read: the values of this read only (a value not read is unknown). */
  applyRead(values) {
    const u = this.unit;
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    u.values = values;
    this.observe(values);
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = reason;
    this.logger.warn(`Salda Smarty: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    if (!c.address) {
      if (c.invalid) return T.invalid(c.invalid);
      return c.badUnitId ? T.badUnitId : T.noHost;
    }
    if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      return [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(u.error)
        ? T.unreachable(addressKey(c.address), wait)
        : T.failing(u.error ?? 'error', wait);
    }
    if (u.online === undefined) {
      return u.timer && this.due > this.mono()
        ? T.waiting(age(this.due - this.mono()))
        : T.connecting;
    }
    return T.connected(T.summary(u.values ?? {}));
  }

  async updateStatus() {
    await this.setStatus(this.unit.online === true && Boolean(this.config.address), this.status());
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice() {
    const id = unitIds(this.gladys).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The device, once the unit answered (every feature, always). */
  async publishDevices() {
    if (this.unit.online !== true) {
      return;
    }
    const devices = [buildDevice(this.gladys, { language: this.config.language })];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features. */
  queueValues(values, created = this.createdFeatures()) {
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      unitIds(this.gladys),
      values,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  queueStates(created) {
    if (this.unit.online === true && this.unit.values) {
      this.queueValues(this.unit.values, created);
    }
  }

  async publishBadge() {
    const device = this.createdDevice();
    const online = this.unit.online;
    if (!device || (online === undefined && this.config.address)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport: online === true ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    const u = this.unit;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status();
    if (u.running) {
      await u.running;
      return current();
    }
    if (this.mono() < this.due) {
      const waited = T.waiting(age(this.due - this.mono()));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(current(), T.lastRead(age(this.mono() - this.lastAttemptAt))), waited)
        : waited;
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const role = parseFeatureId(feature?.external_id);
    const command = role ? commandOf(role) : undefined;
    if (!command) {
      throw this.refusal(ERRORS.readOnly);
    }
    let written;
    let expected;
    if (command.button) {
      // Strictly 1: null, '', true, 0 or "on" never press a button.
      if (value !== PRESSED && value !== String(PRESSED)) {
        throw this.refusal(ERRORS.badButton);
      }
      [written, expected] = command.button;
    } else {
      // Strictly one of the values of the select: never trimmed, re-cased nor a number.
      if (typeof value !== 'string' || !Object.hasOwn(command.values, value)) {
        throw this.refusal(ERRORS.badValue);
      }
      written = command.values[value];
      expected = value;
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noHost);
    }
    const plan = { role, command, written, expected };
    if (command.protective) {
      return this.protect(plan, received);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.inFlight) {
      throw this.refusal(ERRORS.busy);
    }
    if (this.protecting) {
      throw this.refusal(ERRORS.protectMeanwhile);
    }
    const promise = this.command(plan, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /** The values a command read or confirmed: in memory and to Gladys in the background. */
  noteValues(values, { fromCommand = false } = {}) {
    if (this.unit.online !== true || !this.unit.values) {
      return;
    }
    Object.assign(this.unit.values, values);
    this.observe(values, { fromCommand });
    this.queueValues(values);
    // Shown in the background: the ack never waits for Gladys.
    this.flush().catch(() => {});
  }

  async command(plan, received) {
    const generation = this.generation;
    const seq = this.protectSeq;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The checks before the write, on the latest configuration.
    const check = () => {
      if (!this.config.allowCommands) {
        throw this.refusal(ERRORS.disabled);
      }
      if (generation !== this.generation || !this.config.address) {
        throw this.refusal(ERRORS.configChanged);
      }
      if (seq !== this.protectSeq) {
        throw this.refusal(ERRORS.protectMeanwhile);
      }
    };
    const state = { written: false, seq };
    this.reserved += 1;
    try {
      await this.takeLine(['read']);
      if (this.active) {
        throw this.refusal(this.active.kind === 'protect' ? ERRORS.protectMeanwhile : ERRORS.busy);
      }
      check();
      const connectBudget = Math.min(
        TIMINGS.commandConnectMax,
        sendBy - TIMINGS.commandMinSend - TIMINGS.commandMinRead - this.mono(),
      );
      if (connectBudget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      return await this.useLine('command', connectBudget, (session) =>
        this.commandSession(session, plan, { check, sendBy, answerBy, state }),
      );
    } catch (err) {
      throw this.commandError(err, plan, state);
    } finally {
      this.reserved -= 1;
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, plan, state) {
    if (err instanceof Refusal) {
      return err;
    }
    if (err?.beforeSend) {
      return err;
    }
    const reason = errorReason(err);
    const what = `${plan.role} ${plan.written}`;
    // Only the write says whether the command may have left (a read never does).
    if (!state.written) {
      this.logger.warn(`Salda Smarty: command NOT sent (${what}): ${reason}`);
      if (err?.kind === ERROR_KINDS.LATE) {
        return this.refusal(ERRORS.tooSlow);
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          state.seq !== this.protectSeq ? ERRORS.protectMeanwhile : ERRORS.configChanged,
        );
      }
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      // A Modbus exception to the write: the unit did not apply it.
      this.logger.warn(`Salda Smarty: command refused by the unit (${what}): ${reason}`);
      return this.refusal(ERRORS.refused(reason));
    }
    return this.unconfirmed(plan, state, reason);
  }

  /** A command that may have reached the unit: guard, spaced reads, "sent, without confirmation". */
  unconfirmed(plan, state, reason) {
    const key = plan.command.read;
    this.guards.set(key, {
      from: state.from,
      expected: plan.expected,
      moved: false,
      until: this.mono() + TIMINGS.guard,
    });
    this.followUp();
    this.logger.warn(`Salda Smarty: command sent, NOT confirmed (${plan.role}): ${reason}`);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  async commandSession(session, plan, { check, sendBy, answerBy, state }) {
    const { command } = plan;
    // The state just before acting, read now in this session, never the one in memory.
    // A command that may start the fans reads the mode and the system state too.
    const keys = command.needsRunning
      ? ['mode', 'state', 'systemMode', command.read]
      : [command.read];
    const blocks = [...new Set(keys.map((key) => VALUE_BLOCK[key]))];
    const fresh = {};
    for (const key of blocks) {
      const budget = Math.min(
        TIMINGS.commandReadMax,
        sendBy - TIMINGS.commandMinSend - this.mono(),
      );
      if (budget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      try {
        Object.assign(fresh, await this.readBlock(session, key, { timeoutMs: budget }));
      } catch (err) {
        if (err.kind === ERROR_KINDS.ABORTED) {
          throw err;
        }
        throw this.refusal(ERRORS.unknownState(errorReason(err)));
      }
    }
    for (const key of keys) {
      if (fresh[key] === undefined) {
        throw this.refusal(
          key === 'mode'
            ? ERRORS.unknownMode
            : ERRORS.unknownState(word(ERRORS.unreadable, this.config.language)),
        );
      }
    }
    check();
    // A fresh read of a command never reaffirms a boost stop.
    this.noteValues(fresh, { fromCommand: true });
    if (command.needsRunning) {
      // A unit in stand-by is never started by Gladys (a mode or a boost would start it).
      if (fresh.mode === 'standby' || fresh.systemMode === 'standby' || fresh.state === 'standby') {
        throw this.refusal(ERRORS.unitStandby);
      }
      if (ALARM_STATES.has(fresh.state)) {
        throw this.refusal(ERRORS.unitAlarm);
      }
    }
    if (plan.role === FEATURES.BOOST_START) {
      // A boost start decided is the latest wish: an older boost stop is never reaffirmed after it.
      this.stopGuard = undefined;
    }
    state.from = fresh[command.read];
    if (state.from === plan.expected && !this.guardActive(command.read)) {
      // Already so: nothing sent.
      this.logger.info(`Salda Smarty: ${plan.role} already so, nothing sent`);
      return;
    }
    this.logger.info(`Salda Smarty: ${plan.role} (${plan.written})`);
    const request = writeRequest(command.write, plan.written);
    const previousBoostStart = this.lastBoostStartAt;
    let echo;
    try {
      echo = await session.request(request, {
        timeoutMs: Math.max(100, answerBy - this.mono()),
        startBy: sendBy,
        beforeSend: () => {
          // The option, the configuration and a boost stop, checked right before the write.
          check();
          state.written = true;
          this.lastSentAt = this.mono();
          if (plan.role === FEATURES.BOOST_START) {
            this.lastBoostStartAt = this.mono();
          }
        },
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.REFUSED) {
        // Refused by the unit: not applied, and never counts as the latest boost start.
        state.refused = true;
        this.lastBoostStartAt = previousBoostStart;
      }
      throw err;
    }
    if (!isEcho(request, echo)) {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
    }
    // Confirmed only by the value read back equal to the value asked.
    const left = answerBy - this.mono();
    if (left < 50) {
      throw new ModbusError(ERROR_KINDS.TIMEOUT, 'no time left to read back', { sent: true });
    }
    const back = (await this.readBlock(session, VALUE_BLOCK[command.read], { timeoutMs: left }))[
      command.read
    ];
    if (back !== plan.expected) {
      if (back !== undefined) {
        this.noteValues({ [command.read]: back });
      }
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'read back differs', { sent: true });
    }
    this.guards.delete(command.read);
    this.noteValues({ [command.read]: back });
    this.logger.info(`Salda Smarty: ${plan.role} confirmed by the unit`);
  }

  // --- The boost stop (protective) -----------------------------------------------

  /** A second press while one runs joins it. */
  async protect(plan, received) {
    if (this.protecting) {
      return this.protecting;
    }
    const promise = this.sendStop(plan, received);
    this.protecting = promise;
    try {
      return await promise;
    } finally {
      if (this.protecting === promise) {
        this.protecting = undefined;
      }
    }
  }

  /**
   * Never held back: takes the line from anything, one write, without a
   * fresh read; a refused connection is tried again every 250 ms until 3.5 s
   * after the click (nothing is sent before it); the echo of the write and
   * the coil read back confirm it. Answered by 4.3 s; still running then, it
   * goes on, bounded by its connection (3 s) and two answers (2 s each), and
   * the answer says whether it was written yet.
   */
  async sendStop(plan, received) {
    // A command not written yet gives way (checked right before its write).
    this.protectSeq += 1;
    const state = { written: false, sentAt: undefined };
    this.reserved += 1;
    const sending = (async () => {
      try {
        await this.takeLine(['read', 'command', 'protect']);
        const retryUntil = received + TIMINGS.commandSendBy;
        return await this.useLine(
          'protect',
          TIMINGS.connectTimeout,
          async (session) => {
            const request = writeRequest(plan.command.write, plan.written);
            const echo = await session.request(request, {
              beforeSend: () => {
                state.written = true;
                state.sentAt = this.mono();
                this.lastSentAt = this.mono();
              },
            });
            if (!isEcho(request, echo)) {
              session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
              throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', {
                sent: true,
              });
            }
            return (await this.readBlock(session, VALUE_BLOCK[plan.command.read]))[
              plan.command.read
            ];
          },
          { retryUntil },
        );
      } finally {
        this.reserved -= 1;
      }
    })();
    this.logger.info('Salda Smarty: boost stop');
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let late;
    const outcome = await new Promise((resolve) => {
      late = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      sending.then(
        (back) => resolve({ back }),
        (err) => resolve({ err }),
      );
    });
    this.timers.clearTimeout(late);
    if (outcome.back === plan.expected) {
      this.guards.delete(plan.command.read);
      this.stopGuard = undefined;
      this.noteValues({ [plan.command.read]: outcome.back });
      this.logger.info('Salda Smarty: boost stop confirmed by the unit');
      return;
    }
    // Not confirmed: the reads of the next two minutes reaffirm it.
    this.keepStopGuard(state.sentAt ?? this.mono());
    this.followUp();
    if (outcome.late) {
      sending.catch((err) =>
        this.logger.warn(`Salda Smarty: boost stop failed after the ack (${errorReason(err)})`),
      );
      if (!state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(
        ERRORS.sentUnconfirmed(
          word(both('no answer yet', 'pas encore de réponse'), this.config.language),
        ),
      );
    }
    if (outcome.err) {
      const reason = errorReason(outcome.err);
      this.logger.warn(`Salda Smarty: boost stop failed (${reason})`);
      if (!state.written) {
        throw this.refusal(ERRORS.notSent(reason));
      }
      if (outcome.err.kind === ERROR_KINDS.REFUSED) {
        throw this.refusal(ERRORS.refused(reason));
      }
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (outcome.back !== undefined) {
      this.noteValues({ [plan.command.read]: outcome.back });
    }
    throw this.refusal(
      ERRORS.sentUnconfirmed(word(both('still on', 'toujours actif'), this.config.language)),
    );
  }

  keepStopGuard(sentAt) {
    if (this.stopGuard && this.mono() < this.stopGuard.until) {
      this.stopGuard.sentAt = Math.max(this.stopGuard.sentAt, sentAt);
      return;
    }
    this.stopGuard = { sentAt, until: this.mono() + TIMINGS.stopGuard, reasserts: 0 };
  }

  // --- Guards --------------------------------------------------------------------

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A read through the guards: a guard lifts when the value moved from the
   * start state to the one asked (never on an unknown value); a boost stop
   * not confirmed is sent again when the boost shows on and no boost start
   * left after it.
   */
  observe(values, { fromCommand = false } = {}) {
    for (const key of [...this.guards.keys()]) {
      if (!this.guardActive(key) || values[key] === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (values[key] !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && values[key] === guard.expected) {
        this.guards.delete(key);
      }
    }
    const stop = this.stopGuard;
    if (!stop) {
      return;
    }
    if (this.mono() >= stop.until || this.lastBoostStartAt > stop.sentAt) {
      this.stopGuard = undefined;
      return;
    }
    if (values.boost === false) {
      this.stopGuard = undefined;
      return;
    }
    if (
      values.boost === true &&
      !fromCommand &&
      !this.protecting &&
      !this.reassertTimer &&
      stop.reasserts < TIMINGS.stopReasserts
    ) {
      stop.reasserts += 1;
      this.logger.warn('Salda Smarty: the boost is still on after a stop, stop sent again');
      // Not awaited, and a second after the read closed the line.
      const generation = this.generation;
      this.reassertTimer = this.timers.setTimeout(() => {
        this.reassertTimer = undefined;
        if (
          generation !== this.generation ||
          !this.config.address ||
          !this.stopGuard ||
          this.lastBoostStartAt > this.stopGuard.sentAt
        ) {
          return;
        }
        this.protect(
          {
            role: FEATURES.BOOST_STOP,
            command: COMMANDS[FEATURES.BOOST_STOP],
            written: false,
            expected: false,
          },
          this.mono(),
        ).catch((err) => this.logger.warn(`Salda Smarty: stop reaffirmed: ${err.message}`));
      }, TIMINGS.reassertDelay);
    }
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Salda Smarty refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}
