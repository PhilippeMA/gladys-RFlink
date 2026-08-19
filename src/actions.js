// -----------------------------------------------------------------------------
// Handlers of the manifest `actions` — the buttons of the Configuration screen.
//
// They are the diagnostic surface of the integration: a 433 MHz link gives no
// feedback at all, so "is my gateway actually reachable?" and "did that
// command leave?" have to be answerable from the UI rather than from the logs.
//
// Each handler resolves a multi-language message displayed under its button;
// throwing displays the error message instead.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  assertSafeCommand,
  buildDeviceCommand,
  buildEchoCommand,
  FRAME_KINDS,
  GATEWAY_COMMANDS,
} from './rflink/protocol.js';
import { defaultName } from './devices/registry.js';
import { isKnownRole, pulseSecondsFor, roleKeys } from './devices/roles.js';

const logger = createLogger({ name: 'actions' });

// The gateway answers a command in milliseconds when the link is healthy; a
// longer wait means the bridge swallowed it.
const ANSWER_TIMEOUT_MS = 8_000;

// How long the identified device stays ON before being switched back OFF.
const IDENTIFY_BLINK_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Commands the declare action may replay. UP / DOWN / STOP additionally tell
// the registry the device is a cover, so a shutter is born correctly typed.
const DECLARABLE_COMMANDS = ['OFF', 'ON', 'STOP', 'UP', 'DOWN'];

/**
 * Build the action handlers.
 *
 * The gateway is passed as a GETTER, not as a value: it is recreated whenever
 * the user changes the host or the port, and a handler registered at startup
 * must act on the current one.
 * @param {object} deps - Dependencies.
 * @param {object} deps.gladys - The SDK instance.
 * @param {Function} deps.getGateway - `() => RflinkGateway | null`.
 * @param {object} deps.registry - The device registry.
 * @param {Function} deps.publishDevices - Re-publishes the discovery payload.
 * @returns {Record<string, Function>} Handlers keyed by manifest action key.
 */
