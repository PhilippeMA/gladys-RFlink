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

A device you add shows its **last known reading straight away** — the
integration heard it before you added it and hands the value over, timestamped
when it was actually measured. No waiting for the next transmission.

## When RFLink cannot tell what your device is

Chips like **EV1527**, **PT2262** and **HS1527** are bare radio encoders: they
transmit an address and four bits of data, and nothing more. The same chip sits
in motion detectors, door contacts, smoke alarms, leak probes, doorbell buttons
and wall plugs — and all of them produce the exact same frame:

```
20;2D;EV1527;ID=07a410;SWITCH=01;CMD=ON;
```

No software can tell them apart, because the information is not transmitted.
RFLink reports them all as a switch, so your motion detector arrives as a
switch. Use the **Set a device type** action to say what it really is:

1. Add the device from the Discovery tab (it appears as a switch).
2. Run **Set a device type**: pick the device, then its real type — motion
   detector, door contact, smoke detector, leak probe, vibration sensor,
   doorbell, button, siren, light, or a generic read-only sensor.
3. Go back to the **Discovery** tab and press **Update** on that device.

That last step is Gladys refusing to rewrite one of your devices behind your
back: changing a type changes the device structure, so it asks you to confirm.
Your history is preserved — the feature keeps its identity through the change.

### Motion detectors: the reset delay

A PIR reports a detection but, on most cheap hardware, **never reports the end
of it**. Left alone the feature would stay "on" for ever, no further change
would happen, and no scene could ever trigger again. So a detection is
automatically reset to off after a delay, which you can set per device in the
same action:

| Type                                 | Default reset |
| ------------------------------------ | ------------- |
| Motion, presence, smoke, leak        | 60 s          |
| Vibration                            | 30 s          |
| Doorbell, button                     | 2 s           |
| Door / window contact, switch, light | never         |

A door contact is never reset: it transmits on opening **and** on closing, so
resetting it would erase a door that is genuinely still open. Enter `0` to
disable the reset and drive it yourself from a scene.

## Somfy RTS roller shutters

RTS devices are recognised on their own — a frame carrying `CMD=UP`, `CMD=DOWN`
or `CMD=STOP` can only be a cover, so no type has to be declared. Press a
button on your Somfy remote and the shutter appears in the Discovery tab with
an open / stop / close control:

```
20;1E;RTS;ID=f1e260;SWITCH=01;CMD=DOWN;
```

Add it and it already works **one way**: every press on the physical remote is
reflected in Gladys. Sending orders needs one more step.

### Why you cannot just command the address you see

RTS is a **rolling-code** protocol. Each transmission carries a counter that
the motor checks and remembers, so a receiver only obeys a remote it has been
introduced to, sending the next expected code. RFLink keeps its own counter per
address, and that counter is not the one inside your handheld remote — replaying
its address `f1e260` does not work.

The way RTS is meant to be extended is to declare **one more remote**. RFLink
becomes that extra remote, on an address of your choosing.

### Pairing RFLink with a shutter

1. Pick a free address you have not used before — six hexadecimal digits, for
   example `100001`. Use a different one per shutter (`100002`, `100003`…) and
   write them down.
2. Take the Somfy remote that already drives the shutter and hold its **PROG**
   button (on the back, ~2-3 s) until the shutter **jogs** briefly. It is now
   waiting for a new remote, for a few seconds.
3. In Gladys, run the **Send a raw command** action with:

   ```
   10;RTS;100001;0;PAIR;
   ```

4. The shutter jogs again: it has accepted RFLink as a remote.
5. Test it with `10;RTS;100001;0;DOWN;` — the shutter should close.
6. Send one more command (for example `10;RTS;100001;0;UP;`) and the new
   virtual remote appears in the **Discovery** tab. Add it, name it after the
   room, and you have full control.

Repeat per shutter. To undo a pairing, put the motor back in programming mode
with the PROG button and send `PAIR` again on the same address.

### Two devices per shutter

After pairing you have, in the Discovery tab, the address of your **physical
remote** (`f1e260`, discovered by listening) and the address **RFLink owns**
(`100001`). They are separate devices:

- the physical remote's device reports what you do by hand — useful if you want
  a scene to react to someone pressing the wall remote;
- RFLink's own address is the one that actually drives the motor.

If you only care about control, add the second one and use **Forget
undiscovered devices** to clear the first.

### RTS troubleshooting

- **The shutter never jogs on `PAIR`.** The motor was not in programming mode
  any more (the window is short — send the command within a few seconds), or
  the RFLink transmitter is out of range. RTS is 433.42 MHz, slightly off the
  usual 433.92: a standard RFLink transceiver works at short range, but a
  dedicated 433.42 MHz crystal is what gives full range.
- **It worked, then stopped.** The rolling code is out of sync. Re-pair the
  same address, or pair a fresh one.
- **Checking what RFLink stores.** `10;RTSSHOW;` lists the rolling codes it
  keeps, `10;RTSCLEAN;` wipes them — after which every paired address has to be
  paired again. Both go through **Send a raw command**.

> The `PAIR` command and the `RTSSHOW` / `RTSCLEAN` helpers come from the
> RFLink protocol reference rather than from a test on real hardware here. The
> UP / DOWN / STOP control path is exercised end to end by the test suite.

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

| Action                          | What it does                                                         |
| ------------------------------- | -------------------------------------------------------------------- |
| **Test the gateway**            | Sends `10;PING;` and waits for the `PONG`.                           |
| **Read the firmware version**   | Sends `10;VERSION;` and shows firmware, revision and build.          |
| **Set a device type**           | Declares what an EV1527-style device really is, and its reset delay. |
| **Identify a device**           | Switches the chosen device on, then off, two seconds later.          |
| **Send a raw command**          | Transmits one RFLink `10;...;` line (pairing, testing an address).   |
| **Forget undiscovered devices** | Empties the Discovery tab, keeping every device you created.         |

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

**Two readings my sensor sends never show up.** `HSTATUS` (a humidity comfort
bucket) and `BFORECAST` (a crude barometric trend) are deliberately not
exposed: both are values the sensor derives from a measurement it already
sends, on a scale no Gladys category carries. They would appear as a nameless,
iconless line next to the humidity they are computed from. Ask for them in an
issue if you have a use for them.

For more detail, set `LOG_LEVEL=debug` on the integration container: every
frame, every command and every reconnection is logged.
