// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the time of the last read of the unit (written at most once a
// minute, BEFORE the read), so a restart never reads the unit sooner than the
// interval; the software/configuration versions of the unit (its light
// identity); a sticky boost stop guard (2 minutes at most). No secret (the
// Modbus interface has none), no personal data. The file is readable by the
// container user only (0600), bounded and repaired when read back.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/salda-smarty-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 4 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' && value.length <= max && /^[\x20-\x7e]*$/.test(value)
    ? value
    : undefined;

/**
 * The persisted state, repaired and bounded:
 * - `lastAttemptAt`: wall time of the last read, or null;
 * - `identity`: `{ unit, fingerprint }`, the software and configuration
 *   versions learnt for the unit `unit` (address and Modbus unit id), or null;
 * - `stopGuard`: `{ unit, until, reasserts }`, a sticky boost stop guard
 *   (wall time of its end) for the unit `unit`, or null.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const identity = data.identity && typeof data.identity === 'object' ? data.identity : {};
  const guard = data.stopGuard && typeof data.stopGuard === 'object' ? data.stopGuard : {};
  const unit = shortText(identity.unit, 280);
  const fingerprint = shortText(identity.fingerprint, 32);
  const guardUnit = shortText(guard.unit, 280);
  return {
    // A time in the future (a clock set back) counts as now: never a longer wait than the interval.
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    identity: unit && fingerprint ? { unit, fingerprint } : null,
    // A guard ends within its longest duration from now, whatever the clock said when it was kept.
    stopGuard:
      guardUnit && Number.isFinite(guard.until) && guard.until > now
        ? {
            unit: guardUnit,
            until: Math.min(guard.until, now + TIMINGS.stopGuard),
            reasserts: Number.isInteger(guard.reasserts)
              ? Math.min(TIMINGS.stopReasserts, Math.max(0, guard.reasserts))
              : 0,
          }
        : null,
  };
}
