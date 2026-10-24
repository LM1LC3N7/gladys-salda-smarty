// -----------------------------------------------------------------------------
// The pure layers: Modbus PDUs and their decoding, the MBAP session against a
// fake socket (bounded frames, hostile answers), and the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { BLOCK_OF, FC } from '../src/constants.js';
import { ERROR_KINDS, ModbusSession } from '../src/modbus/client.js';
import {
  decodeBlock,
  isEcho,
  parseRead,
  readRequest,
  writeRequest,
} from '../src/modbus/protocol.js';

const words = (count, set = {}) => {
  const out = new Array(count).fill(0);
  for (const [address, value] of Object.entries(set)) out[Number(address) - 1] = value;
  return out;
};

test('read requests: function, address, count (big-endian)', () => {
  assert.deepEqual([...readRequest(BLOCK_OF.inputs)], [4, 0, 1, 0, 66]);
  assert.deepEqual([...readRequest(BLOCK_OF.alarms)], [3, 0, 200, 0, 3]);
  assert.deepEqual([...readRequest(BLOCK_OF.coils)], [1, 0, 1, 0, 9]);
});

test('parseRead: only the exact size asked', () => {
  const block = { fc: FC.READ_HOLDING, count: 2 };
  assert.deepEqual(parseRead(block, Buffer.from([3, 4, 0, 1, 0xff, 0xfe])), [1, 0xfffe]);
  assert.equal(parseRead(block, Buffer.from([3, 4, 0, 1, 0xff])), undefined);
  assert.equal(parseRead(block, Buffer.from([3, 2, 0, 1])), undefined);
  assert.equal(parseRead(block, Buffer.from([4, 4, 0, 1, 0, 2])), undefined);
  const coils = { fc: FC.READ_COILS, count: 9 };
  const bits = parseRead(coils, Buffer.from([1, 2, 0b00010000, 0]));
  assert.equal(bits.length, 9);
  assert.equal(bits[4], true, 'coil 5');
  assert.equal(bits.filter(Boolean).length, 1);
  assert.equal(parseRead(coils, Buffer.from([1, 1, 0])), undefined);
});

test('decodeBlock: signed tenths, plausible ranges, stable keys', () => {
  const inputs = decodeBlock(
    BLOCK_OF.inputs,
    words(66, { 1: 7, 15: 4, 18: 0x10000 - 125, 19: 225, 21: 2000, 30: 5000, 55: 1500, 56: 20000 }),
  );
  assert.equal(inputs.state, 'boost');
  assert.equal(inputs.systemMode, 'boost');
  assert.equal(inputs.supply, -12.5);
  assert.equal(inputs.extract, 22.5);
  assert.equal(inputs.outdoor, undefined, '200 °C is not a temperature');
  assert.equal(inputs.filterDays, undefined);
  assert.equal(inputs.supplyRpm, 1500);
  assert.equal(inputs.extractRpm, undefined);
  assert.deepEqual(decodeBlock(BLOCK_OF.inputs, words(66, { 1: 18, 15: 5 })).state, undefined);
  assert.equal(decodeBlock(BLOCK_OF.holding, words(37, { 1: 0 })).mode, 'standby');
  assert.equal(decodeBlock(BLOCK_OF.holding, words(37, { 1: 3 })).mode, 'comfort');
  assert.equal(decodeBlock(BLOCK_OF.holding, words(37, { 1: 4 })).mode, undefined);
  assert.deepEqual(decodeBlock(BLOCK_OF.alarms, [1, 0, 0]), { alarm: true, warning: false });
  assert.deepEqual(decodeBlock(BLOCK_OF.alarms, [2, 0, 0]), { warning: false });
  assert.deepEqual(decodeBlock(BLOCK_OF.inputs, words(10)), {}, 'wrong count: nothing');
});

test('write requests: coil on/off, register, strict values; echo', () => {
  const on = writeRequest({ fc: FC.WRITE_COIL, address: 5 }, true);
  assert.deepEqual([...on], [5, 0, 5, 0xff, 0]);
  assert.deepEqual([...writeRequest({ fc: FC.WRITE_COIL, address: 5 }, false)], [5, 0, 5, 0, 0]);
  assert.deepEqual([...writeRequest({ fc: FC.WRITE_REGISTER, address: 1 }, 3)], [6, 0, 1, 0, 3]);
  assert.throws(() => writeRequest({ fc: FC.WRITE_COIL, address: 5 }, 1));
  assert.throws(() => writeRequest({ fc: FC.WRITE_REGISTER, address: 1 }, -1));
  assert.throws(() => writeRequest({ fc: FC.READ_HOLDING, address: 1 }, 1));
  assert.equal(isEcho(on, Buffer.from(on)), true);
  assert.equal(isEcho(on, Buffer.from([5, 0, 5, 0, 0])), false);
});

