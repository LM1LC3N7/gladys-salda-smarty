# TODO — Salda Smarty v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 15) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-24): the unit by IP address and Modbus
      unit id, the four requests of pysmarty2 every interval over one
      connection (never sooner, even after a restart), one device, mode
      select and boost buttons behind `allow_commands` (off), "Stop the
      boost" never held back by the option, test button, docs en/fr, cover.
      Tested against a fake unit only.
- [ ] **Milestone 2 — real unit**: run against a real Smarty (see "To check").
- [ ] **Milestone 3 — more**: filter timer reset (coil 1) and alarm reset
      (holding 202) as buttons behind the option, if a real unit shows how
      their effect can be confirmed; discrete inputs (alarm details).

## To check on a real unit

- That the protocol addresses of pysmarty2 (pymodbus' address = the number in
  its JSON tables) are the ones the unit answers; that a write of holding
  register 1 and of coil 5 shows at once in the read back.
- That the temperatures below zero read as signed 16-bit values (pysmarty2
  reads them unsigned).
- What the boost coil reads once the unit ends the boost by itself, and how
  long it lasts.
- Whether the unit accepts a second Modbus client (Home Assistant and Gladys
  at once) and how fast it answers the four requests.
- Whether a mode written while a weekly schedule runs is kept or overridden.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-salda-smarty:0.1.0`);
  the first patch release gives 0.1.1. The manifest test checks the semver
  shape and that the four agree, never a pinned value.
- **Reference**: pysmarty2 0.10.3 (MIT; LICENSE file read: "Copyright (c)
  2019 Teodor Nicolau", the original pysmarty project; maintained by
  martinssipenko), cloned read-only in `~/code/ref/lot15/pysmarty2` (commit
  87575ec). Credited in `THIRD_PARTY_NOTICES.md` with the full license text,
  copied in the image. No register outside pysmarty2 is used; the same
  requests (start, count) as pysmarty2 for the poll.
- **Sibling modules**: gladys-danfoss-air (structure, line, polling, guards,
  protective boost stop, publisher, store) and gladys-flexit (stopped-unit
  rule, lesson 26).
- **Identity (FROZEN RULE)**: the Modbus map gives no serial number, so the
  device is `salda-smarty:unit`, one per integration, never the IP address.
  Consequence, documented: identity cannot be checked before a command
  (another unit at the same address would receive them; a DHCP reservation
  is recommended); plausibility checks only (sizes, ranges, known values).
- **One Modbus connection at a time** (`useLine`): a poll is one session of
  four requests, closed after; a command aborts a running poll (nothing of
  it is applied) and opens its own session; "Stop the boost" aborts
  anything, including a command (not written: refused "boost stopped
  meanwhile"; written: "sent, without confirmation"). A test checks that the
  fake unit never sees two connections at once.
- **Mode = speed**: holding register 1 is both the mode and the fan speed of
  the Smarty (Home Assistant shows it as speeds 1-3). One select:
  `building-protection`, `economy`, `comfort` (1-3). **Stand-by (0) is never
  written**: stopping the ventilation is out of v1 (if ever: its own option,
  off by default, a list value, never a switch).
- **Stopped unit (lesson 26)**: the mode and the boost start may start the
  fans, so they are refused when the fresh read shows stand-by in holding 1,
  input 15 (current mode) or input 1 (state), or a critical or fire alarm
  state. An unreadable mode, state or current mode refuses them too. The
  boost stop is never checked.
- **Protective command**: only "Stop the boost" (coil 5 off). Not behind the
  option; one write, no fresh read; a refused connection is tried again
  every 250 ms until 3.5 s after the press; confirmed by the echo and the
  coil read back; when not confirmed or not sent, a guard of 2 minutes
  resends it (twice at most, a second after the read that saw the boost on)
  unless a boost start left after it (set in `beforeSend`; a start refused by
  the unit with a Modbus exception does not count). A second press joins
  the first.
- **Deadlines**: connection 2 s max, each fresh read 1.5 s max, write by
  3.5 s after the click (checked right before the bytes), read back until
  4.3 s. The written flag is set in `beforeSend`: a write cut afterwards is
  always "sent, without confirmation"; a Modbus exception to a write is
  "refused by the unit" (not applied, no guard).
- **Clocks**: deadlines, guards and the time of the last read in memory use a
  monotonic clock (`performance.now()`); the wall clock only for `/data`.
- **Reads**: values not read this time are left out (never republished as
  new). A block that times out ends the read (the session is closed: a late
  answer is never taken for the next one); a state block (holding 1-37,
  coils) is read again at the next poll, a measure block (inputs, alarms) is
  skipped after three timeouts or one Modbus exception and tried again every
  hour (one log line). Implausible values are unknown: temperatures outside
  -60..90 °C, mode outside 0-3, current mode outside 0-4, state outside
  0-17, filter days over 3650, rpm over 10000, alarm flags other than 0/1.
- **Frames**: MBAP header checked (transaction id, protocol 0, unit id,
  function or its exception), length bounded (260 bytes), exact byte count
  for each answer, exact echo for a write; anything else ends the session.
- **Configuration**: IPv4 unicast (0.x, 224-255 refused) or host name,
  optional port (502); unit id a whole number 1-247 (strict: '' or 1.5 is
  invalid, nothing is read, the status says why); interval 30 s – 1 h.
- **No 429/5xx** (raw TCP): failures back off 30 s, 1, 2, 5 min, never under
  the interval. No credentials, nothing secret: `/data` holds only the time
  of the last read (written at most once a minute, before the read).
- **Units**: °C; filter days on `duration/integer` in days; fan speeds in
  rpm are `unknown` integer sensors (no rpm unit in the core). Texts (current
  mode, state) are stable English keys on read-only `text/text` features.
- **Not done**: Bluetooth (none), scenes, widgets, filter and alarm resets,
  discrete inputs, ventilation stop.
