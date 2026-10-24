# gladys-salda-smarty

[Gladys Assistant](https://gladysassistant.com) external integration for
**Salda Smarty** heat recovery ventilation (Smarty 2X, 3X, 4X P/V), through
its **Modbus TCP** interface on the local network (port 502, no cloud, no
password): supply, extract and outdoor temperatures, mode, unit state, fan
speeds, filter days left, alarm, warning and boost; the mode (which is the
fan speed) and the boost start behind an off-by-default option, and "Stop the
boost" always allowed. **Never tested with a real device. Not affiliated with
Salda.** Modbus TCP has no authentication: keep the unit on a trusted network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SaldaSmartyApp)
                                  ├─ src/modbus/client.js    one Modbus TCP session at a time, bounded MBAP frames
                                  ├─ src/modbus/protocol.js  requests and decoders (pure)
                                  ├─ src/devices.js          the device and its states (pure)
                                  ├─ src/publisher.js        states within 300/min
                                  └─ src/store.js            /data/salda-smarty-state.json (last read)
```

- **Reads**: one Modbus TCP connection per poll (every 60 s, 30 s – 1 h),
  the four requests of pysmarty2 (holding registers 1-37 and 200-202, coils
  1-9, input registers 1-66), then closed. Never sooner than the interval
  (test button, Discovery, reconnection, unchanged configuration, container
  restart: the time of the last read is kept in `/data`, written at most
  once a minute, before the read). Failures retried after 30 s to 5 min,
  never under the interval. Exception to the interval: the reads 5 s and
  20 s after a command that was not confirmed.
- **Device**: `ext:<selector>:salda-smarty:unit` (the Modbus map gives no
  serial number; the address is never part of the id). Every feature is
  always published; no switch, no writable binary or fan.
- **Commands** (`allow_commands`, off by default): one `text/select` (mode:
  building protection, economy, comfort; stand-by never written) and the
  "Start the boost" button. A command takes the line from a poll, reads the
  mode, the unit state and the value again in its own session, is refused on
  a unit in stand-by (it would start it) or in critical or fire alarm,
  writes nothing when already so, checks the option, the configuration and
  a boost stop right before the write, writes within 3.5 s of the click or
  not at all, and is confirmed only by the echo of the write and the value
  read back (by 4.3 s); otherwise "sent, without confirmation", a guard and
  reads 5 s and 20 s later. A Modbus exception is "refused by the unit". One
  at a time, never retried; the ack never waits for Gladys.
- **Stop the boost** (protective): never behind the option, takes the line
  from anything, cancels a command not written yet, one write of coil 5; a
  refused connection is tried again every 250 ms until 3.5 s after the
  click. Not confirmed, it is reaffirmed by the reads of the next 2 minutes
  (twice at most); a boost start sent later lifts that guard.
- **One connection**: everything goes through one "line"; the integration
  never opens a second connection to the unit.
- **Hostile answers**: an MBAP frame is bounded (260 bytes) in a fixed
  buffer; another transaction id, unit id or function, bytes beyond the
  frame, bytes without a request, or a late answer end the session.
  Implausible values are unknown, never published.

## Development

```bash
npm install
npm test             # node --test (fake Gladys of the SDK, fake unit, mocked clock)
npm run lint
npm run format:check
npm run audit
npm run cover        # cover.png, plain Node
```

See [CLAUDE.md](CLAUDE.md) for the rules and [TODO.md](TODO.md) for the
status and the decisions.

## Credits and license

Register map ported from [pysmarty2](https://github.com/martinssipenko/pysmarty2)
(MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This integration
is licensed under the Apache License 2.0 ([LICENSE](LICENSE)).
