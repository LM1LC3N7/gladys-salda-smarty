// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Smarty, with the
// exact wiring of the container (src/handlers.js) and a mocked clock (the
// monotonic clock follows the mocked Date).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SaldaSmartyApp } from '../src/app.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore, normalizeMemory } from '../src/store.js';
import { HOST, NOW, fakeSmarty, settle } from './fixtures/fakeSmarty.js';

const CFG = { host: HOST };
const ALLOW = { host: HOST, allow_commands: true };
const DEVICE = 'ext:test-integration:salda-smarty:unit';
const feature = (role) => `${DEVICE}:${role}`;
const BOOST_ON = { fc: 5, address: 5, value: 0xff00 };
const BOOST_OFF = { fc: 5, address: 5, value: 0 };

async function setup(
  t,
  { config = CFG, unit = fakeSmarty(), store = memoryStore(), create = true } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new SaldaSmartyApp({
    gladys,
    logger,
    connect: unit.connectFn,
    now: () => Date.now(),
    clock: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(3);
    }
  };
  const connecting = gladys.connect();
  await settle();
  await advance(500);
  await connecting;
  t.after(() => app.stop());
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
    await advance(1100);
  }
  const fire = (role, value = 1) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE) ?? {
      external_id: DEVICE,
    };
    return gladys.fake.setValue(device, { external_id: feature(role) }, value);
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = fire(role, value);
    await advance(wait, 50);
    return ack;
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  return { gladys, app, unit, advance, logs, fire, press, store, state };
}

test('discovery: one device, every value read and published', async (t) => {
  const ctx = await setup(t);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      (f.category === 'button' && f.type === 'push') ||
        (f.category === 'text' && f.type === 'select'),
      `${f.external_id} is writable`,
    );
  }
  const mode = device.features.find((f) => f.external_id === feature('mode'));
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    ['building-protection', 'economy', 'comfort'],
    'stand-by is never offered',
  );
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.state('temperature-extract').state, 21.4);
  assert.equal(ctx.state('temperature-outdoor').state, -5.2, 'signed register');
  assert.equal(ctx.state('filter-days-left').state, 87);
  assert.equal(ctx.state('fan-supply-rpm').state, 1250);
  assert.equal(ctx.state('fan-extract-rpm').state, 1300);
  assert.equal(ctx.state('boost').state, 0);
  assert.equal(ctx.state('alarm').state, 0);
  assert.equal(ctx.state('mode').text, 'economy');
  assert.equal(ctx.state('system-mode').text, 'economy');
  assert.equal(ctx.state('system-state').text, 'economy');
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.device_external_id ?? badge.external_id, DEVICE);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  // The exact requests of pysmarty2, one connection, closed after.
  assert.deepEqual(
    ctx.unit.log.slice(0, 4).map((r) => [r.fc, r.address, r.count]),
    [
      [3, 1, 37],
      [1, 1, 9],
      [4, 1, 66],
      [3, 200, 3],
    ],
  );
  assert.equal(ctx.unit.open.size, 0);
  assert.equal(ctx.unit.maxOpen, 1);
});

test('the commands are off by default: refused, nothing written', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.press('mode', 'comfort');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Autoriser les commandes/);
  assert.equal((await ctx.press('boost-start')).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a mode: decided on a fresh read, written, confirmed by the echo and the read back', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const reads = ctx.unit.reads();
  const ack = await ctx.press('mode', 'comfort');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [{ fc: 6, address: 1, value: 3 }]);
  assert.ok(ctx.unit.reads() >= reads + 3, 'fresh reads before, a read back after');
  assert.equal(ctx.state('mode').text, 'comfort');
  // Already so: nothing written, success.
  assert.equal((await ctx.press('mode', 'comfort')).success, true);
  assert.equal(ctx.unit.writes().length, 1);
});