class Socket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.destroyed = false;
  }
  write(bytes) {
    this.sent.push(Buffer.from(bytes));
  }
  destroy() {
    this.destroyed = true;
  }
}

/** The MBAP answer to the last request sent, with `pdu`. */
function answer(socket, pdu, { tid, uid } = {}) {
  const request = socket.sent.at(-1);
  const out = Buffer.alloc(7 + pdu.length);
  out.writeUInt16BE(tid ?? request.readUInt16BE(0), 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(pdu.length + 1, 4);
  out[6] = uid ?? request[6];
  Buffer.from(pdu).copy(out, 7);
  return out;
}

test('session: MBAP framing, unit id, answers in chunks', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket, { unitId: 3 });
  const pending = session.request(readRequest({ fc: 3, address: 1, count: 1 }), {
    timeoutMs: 1000,
  });
  const frame = socket.sent[0];
  assert.equal(frame.readUInt16BE(2), 0);
  assert.equal(frame.readUInt16BE(4), 6);
  assert.equal(frame[6], 3);
  const out = answer(socket, [3, 2, 0, 2]);
  socket.emit('data', out.subarray(0, 4));
  socket.emit('data', out.subarray(4));
  assert.deepEqual([...(await pending)], [3, 2, 0, 2]);
  session.close();
});

test('session: hostile answers end it', async () => {
  const cases = [
    ['another transaction', (s) => answer(s, [3, 2, 0, 2], { tid: 0xbeef })],
    ['another unit id', (s) => answer(s, [3, 2, 0, 2], { uid: 9 })],
    ['another function', (s) => answer(s, [4, 2, 0, 2])],
    ['bytes beyond the frame', (s) => Buffer.concat([answer(s, [3, 2, 0, 2]), Buffer.from([0])])],
    [
      'a length over 260',
      (s) => {
        const b = answer(s, [3, 2, 0, 2]);
        b.writeUInt16BE(300, 4);
        return b;
      },
    ],
  ];
  for (const [name, build] of cases) {
    const socket = new Socket();
    const session = new ModbusSession(socket, { unitId: 1 });
    const pending = session.request(readRequest({ fc: 3, address: 1, count: 1 }), {
      timeoutMs: 1000,
    });
    socket.emit('data', build(socket));
    await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.PROTOCOL && err.sent, name);
    assert.ok(socket.destroyed, name);
  }
  const socket = new Socket();
  const session = new ModbusSession(socket);
  socket.emit('data', Buffer.from([0, 1, 0, 0, 0, 3, 1, 3, 0]));
  assert.ok(socket.destroyed, 'bytes without a request');
  assert.ok(session.dead);
});

test('session: an exception is REFUSED (sent), the session stays', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket);
  const pending = session.request(writeRequest({ fc: 6, address: 1 }, 2), { timeoutMs: 1000 });
  socket.emit('data', answer(socket, [0x86, 2]));
  await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.REFUSED && err.sent);
  assert.equal(session.dead, undefined);
  session.close();
});

test('session: beforeSend and startBy stop a request before any byte', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket, { now: () => 100 });
  await assert.rejects(
    session.request(Buffer.from([3, 0, 1, 0, 1]), { startBy: 50 }),
    (err) => err.kind === ERROR_KINDS.LATE && !err.sent,
  );
  await assert.rejects(
    session.request(Buffer.from([3, 0, 1, 0, 1]), {
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    (err) => err.beforeSend === true,
  );
  assert.equal(socket.sent.length, 0);
  session.close();
});

test('config: addresses, port, unit id (strict), interval', () => {
  assert.deepEqual(parseAddress('192.168.1.80'), { host: '192.168.1.80', port: 502 });
  assert.deepEqual(parseAddress('smarty.lan:1502'), { host: 'smarty.lan', port: 1502 });
  for (const bad of ['0.0.0.0', '224.0.0.1', '255.255.255.255', '1.2.3', 'a b', 'x:0', 'x:70000']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const ok = normalizeConfig({ host: '192.168.1.80', unit_id: '12' });
  assert.equal(ok.unitId, 12);
  assert.ok(ok.address);
  for (const bad of ['', ' ', '0', '248', 1.5, 'abc', '-1']) {
    const c = normalizeConfig({ host: '192.168.1.80', unit_id: bad });
    assert.equal(c.address, undefined, String(bad));
    assert.equal(c.badUnitId, true, String(bad));
  }
  assert.equal(normalizeConfig({ host: 'x', unit_id: null }).unitId, 1, 'missing: the default');
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ host: 'bad\u0007host' }).invalid, 'bad?host');
});
