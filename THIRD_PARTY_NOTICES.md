# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## pysmarty2

<https://github.com/martinssipenko/pysmarty2> (package `pysmarty2`, version
0.10.3, the library of Home Assistant's Salda Smarty integration), maintained
by martinssipenko, a fork of `pysmarty` by z0mbieprocess. MIT License; its
`LICENSE` file names the copyright holder of the original project, Teodor
Nicolau (2019). Full text below.

Ported in `src/constants.js`, `src/modbus/protocol.js` and `src/app.js`: the
Modbus TCP map of the Salda Smarty (Salda's "MCB 1.21 Modbus table") as
pysmarty2 reads and writes it, with the same protocol addresses: the read
requests (holding registers 1 to 37 and 200 to 202, coils 1 to 9, input
registers 1 to 66), holding register 1 (current system mode, values 0 to 3:
Stand-by, Building protection, Economy, Comfort, written with a single
register write), holding registers 200 and 201 (alarm, warning), coil 5
(intensive air flow, the boost, written with a single coil write), input
register 1 (current system state, 18 values) and 15 (current system mode, 5
values), input registers 18, 19 and 21 (supply, extract and outdoor air
temperatures in tenths of a degree), 30 (filters timer, days left), 55 and 56
(supply and extract fan speeds, rpm).

Changed: the temperatures are read as signed 16-bit values (pysmarty2 reads
them unsigned, so a temperature below zero would read about 6500 °C);
implausible values are unknown, never published; Stand-by (0) is never written;
the discrete inputs, the filter timer reset and the alarm reset of pysmarty2
are not used; the Modbus TCP client (MBAP framing, one connection, bounded
answers) is the integration's own, without pymodbus.

```
MIT License

Copyright (c) 2019 Teodor Nicolau

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