test('the select takes only its values: never stand-by, never a number', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const bad of ['standby', 'boost', 0, 3, '3', '', null, ' comfort', 'Comfort']) {
    assert.equal((await ctx.press('mode', bad, 100)).success, false, String(bad));
  }
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a unit in stand-by is never started: mode and boost refused (lesson 26)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.map.holding.set(1, 0);
  ctx.unit.map.inputs.set(1, 0);
  ctx.unit.map.inputs.set(15, 0);
  for (const [role, value] of [
    ['mode', 'comfort'],
    ['boost-start', 1],
  ]) {
    const ack = await ctx.press(role, value);
    assert.equal(ack.success, false, role);
    assert.match(String(ack.error), /en veille/);
  }
  // Only the current mode reading stand-by (a schedule) is enough too.
  ctx.unit.map.holding.set(1, 2);
  const ack = await ctx.press('mode', 'comfort');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /en veille/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a unit in fire or critical alarm: no command that moves air', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.map.inputs.set(1, 12);
  const ack = await ctx.press('boost-start');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /alarme critique ou incendie/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('an unreadable state refuses the command (never decided on memory)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.map.inputs.set(1, 99);
  const ack = await ctx.press('mode', 'comfort');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /relu/);
  ctx.unit.map.inputs.set(1, 2);
  ctx.unit.exceptions.add('4:1');
  assert.equal((await ctx.press('mode', 'comfort')).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('buttons only take 1; read-only features refuse', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const bad of [0, true, 'on', null, 2]) {
    assert.equal((await ctx.press('boost-start', bad, 100)).success, false, String(bad));
  }
  assert.equal((await ctx.press('boost', 1, 100)).success, false);
  assert.equal((await ctx.press('system-mode', 'comfort', 100)).success, false);
  assert.equal((await ctx.press('temperature-outdoor', 1, 100)).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the boost start: coil 5 on, confirmed', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const ack = await ctx.press('boost-start');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [BOOST_ON]);
  assert.equal(ctx.state('boost').state, 1);
});

test('a write not applied: "sent, without confirmation", never "not sent"', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('boost-start');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /envoyée, sans confirmation/);
  assert.equal(ctx.unit.writes().length, 1);
  // The guard: pressed again, the same value is written again even if the read shows it.
  ctx.unit.ignoreWrites = false;
  assert.equal((await ctx.press('boost-start')).success, true);
  assert.equal(ctx.unit.writes().length, 2);
});

test('a write the unit refuses (Modbus exception): "refused", no guard', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('6:1');
  const ack = await ctx.press('mode', 'comfort');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /a refusé la commande/);
  assert.equal(ctx.app.guards.size, 0);
});

test('a wrong echo is never a confirmation', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.badEcho = true;
  const ack = await ctx.press('boost-start');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
});

test('the option turned off during the fresh read: refused, nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['1:1'] = 800;
  const ack = ctx.fire('boost-start');
  await ctx.advance(300);
  await ctx.gladys.fake.configUpdated({ ...ALLOW, allow_commands: false });
  await ctx.advance(3000, 50);
  const result = await ack;
  assert.equal(result.success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a slow unit: refused unsent within the deadline', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['1:1'] = 2500;
  const ack = await ctx.press('boost-start');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /non envoyée/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the boost stop: never behind the option, confirmed by the read back', async (t) => {
  const ctx = await setup(t);
  ctx.unit.map.coils.set(5, true);
  const ack = await ctx.press('boost-stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [BOOST_OFF]);
  assert.equal(ctx.state('boost').state, 0);
});

test('the boost stop works on a unit in stand-by or in alarm', async (t) => {
  const ctx = await setup(t);
  ctx.unit.map.coils.set(5, true);
  ctx.unit.map.holding.set(1, 0);
  ctx.unit.map.inputs.set(1, 12);
  assert.equal((await ctx.press('boost-stop')).success, true);
  assert.deepEqual(ctx.unit.writes(), [BOOST_OFF]);
});

test('the boost stop takes the line from a poll (dropped, nothing of it published)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.map.coils.set(5, true);
  ctx.unit.delay = 800;
  ctx.unit.map.inputs.set(21, 90);
  const before = ctx.gladys.fake.states.length;
  await ctx.advance(MINUTE + 300, 50);
  assert.ok(ctx.app.active?.kind === 'read', 'a poll is running');
  const ack = await ctx.press('boost-stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [BOOST_OFF]);
  const outdoor = ctx.gladys.fake.states
    .slice(before)
    .filter((s) => s.device_feature_external_id === feature('temperature-outdoor'));
  assert.deepEqual(outdoor, [], 'the dropped poll published nothing');
  assert.equal(ctx.unit.maxOpen, 1, 'never two connections at once');
});

test('the boost stop cancels a boost start not written yet', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['1:1'] = 600;
  const start = ctx.fire('boost-start');
  await ctx.advance(200);
  const stop = ctx.fire('boost-stop');
  await ctx.advance(5000, 50);
  const [a, b] = await Promise.all([start, stop]);
  assert.equal(a.success, false);
  assert.match(String(a.error), /arrêté entre-temps/);
  assert.equal(b.success, true, String(b.error));
  assert.deepEqual(ctx.unit.writes(), [BOOST_OFF]);
  assert.equal(ctx.unit.maxOpen, 1);
});

