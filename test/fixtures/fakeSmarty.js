// -----------------------------------------------------------------------------
// A fake Salda Smarty behind the injected `connect` (no network): Modbus TCP
// framing (MBAP), the registers pysmarty2 reads, writes applied, answers after
// a delay (mocked timers). It counts the connections open at once (the
// integration must never open a second one). Values made up, never from a
// real unit.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.80';
export const NOW = Date.UTC(2026, 9, 24, 10, 0, 0);

/** A unit in Economy, no boost, no alarm. */
export function defaultMap() {
  const holding = new Map([
    [1, 2], // mode: economy
    [200, 0], // alarm A
    [201, 0], // alarm B (warning)
    [202, 0],
  ]);
  for (let a = 2; a <= 37; a += 1) holding.set(a, 0);
  const coils = new Map();
  for (let a = 1; a <= 9; a += 1) coils.set(a, false);
  const inputs = new Map();
  for (let a = 1; a <= 132; a += 1) inputs.set(a, 0);
  inputs.set(1, 2); // state: economy
  inputs.set(15, 2); // current mode: economy
  inputs.set(18, 185); // supply 18.5 °C
  inputs.set(19, 214); // extract 21.4 °C
  inputs.set(21, 0x10000 - 52); // outdoor -5.2 °C
  inputs.set(30, 87); // filter days left
  inputs.set(55, 1250); // supply rpm
  inputs.set(56, 1300); // extract rpm
  return { holding, coils, inputs };
}

class FakeSocket extends EventEmitter {
  constructor(unit) {
    super();
    this.unit = unit;
    this.destroyed = false;
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.unit.handle(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.unit.open.has(this)) {
      this.unit.open.delete(this);
    }
    setImmediate(() => this.emit('close'));
  }

  setNoDelay() {}
}

export function fakeSmarty({ map = defaultMap(), unitId = 1 } = {}) {
  const unit = {
    map,
    unitId,
    open: new Set(),
    /** The most connections open at once (must stay 1). */
    maxOpen: 0,
    /** Every request received: { fc, address, value? }. */
    log: [],
    connections: 0,
    refused: 0,
    down: false,
    connectDelay: 5,
    delay: 10,
    /** Function codes or "fc:address" keys that never answer, answer an exception, or delays. */
    silent: new Set(),
    exceptions: new Set(),
    delays: {},
    /** Writes acknowledged but not applied (an unconfirmed command). */
    ignoreWrites: false,
    /** Answers split in two chunks, or with a wrong transaction id, or a wrong echo. */
    split: false,
    wrongTransaction: false,
    badEcho: false,
    handle(socket, frame) {
      const tid = frame.readUInt16BE(0);
      const uid = frame[6];
      const pdu = frame.subarray(7);
      const fc = pdu[0];
      const address = pdu.readUInt16BE(1);
      const arg = pdu.readUInt16BE(3);
      const write = fc === 5 || fc === 6;
      unit.log.push(write ? { fc, address, value: arg } : { fc, address, count: arg, uid });
      const key = `${fc}:${address}`;
      if (unit.silent.has(key) || unit.silent.has(fc)) return;
      setTimeout(() => {
        if (socket.destroyed) return;
        let answer;
        if (unit.exceptions.has(key) || unit.exceptions.has(fc)) {
          answer = Buffer.from([fc | 0x80, 2]);
        } else if (fc === 3 || fc === 4) {
          const table = fc === 3 ? unit.map.holding : unit.map.inputs;
          answer = Buffer.alloc(2 + arg * 2);
          answer[0] = fc;
          answer[1] = arg * 2;
          for (let i = 0; i < arg; i += 1)
            answer.writeUInt16BE(table.get(address + i) ?? 0, 2 + i * 2);
        } else if (fc === 1) {
          const bytes = Math.ceil(arg / 8);
          answer = Buffer.alloc(2 + bytes);
          answer[0] = fc;
          answer[1] = bytes;
          for (let i = 0; i < arg; i += 1) {
            if (unit.map.coils.get(address + i)) answer[2 + (i >> 3)] |= 1 << (i & 7);
          }
        } else if (write) {
          if (!unit.ignoreWrites) {
            if (fc === 5) unit.map.coils.set(address, arg === 0xff00);
            else unit.map.holding.set(address, arg);
            if (fc === 6 && address === 1) {
              unit.map.inputs.set(15, arg);
              unit.map.inputs.set(1, arg);
            }
          }
          answer = Buffer.from(pdu);
          if (unit.badEcho) answer[4] ^= 1;
        } else {
          answer = Buffer.from([fc | 0x80, 1]);
        }
        const out = Buffer.alloc(7 + answer.length);
        out.writeUInt16BE(unit.wrongTransaction ? (tid + 1) & 0xffff : tid, 0);
        out.writeUInt16BE(0, 2);
        out.writeUInt16BE(answer.length + 1, 4);
        out[6] = uid;
        answer.copy(out, 7);
        if (unit.split) {
          socket.emit('data', out.subarray(0, 3));
          socket.emit('data', out.subarray(3));
        } else {
          socket.emit('data', out);
        }
      }, unit.delays[key] ?? unit.delay);
    },
    connect() {
      const socket = new FakeSocket(unit);
      unit.connections += 1;
      setTimeout(() => {
        if (socket.destroyed) return;
        if (unit.down) {
          unit.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        unit.open.add(socket);
        unit.maxOpen = Math.max(unit.maxOpen, unit.open.size);
        socket.emit('connect');
      }, unit.connectDelay);
      return socket;
    },
    writes: () => unit.log.filter((r) => r.fc === 5 || r.fc === 6),
    reads: () => unit.log.filter((r) => r.fc !== 5 && r.fc !== 6).length,
  };
  unit.connectFn = () => unit.connect();
  return unit;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