export function createActions({ gladys, getGateway, registry, publishDevices }) {
  /**
   * @returns {object} The live gateway.
   * @throws {Error} When the integration has no gateway yet (host not set).
   */
  function requireGateway() {
    const gateway = getGateway();
    if (!gateway) {
      throw new Error('No RFLink gateway configured: fill in the host and the port first.');
    }
    return gateway;
  }

  return {
    /** Prove the link end to end: `10;PING;` must come back as `PONG`. */
    async test_connection() {
      const gateway = requireGateway();
      logger.info('Action test_connection -> 10;PING;');
      await gateway.request(
        GATEWAY_COMMANDS.PING,
        (frame) => frame.kind === FRAME_KINDS.PONG,
        ANSWER_TIMEOUT_MS,
      );
      return {
        en: `RFLink gateway reachable at ${gateway.host}:${gateway.port} (PING answered).`,
        fr: `Passerelle RFLink joignable sur ${gateway.host}:${gateway.port} (PING répondu).`,
      };
    },

    /** Read the firmware version — the first thing to check on a protocol bug. */
    async gateway_version() {
      const gateway = requireGateway();
      logger.info('Action gateway_version -> 10;VERSION;');
      // Firmwares answer `VER=1.1;REV=48;BUILD=07;`, but the protocol
      // reference documents the reply as free text. Accept either, and show
      // whatever the gateway actually said rather than timing out on a format.
      const frame = await gateway.request(
        GATEWAY_COMMANDS.VERSION,
        (frame) => frame.kind === FRAME_KINDS.VERSION || frame.kind === FRAME_KINDS.STATUS,
        ANSWER_TIMEOUT_MS,
      );
      if (frame.kind === FRAME_KINDS.STATUS) {
        return {
          en: `RFLink answered: ${frame.message}`,
          fr: `RFLink a répondu : ${frame.message}`,
        };
      }
      const { VER: version = '?', REV: revision = '?', BUILD: build = '?' } = frame.values;
      return {
        en: `RFLink firmware ${version}, revision ${revision}, build ${build}.`,
        fr: `Firmware RFLink ${version}, révision ${revision}, build ${build}.`,
      };
    },

    /**
     * Send a raw `10;...;` line.
     *
     * This is not a debug leftover: pairing a NewKaku receiver means
     * transmitting an address the device has never announced, so no discovered
     * device exists to act on yet. The input is validated as a single `10;`
     * command (see `assertSafeCommand`) — a line break in it would inject a
     * second command the user never reviewed.
     */
    async send_command(fields) {
      const gateway = requireGateway();
      const command = assertSafeCommand(fields.command);
      logger.info(`Action send_command -> ${command}`);
      const frame = await gateway.request(
        command,
        (frame) => frame.kind === FRAME_KINDS.ACK || frame.kind === FRAME_KINDS.ERROR,
        ANSWER_TIMEOUT_MS,
      );
      if (frame.kind === FRAME_KINDS.ERROR) {
        throw new Error(`The gateway refused "${command}" (${frame.message}).`);
      }
      return {
        en: `Command sent and acknowledged: ${command}`,
        fr: `Commande envoyée et acquittée : ${command}`,
      };
    },

    /** Make one device signal itself: ON, a short pause, then OFF. */
    async identify(fields) {
      const gateway = requireGateway();
      const target = registry.resolve(fields.device, gladys.devices ?? []);
      if (!target) {
        throw new Error('Unknown device: it is not in the RFLink registry any more.');
      }
      if (!target.labels.includes('CMD')) {
        return {
          en: `${defaultName(target)} is a sensor: it only transmits, it cannot be signalled.`,
          fr: `${defaultName(target)} est un capteur : il ne fait qu'émettre, il ne peut pas se signaler.`,
        };
      }

      logger.info(`Action identify -> ${defaultName(target)}`);
      await gateway.send(buildDeviceCommand(target, 'ON'));
      await sleep(IDENTIFY_BLINK_MS);
      await gateway.send(buildDeviceCommand(target, 'OFF'));
      return {
        en: `${defaultName(target)} switched on then off.`,
        fr: `${defaultName(target)} allumé puis éteint.`,
      };
    },

    /**
     * Declare what a switch-like device really is.
     *
     * EV1527, PT2262 and the other bare encoder chips transmit an address and
     * four bits of data — no device class. A motion detector, a door contact
     * and a wall plug therefore produce the SAME frame, and RFLink reports all
     * three as a switch. This is where the user supplies what the radio does
     * not carry.
     */
    async set_device_role(fields) {
      const role = String(fields.role ?? '');
      if (!isKnownRole(role)) {
        throw new Error(
          `Unknown device type "${role}". Expected one of: ${roleKeys().join(', ')}.`,
        );
      }

      const target = registry.resolve(fields.device, gladys.devices ?? []);
      if (!target) {
        throw new Error('Unknown device: it is not in the RFLink registry any more.');
      }
      if (!target.labels.includes('CMD')) {
        return {
          en: `${defaultName(target)} reports measurements, not an on/off signal: it has no type to change.`,
          fr: `${defaultName(target)} rapporte des mesures, pas un signal marche/arrêt : il n'y a pas de type à changer.`,
        };
      }

      const requested = Number(fields.reset_after);
      const resetAfter = Number.isFinite(requested) && requested >= 0 ? requested : null;
      const updated = registry.setRole(fields.device, role, resetAfter);
      if (!updated) {
        throw new Error('This device is not in the RFLink registry: nothing to re-type.');
      }
      logger.info(`Action set_device_role -> ${defaultName(updated)} = ${role}`);

      // Changing a category is a STRUCTURE change: Gladys will not rewrite a
      // device behind the user's back, it offers an "Update" button instead.
      // Saying so turns a confusing no-op into an expected extra click.
      await publishDevices();

      const seconds = pulseSecondsFor(updated);
      const reset = {
        en: seconds === null ? 'no automatic reset' : `resets to off after ${seconds}s`,
        fr: seconds === null ? 'pas de remise à zéro' : `remise à zéro après ${seconds} s`,
      };
      return {
        en: `${defaultName(updated)} is now a "${role}" (${reset.en}). Open the Discovery tab and press Update on this device to apply it.`,
        fr: `${defaultName(updated)} est maintenant de type « ${role} » (${reset.fr}). Ouvrez l'onglet Découverte et cliquez sur Mettre à jour pour l'appliquer.`,
      };
    },

    /**
     * Declare a device RFLink has never heard.
     *
     * The registry is built by LISTENING, which leaves one case uncovered: an
     * address the gateway only ever TRANSMITS on. That is every receiver
     * paired by hand — a Somfy RTS shutter, a NewKaku plug — and the case the
     * protocol reference calls "the original remote control is not available
     * anymore (broken/lost/etc.)".
     *
     * RFLink solves it itself with the ECHO node: it replays the payload back
     * on the link as if a remote had been pressed, so the device travels the
     * ordinary reception path and is learned like any other. No parallel
     * creation path to keep in sync with the real one.
     */
    async declare_device(fields) {
      const gateway = requireGateway();
      const protocol = String(fields.protocol ?? '').trim();
      const id = String(fields.id ?? '')
        .trim()
        .toLowerCase();
      const unit = String(fields.unit ?? '').trim();
      const command = String(fields.command ?? 'OFF')
        .trim()
        .toUpperCase();

      if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{1,19}$/.test(protocol)) {
        throw new Error(`"${protocol}" is not an RFLink protocol name (e.g. RTS, NewKaku).`);
      }
      if (!/^[0-9a-f]{1,10}$/.test(id)) {
        throw new Error(`"${fields.id}" is not a device address (1 to 10 hexadecimal digits).`);
      }
      if (unit !== '' && !/^[0-9a-zA-Z]{1,4}$/.test(unit)) {
        throw new Error(`"${unit}" is not a unit number.`);
      }
      if (!DECLARABLE_COMMANDS.includes(command)) {
        throw new Error(`Unsupported command "${command}".`);
      }

      const target = { protocol, id, unit: unit === '' ? null : unit };
      const line = assertSafeCommand(buildEchoCommand(target, command));
      logger.info(`Action declare_device -> ${line}`);

      let echoed;
      try {
        echoed = await gateway.request(
          line,
          (frame) => frame.kind === FRAME_KINDS.DEVICE && String(frame.id).toLowerCase() === id,
          ANSWER_TIMEOUT_MS,
        );
      } catch {
        throw new Error(
          'The gateway did not replay the device. The echo node needs a recent RFLink' +
            ' firmware — check it with "Read the firmware version".',
        );
      }

      // Force the learning: the user asked for this device explicitly, so the
      // automatic-discovery switch must not veto it.
      const { entry } = registry.learn(echoed, { autoDiscover: true });
      if (!entry) {
        throw new Error('The gateway replayed the device but it carried nothing usable.');
      }
      await publishDevices();

      return {
        en: `${defaultName(entry)} declared. Add it from the Discovery tab.`,
        fr: `${defaultName(entry)} déclaré. Ajoutez-le depuis l'onglet Découverte.`,
      };
    },

    /**
     * Drop every learned device the user has not created.
     *
     * The way out of a noisy neighbourhood: the receiver picked up dozens of
     * other people's sensors and the Discovery screen is unusable.
     */
    async forget_discovered_devices() {
      const created = await gladys.getDevices();
      const dropped = registry.forgetUncreated(created.map((device) => device.external_id));
      await publishDevices();
      return {
        en: `${dropped} device(s) forgotten. Your ${created.length} created device(s) are untouched.`,
        fr: `${dropped} appareil(s) oublié(s). Vos ${created.length} appareil(s) créés sont intacts.`,
      };
    },
  };
}