test('the boost stop goes before the first read after a restart, and says when not sent', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 10 * SECOND });
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.unit.reads(), 0, 'no read before the interval');
  ctx.unit.map.coils.set(5, true);
  assert.equal((await ctx.press('boost-stop')).success, true);
  ctx.unit.down = true;
  const ack = await ctx.press('boost-stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /non envoyée|pas encore envoyé/);
});

test('a boost stop not confirmed is reaffirmed by the next reads, three times at most', async (t) => {
  const ctx = await setup(t);
  ctx.unit.map.coils.set(5, true);
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('boost-stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  await ctx.advance(2 * MINUTE, 100);
  const stops = ctx.unit.writes().filter((w) => w.fc === 5 && w.value === 0);
  assert.equal(stops.length, 4, 'the stop and three reaffirmations');
  assert.equal(ctx.unit.maxOpen, 1);
});

test('never read sooner than the interval: button, scan, reconnection, same config', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.unit.reads();
  const answer = await ctx.gladys.fake.action('test_connection');
  assert.match(JSON.stringify(answer), /Prochaine lecture/);
  await ctx.gladys.fake.scanRequest();
  await ctx.app.connected(CFG);
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(1000);
  assert.equal(ctx.unit.reads(), reads);
  await ctx.advance(MINUTE);
  assert.ok(ctx.unit.reads() > reads, 'read again after the interval');
});

test('a restart waits for the interval after the last read kept in /data', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 30 * SECOND });
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.unit.reads(), 0);
  await ctx.advance(MINUTE + 31 * SECOND, 100);
  assert.ok(ctx.unit.reads() > 0);
  assert.ok(store.data.lastAttemptAt > NOW, 'the time of the read kept before it');
});

test('an unreachable unit: status says so, retried with a backoff, device unreachable', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  await ctx.advance(MINUTE + 100, 100);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Modbus TCP est activé/);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  const tries = ctx.unit.connections;
  await ctx.advance(30 * SECOND, 500);
  assert.equal(ctx.unit.connections, tries, 'never sooner than the interval');
});

test('a measure block refused is skipped for an hour, the others still read', async (t) => {
  const ctx = await setup(t);
  ctx.unit.exceptions.add('3:200');
  ctx.unit.map.inputs.set(18, 200);
  await ctx.advance(MINUTE, 100);
  assert.ok(ctx.logs.some((l) => /block alarms refused/.test(l)));
  assert.equal(ctx.state('temperature-supply').state, 20);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  const before = ctx.unit.log.filter((r) => r.address === 200).length;
  await ctx.advance(2 * MINUTE, 100);
  assert.equal(ctx.unit.log.filter((r) => r.address === 200).length, before, 'skipped');
});

