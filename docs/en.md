# Salda Smarty for Gladys

Shows a **Salda Smarty** heat recovery ventilation unit (Smarty 2X, 3X, 4X
P/V, MCB controller) in Gladys, through its **Modbus TCP** interface on your
local network, without any cloud or account. Unofficial integration, **not
affiliated with Salda**. **Never tested with a real device**: it reads and
writes the registers Salda publishes, as the open-source pysmarty2 library
(used by Home Assistant) does; please report what you see.

## Before you start

- The unit must be on your network (Ethernet) with **Modbus TCP enabled**,
  reachable from Gladys on **port 502**. Give it a fixed IP address in your
  router.
- Modbus TCP has **no password**: keep the unit on a trusted network.
- The Modbus unit id (slave address) is 1 unless you changed it on the unit.

## Installation

1. Install the integration from the Gladys store.
2. Enter the **IP address of the unit** (port 502 unless you add one) and, if
   needed, the Modbus unit id; save.
3. Open the **Discovery** tab and add the unit.

## What you get

One device, **Salda Smarty ventilation**, with:

| Feature                                      | Notes                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Supply, extract and outdoor air temperatures | °C                                                                                        |
| Supply and extract fan speeds                | rpm                                                                                       |
| Filter: days left                            | days                                                                                      |
| Ventilation mode (speed)                     | list: building protection (speed 1), economy (speed 2), comfort (speed 3)                 |
| Current mode                                 | text: `standby`, `building-protection`, `economy`, `comfort`, `boost`                     |
| Unit state                                   | text (stable English key, for example `economy`, `boost`, `change-filters`, `fire-alarm`) |
| Boost active, alarm, warning                 | read only, 1 = active                                                                     |
| Start / stop the boost                       | buttons                                                                                   |

On the Smarty, the **mode is the speed**: building protection, economy and
comfort are speeds 1, 2 and 3. Stand-by (unit stopped) shows in "Current
mode" and in the status, never in the list.

The unit is read every 60 s (30 s to 1 h), in four requests over one
connection, closed after. The test button, a Discovery scan, a reconnection
of Gladys or a restart of the integration never read it sooner than the
interval. One exception: after a command that was not confirmed, the unit is
read 5 s and 20 s later to check its effect.

## Commands

Changing the mode and "Start the boost" are refused until **Allow the
commands** is on (off by default). No switch: a voice assistant's "turn
everything off" never reaches the ventilation.

- Every command reads the unit again just before writing (the mode, the unit
  state and the value to change), writes nothing when the value is already
  right, and is confirmed only when the unit returns the echo of the write
  and then reads the value asked. A command that may have reached the unit
  without being confirmed answers "sent, without confirmation": check the
  unit a few seconds later. A command the unit refuses (Modbus exception)
  answers "refused" and was not applied. A command that cannot be written
  within 3.5 s is refused and nothing is sent.
- **Unit in stand-by** (stopped): changing the mode or starting the boost
  would start it, so they are refused as soon as the mode set, the current
  mode or the state read is stand-by. Gladys neither stops nor restarts the
  unit in this version (stopping a heat recovery unit stops the air
  renewal).
- **Critical or fire alarm**: changing the mode and "Start the boost" are
  refused.
- **Stop the boost** is not subject to the option, another command, a read
  in progress, stand-by or an alarm; it cancels a command not sent yet. It
  can still answer without having stopped the boost in these cases: no valid
  address or unit id in the configuration; a value other than 1; the unit
  unreachable until 3.5 s after the press ("not sent", or "not sent yet"
  while it still tries); the unit refusing the write (Modbus exception); the
  echo or the read back missing or different ("sent, without
  confirmation"). A second press during the first joins it. When not
  confirmed, the reads of the next two minutes send it again (twice at most)
  while the boost stays on; a "Start the boost" sent afterwards wins and is
  never undone.
- The Smarty limits the boost duration itself.

## Limits

- Only the registers Salda publishes and pysmarty2 uses are read and written
  (no filter timer reset nor alarm reset in this version).
- The Smarty's Modbus map gives no serial number: the integration shows one
  unit, the one at the address entered. Changing the address keeps the
  device and its history; another unit put at the same address would show on
  the same device and receive its commands too. Reserve the address in your
  router (fixed DHCP lease).
- Temperatures are read as signed values (tenths of a degree); a value
  outside -60 to 90 °C is ignored.
- Gladys opens only one Modbus connection at a time to the unit; another
  home automation system polling it meanwhile may slow its answers.

## Privacy

Nothing leaves your network. The integration only keeps the time of its last
read in its `/data` volume.
