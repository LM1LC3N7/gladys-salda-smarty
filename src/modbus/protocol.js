// -----------------------------------------------------------------------------
// The Modbus PDUs of the Salda Smarty (pure): the read requests of the blocks,
// what their answers mean, and the write requests. Register addresses and
// meanings ported from pysmarty2 (registers/*.json, smarty.py), the Salda MCB
// Modbus table. Every decoder returns undefined when the answer has not the
// exact size asked or the value is not plausible: an unknown value is never
// a value.
// -----------------------------------------------------------------------------

import { FC, READ_MODES, SYSTEM_MODES, SYSTEM_STATES } from '../constants.js';

const round1 = (value) => Math.round(value * 10) / 10;

/** Temperatures out of this range are read errors (no sensor, a register not filled). */
const TEMPERATURE_RANGE = [-60, 90];

/** The read request of a block. */
export function readRequest({ fc, address, count }) {
  const pdu = Buffer.alloc(5);
  pdu[0] = fc;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/**
 * The words (16-bit registers) of a register read answer, or the bits of a
 * coil read answer, or undefined when it is not exactly what was asked.
 */
export function parseRead({ fc, count }, pdu) {
  if (!Buffer.isBuffer(pdu) || pdu.length < 2 || pdu[0] !== fc) return undefined;
  const bytes = pdu[1];
  if (fc === FC.READ_COILS) {
    if (bytes !== Math.ceil(count / 8) || pdu.length !== 2 + bytes) return undefined;
    const bits = [];
    for (let i = 0; i < count; i += 1) {
      bits.push(((pdu[2 + (i >> 3)] >> (i & 7)) & 1) === 1);
    }
    return bits;
  }
  if (bytes !== count * 2 || pdu.length !== 2 + bytes) return undefined;
  const words = [];
  for (let i = 0; i < count; i += 1) {
    words.push(pdu.readUInt16BE(2 + i * 2));
  }
  return words;
}

/** Signed 16-bit (temperatures below zero). */
const int16 = (word) => (word >= 0x8000 ? word - 0x10000 : word);

/** Tenths of a degree, signed; undefined when out of range. */
function temperature(word) {
  if (!Number.isInteger(word)) return undefined;
  const value = int16(word) / 10;
  return value >= TEMPERATURE_RANGE[0] && value <= TEMPERATURE_RANGE[1] ? round1(value) : undefined;
}

const within = (word, min, max) =>
  Number.isInteger(word) && word >= min && word <= max ? word : undefined;

/** A register holding 0 or 1 (anything else is unknown). */
const flag = (word) => (word === 0 ? false : word === 1 ? true : undefined);

/** Register `address` of a block of words starting at `start`. */
const at = (words, start, address) => words[address - start];

/**
 * The values a block gives, by block key (only those plausible). The words
 * or bits are those of `parseRead`.
 */
export function decodeBlock(block, data) {
  if (!Array.isArray(data) || data.length !== block.count) return {};
  const values = {};
  const put = (key, value) => {
    if (value !== undefined) values[key] = value;
  };
  switch (block.key) {
    case 'holding':
      // Register 1: the mode set by the user (0 is Stand-by).
      put('mode', READ_MODES[at(data, block.address, 1)]);
      break;
    case 'alarms':
      put('alarm', flag(at(data, block.address, 200)));
      put('warning', flag(at(data, block.address, 201)));
      break;
    case 'coils':
      // Coil 5: intensive air flow (the boost).
      put('boost', at(data, block.address, 5));
      break;
    case 'inputs': {
      const word = (address) => at(data, block.address, address);
      put('state', SYSTEM_STATES[word(1)]);
      put('systemMode', SYSTEM_MODES[word(15)]);
      put('supply', temperature(word(18)));
      put('extract', temperature(word(19)));
      put('outdoor', temperature(word(21)));
      put('filterDays', within(word(30), 0, 3650));
      put('supplyRpm', within(word(55), 0, 10_000));
      put('extractRpm', within(word(56), 0, 10_000));
      break;
    }
    default:
      break;
  }
  return values;
}

/**
 * The write request of a command: a single register (function 6, a value
 * 0-65535) or a single coil (function 5, on 0xFF00 / off 0x0000).
 */
export function writeRequest({ fc, address }, value) {
  const pdu = Buffer.alloc(5);
  pdu[0] = fc;
  pdu.writeUInt16BE(address, 1);
  if (fc === FC.WRITE_COIL) {
    if (typeof value !== 'boolean') throw new TypeError('A coil takes true or false');
    pdu.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
  } else if (fc === FC.WRITE_REGISTER) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new RangeError('A register value is 0-65535');
    }
    pdu.writeUInt16BE(value, 3);
  } else {
    throw new RangeError('Not a write function');
  }
  return pdu;
}

/** A write is answered by the exact echo of its request. */
export const isEcho = (request, answer) => Buffer.isBuffer(answer) && request.equals(answer);