test('a block that never answers ends the read, then is skipped', async (t) => {
  const ctx = await setup(t);
  ctx.unit.silent.add('4:1');
  for (let i = 0; i < 4; i += 1) {
    await ctx.advance(MINUTE, 100);
  }
  assert.ok(ctx.logs.some((l) => /inputs never answers/.test(l)));
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  ctx.unit.map.holding.set(200, 1);
  await ctx.advance(MINUTE, 100);
  assert.equal(ctx.state('alarm').state, 1, 'the blocks after it are read again');
});

test('frames in chunks are read; an answer to another transaction ends the read', async (t) => {
  const unit = fakeSmarty();
  unit.split = true;
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  unit.split = false;
  unit.wrongTransaction = true;
  unit.map.inputs.set(18, 200);
  await ctx.advance(MINUTE + 4 * SECOND, 50);
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
});

test('a stop of the integration during a read publishes nothing late', async (t) => {
  const ctx = await setup(t);
  ctx.unit.delay = 200;
  ctx.unit.map.inputs.set(21, 30);
  await ctx.advance(MINUTE + 300, 50);
  const before = ctx.gladys.fake.states.length;
  ctx.app.stop();
  await ctx.advance(5000, 100);
  assert.equal(ctx.gladys.fake.states.length, before);
});

test('the status and Discovery are sent again at each reconnection', async (t) => {
  const ctx = await setup(t);
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  const discovered = ctx.gladys.fake.discoveredDevices.length;
  await ctx.app.connected(CFG);
  assert.ok(ctx.gladys.fake.connectionStatuses.length > statuses);
  assert.ok(ctx.gladys.fake.discoveredDevices.length >= discovered);
});

test('an invalid unit id: nothing read, the status says why', async (t) => {
  const unit = fakeSmarty();
  const ctx = await setup(t, { unit, config: { host: HOST, unit_id: 0 }, create: false });
  assert.equal(unit.connections, 0);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Identifiant d’unité Modbus invalide/);
});

test('another unit id is sent in the frames', async (t) => {
  const unit = fakeSmarty();
  const ctx = await setup(t, { unit, config: { host: HOST, unit_id: '7' } });
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.ok(unit.log.every((r) => r.uid === 7));
});

test('a boost start refused by the unit never counts as the latest start (lesson 13)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('5:5');
  const before = ctx.app.lastBoostStartAt;
  const ack = await ctx.press('boost-start');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /a refusé la commande/);
  assert.equal(ctx.app.lastBoostStartAt, before);
  assert.equal(ctx.unit.writes().length, 1);
});

test('r1-1: a boost start landing after a confirmed stop is stopped again (sticky guard)', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: ALLOW, store });
  // The start's write reaches the unit 2 s later, on its old connection.
  ctx.unit.writeDelays = [2000];
  ctx.unit.applyClosedWrites = true;
  const start = ctx.fire('boost-start');
  await ctx.advance(300);
  const stop = ctx.fire('boost-stop');
  await ctx.advance(1000, 50);
  const stopped = await stop;
  assert.equal(stopped.success, true, String(stopped.error));
  const started = await start;
  assert.equal(started.success, false);
  assert.match(String(started.error), /sans confirmation|arrêté entre-temps/);
  await ctx.advance(1500, 50);
  assert.equal(ctx.unit.map.coils.get(5), true, 'the late start landed');
  assert.ok(store.data.stopGuard, 'the sticky guard is kept in /data');
  await ctx.advance(30 * SECOND, 100);
  assert.equal(ctx.unit.map.coils.get(5), false, 'stopped again');
  const stops = ctx.unit.writes().filter((w) => w.fc === 5 && w.value === 0);
  assert.ok(stops.length >= 2 && stops.length <= 4, `${stops.length} stops`);
  // Lifted by the time only.
  await ctx.advance(2 * MINUTE, 500);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(store.data.stopGuard, null);
});

