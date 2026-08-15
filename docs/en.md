# RFLink

This integration connects Gladys to an [RFLink](https://www.rflink.nl/) gateway
and turns the 433 MHz / 868 MHz traffic it hears into Gladys devices: wall
plugs, dimmers, weather stations, motion and smoke detectors, energy meters,
doorbells.

## Before you start: RFLink must be reachable over TCP

Gladys runs each external integration in a sandboxed container that has **no
access to serial ports** — the only hardware a manifest can request is a Coral
accelerator, a GPU or a video device. So the integration reaches the gateway
over the network. There are two supported setups.

### A. RFLink32 on ESP8266 / ESP32 (nothing else to install)

[RFLink32](https://github.com/cpainchaud/RFLink32) exposes a TCP server
natively. Flash your board, connect it to your Wi-Fi, and note the IP address
it takes; the default port is **1234**.

### B. A USB RFLink plugged into a computer (Arduino Mega + transceiver)

Bridge the serial port to TCP with `ser2net`, on the machine the RFLink is
plugged into (it can be the Gladys host):

```bash
sudo apt install ser2net
```

Add this to `/etc/ser2net.yaml`, adjusting the device path:

```yaml
connection: &rflink
  accepter: tcp,1234
  connector: serialdev,/dev/ttyUSB0,57600n81,local
  options:
    kickolduser: true
```

Then `sudo systemctl restart ser2net`. **57600 baud is the RFLink rate** — the
classic symptom of a wrong rate is a log full of unreadable characters.

`esp-link` and a USR-TCP232 style serial-to-Ethernet module work the same way.

Check the bridge from any machine on the LAN before configuring Gladys:

```bash
printf '10;PING;\r\n' | nc 192.168.1.42 1234
# -> 20;01;PONG;
```

## Configuration

1. Open the **Configuration** tab of the integration.
2. Fill in the **gateway address** (its IP or hostname) and the **TCP port**
   (1234 unless you changed it).
3. Save, then press **Test the gateway**: it sends `10;PING;` and waits for the
   `PONG`. If that button answers, everything downstream will work.
4. **Read the firmware version** shows your RFLink firmware, revision and
   build — the first thing to check when a device is decoded oddly.

## Adding your devices

A 433 MHz device is invisible until it transmits: there is no list to fetch,
the integration builds one by **listening**.

- **A remote, a switch, a doorbell**: press one of its buttons. Each button is
  a separate device in Gladys (RFLink reports it as a distinct `SWITCH=` unit).
- **A sensor** (temperature, weather station...): wait for its next
  transmission — every 30 to 60 seconds for most, up to a few minutes.

The device then appears in the **Discovery** tab, named after what the gateway
reported (for example `NewKaku 000005 (unit 2)`). Add it, rename it, and it
starts recording its history. You can rename it freely: Gladys tracks it by its
radio address, not by its name.

Your receiver also hears your **neighbours**. Two settings keep that under
control:

- **Automatic discovery** — turn it off once your own devices are added. Known
  devices keep working; only the learning of new ones stops.
- **Ignored protocols** — a comma-separated list of RFLink protocol names to
  drop entirely, for the ones that flood your receiver
  (`Oregon TempHygro, Cresta`).

The **Forget undiscovered devices** action empties the Discovery tab of
everything you have not created, so you can start the learning over in a clean
state. Devices you already added are never touched.

## Controlling a device

Any device RFLink reports with a command (`CMD=ON` / `CMD=OFF`) gets an on/off
control in Gladys, and one that reports a dim level also gets a brightness
slider.

433 MHz is a **one-way** medium: the gateway transmits and no device answers.
Gladys therefore records the state you asked for, and the physical device may
be out of sync if it was out of range or if another remote acted on it. This is
a property of the radio protocol, not a limitation of the integration.

### Pairing a receiver (NewKaku and friends)

A receiver has to _learn_ the address it should obey, and that address has
never been transmitted, so no discovered device exists yet. Use the **Send a
raw command** action:

1. Put the receiver in pairing mode (usually by holding its button until it
   blinks).
2. Send a command on a free address, for example
   `10;NewKaku;00c142;1;ON;`.
3. The receiver memorizes it. Send the same command again and it appears in
   the Discovery tab like any other device.

The action accepts a single RFLink line starting with `10;`, and rejects
anything else.

## Actions

| Action                          | What it does                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| **Test the gateway**            | Sends `10;PING;` and waits for the `PONG`.                         |
| **Read the firmware version**   | Sends `10;VERSION;` and shows firmware, revision and build.        |
| **Identify a device**           | Switches the chosen device on, then off, two seconds later.        |
| **Send a raw command**          | Transmits one RFLink `10;...;` line (pairing, testing an address). |
| **Forget undiscovered devices** | Empties the Discovery tab, keeping every device you created.       |

## Troubleshooting

**The "Test the gateway" button times out.** The bridge is not reachable.
Check the address and the port with the `nc` command above, and make sure the
bridge listens on the LAN interface and not only on `127.0.0.1`.

**The connection status keeps flapping.** Something else is already connected
to the bridge — RFLink accepts one client at a time. Stop the other consumer
(Domoticz, a `screen` session, a second Gladys), or enable `kickolduser` in
`ser2net`.

**Nothing appears in the Discovery tab.** Turn on **Log raw frames** in the
configuration and watch the integration logs: you should see one `RFLink <-`
line per transmission. No line at all means the gateway hears nothing (antenna,
distance, wrong band). Lines full of garbage characters mean a wrong baud rate
on the bridge.

**A sensor changed identity by itself.** Many 433 MHz sensors draw a new random
`ID` when their batteries are replaced. The old device stops updating and a new
one appears in Discovery; that is the sensor's behaviour, and every 433 MHz
controller sees it the same way.

**A temperature looks absurd.** Report it with the raw frame (from the logs)
in an issue: decoding is per-field, and an unusual protocol may need its own
handling.

For more detail, set `LOG_LEVEL=debug` on the integration container: every
frame, every command and every reconnection is logged.
