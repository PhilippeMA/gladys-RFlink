# Gladys RFLink integration

External integration bringing **433 MHz / 868 MHz devices** into
[Gladys Assistant](https://gladysassistant.com) through an
[RFLink](https://www.rflink.nl/) gateway, built on the official JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and the [official integration template](https://github.com/GladysAssistant/integration-template-js).

Wall plugs, dimmers, remotes, weather stations, motion and smoke detectors,
energy meters and doorbells — whatever RFLink decodes becomes a Gladys device
with the right category, type and unit.

User documentation: [`docs/en.md`](docs/en.md) · [`docs/fr.md`](docs/fr.md).

## How it works

RFLink is a **listening** integration, not an enumerable one: a 433 MHz device
is invisible until it transmits. The integration therefore builds its device
list from the air, and remembers it across restarts.

```
RF device ──433MHz──▶ RFLink gateway ──TCP──▶ gateway.js ──▶ protocol.js
                                                                  │
                                                            featureMap.js
                                                                  │
                                                             registry.js
                                                                  │
                                          Gladys ◀── index.js ────┘
```

| File                        | Responsibility                                                            |
| --------------------------- | ------------------------------------------------------------------------- |
| `index.js`                  | SDK wiring only: handlers, gateway lifecycle, configuration               |
| `src/rflink/protocol.js`    | The wire format: parse a line, build a command. Pure, no I/O              |
| `src/rflink/gateway.js`     | The TCP link: framing, reconnection, paced writes, keepalive, `request()` |
| `src/devices/featureMap.js` | RFLink measurement → Gladys category / type / unit / decoder              |
| `src/devices/registry.js`   | The devices heard on the air: identity, features, discovery payload       |
| `src/devices/roles.js`      | What a switch-like frame actually is, when the chip does not say          |
| `src/pipeline.js`           | Frames → published states, Gladys commands → RFLink command lines         |
| `src/store.js`              | Persistence of the learned devices in `/data`                             |
| `src/actions.js`            | The buttons of the Configuration screen                                   |
| `src/config.js`             | Defaults, normalization, protocol ignore list                             |

`index.js` self-executes (it connects to Gladys on import), so it holds no
logic of its own: everything worth testing lives in `src/`.

### Why TCP and not the serial port

A Gladys external integration runs in a sandboxed container, and the only
hardware a manifest can request is `coral-usb`, `coral-pcie`, `gpu` or `video`
— there is no way to ask for `/dev/ttyUSB0`. The gateway is therefore reached
over the network, which covers both real-world setups: an RFLink32 board on
ESP8266/ESP32 (native TCP server) and a USB RFLink bridged with `ser2net`.
`docs/en.md` has the step by step.

### Design decisions worth knowing

- **The unit is part of the identity.** The four buttons of a remote share one
  `ID=` and differ by their `SWITCH=`, so each becomes its own Gladys device.
- **`has_feedback: false` everywhere.** 433 MHz is one-way and unacknowledged:
  claiming a confirmation we cannot provide would leave Gladys waiting.
- **Writes are paced.** Two RF commands sent back to back are physically
  dropped by the receiver, so the gateway queue spaces them out.
- **The registry is persisted.** Without it, a restart would empty the
  Discovery screen until each device happens to transmit again — which, for a
  remote nobody presses, is never.
- **Devices are recoverable without the cache.** The RF address is also stored
  as device params, so a wiped `/data` volume does not break your commands.
- **Discovery has a ceiling and an ignore list.** A 433 MHz receiver hears the
  whole neighbourhood.
- **Ambiguous chips are typed by the user, never guessed.** EV1527 and PT2262
  carry an address and four bits — a PIR, a door contact and a wall plug send
  the identical frame. A device role (`roles.js`) overrides the category, keeps
  the feature key so the history survives, and brings the automatic reset a
  detector needs: a PIR that never sends OFF would otherwise stay "on" for
  ever, and no scene could trigger again.
- **A newly added device is never blank.** The last reading heard before the
  user added it is replayed on `onDeviceCreated`, timestamped when it was
  measured — except for pulsed sensors, where a past detection is an event, not
  a state to restore.

## Adding support for a new measurement

Add one entry to `RFLINK_FIELDS` in
[`src/devices/featureMap.js`](src/devices/featureMap.js) — the Gladys
category/type/unit and a decoder — and nothing else changes. Watch the radix:
the RFLink protocol reference documents some fields as hexadecimal and the
others as decimal, and getting it backwards produces a temperature of 180
instead of 18.0.

## Development

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="rflink" \
RFLINK_DATA_DIR="./data" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its container; `RFLINK_DATA_DIR` overrides the `/data`
volume so it can run outside Docker.

## Quality checks

The same three gates run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # Unit tests, via the built-in `node --test` runner
```

The suite covers the protocol (framing, radix, signed temperatures, command
injection), the feature mapping, the registry (identity, growth, persistence,
recovery), the store, the full pipeline in both directions (a raw RFLink line
in, published states out; a Gladys command in, an RFLink line out), and the
gateway itself — the last one against a real local TCP server, so chunk
reassembly, reconnection and write pacing are actually exercised.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the exact checks of the store indexer — manifest schema, Docker image
availability, cover image, documentation — and reports every problem at once.

## Release

**Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. The
workflow bumps the version in `package.json` and in the manifest (`version` and
`docker_image`), pushes the `vX.Y.Z` tag and builds the `linux/amd64` +
`linux/arm64` image to `ghcr.io`. The decentralized indexer then offers the
update in every Gladys.

## License

Apache-2.0