test('r1-1: a sticky stop guard kept in /data comes back after a restart (same unit only)', async (t) => {
  const store = memoryStore({
    stopGuard: { unit: `${HOST}#1`, until: NOW + MINUTE, reasserts: 1 },
  });
  const unit = fakeSmarty();
  unit.map.coils.set(5, true);
  const ctx = await setup(t, { store, unit });
  await ctx.advance(3 * SECOND, 50);
  assert.equal(unit.map.coils.get(5), false, 'reaffirmed after the first read');
  const other = memoryStore({ stopGuard: { unit: '192.168.1.81#1', until: NOW + MINUTE } });
  const app = new SaldaSmartyApp({ gladys: ctx.gladys, store: other, now: () => Date.now() });
  app.config = { address: { host: HOST, port: 502 }, unitId: 1 };
  app.memory = normalizeMemory(await other.load(), Date.now());
  app.restoreStopGuard();
  assert.equal(app.stopGuard, undefined);
});

test('r1-2: a unit stopping (cooling heaters, closing dampers) is never started', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const code of [8, 9]) {
    ctx.unit.map.inputs.set(1, code);
    for (const [role, value] of [
      ['mode', 'comfort'],
      ['boost-start', 1],
    ]) {
      const ack = await ctx.press(role, value);
      assert.equal(ack.success, false, `${role} in ${code}`);
      assert.match(String(ack.error), /en train de s’arrêter/);
    }
  }
  assert.deepEqual(ctx.unit.writes(), []);
});

test('r1-5: exception 4-6 to a write is "sent, without confirmation" with a guard', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('5:5');
  ctx.unit.exceptionCode = 6;
  const before = ctx.app.lastBoostStartAt;
  const ack = await ctx.press('boost-start');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  assert.ok(ctx.app.guards.has('boost'));
  assert.ok(ctx.app.lastBoostStartAt > before, 'counts as a start that left');
});

test('r1-6: the boost stop is sent again when the unit accepts then closes the connection', async (t) => {
  const ctx = await setup(t);
  ctx.unit.map.coils.set(5, true);
  ctx.unit.dropConnections = 3;
  const ack = await ctx.press('boost-stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.unit.dropped, 3);
  assert.ok(ctx.unit.writes().length >= 2, 'tried again');
  assert.ok(ctx.unit.writes().every((w) => w.fc === 5 && w.value === 0));
  assert.equal(ctx.unit.map.coils.get(5), false);
});

test('r1-7: other versions read: commands refused until the test button accepts, stop never', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: ALLOW, store });
  assert.equal(store.data.identity.fingerprint, '0:0');
  ctx.unit.map.inputs.set(2, 121);
  await ctx.advance(MINUTE, 100);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /versions logicielle/);
  const ack = await ctx.press('mode', 'comfort');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Tester la connexion/);
  ctx.unit.map.coils.set(5, true);
  assert.equal((await ctx.press('boost-stop')).success, true, 'the stop is never blocked');
  const answer = await ctx.gladys.fake.action('test_connection');
  assert.match(JSON.stringify(answer), /121:0/);
  assert.equal(store.data.identity.fingerprint, '121:0');
  assert.equal((await ctx.press('mode', 'comfort')).success, true);
});

test('r1-7: unreadable versions are never another unit', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('4:1');
  await ctx.advance(MINUTE, 100);
  assert.equal(ctx.app.mismatch, undefined);
});

test('r1-8: an invalid address is never shown again, only its length', async (t) => {
  const ctx = await setup(t, { config: { host: 'sk-secret-key value' }, create: false });
  const message = JSON.stringify(ctx.gladys.fake.connectionStatus.message);
  assert.doesNotMatch(message, /secret/);
  assert.match(message, /19 caractères/);
});

test('r1-11: the status says stand-by when the current mode reads it (schedule)', async (t) => {
  const unit = fakeSmarty();
  unit.map.inputs.set(15, 0);
  const ctx = await setup(t, { unit });
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /en veille/);
});
