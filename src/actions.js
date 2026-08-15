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
  FRAME_KINDS,
  GATEWAY_COMMANDS,
} from './rflink/protocol.js';
import { defaultName } from './devices/registry.js';

const logger = createLogger({ name: 'actions' });

// The gateway answers a command in milliseconds when the link is healthy; a
// longer wait means the bridge swallowed it.
const ANSWER_TIMEOUT_MS = 8_000;

// How long the identified device stays ON before being switched back OFF.
const IDENTIFY_BLINK_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const frame = await gateway.request(
        GATEWAY_COMMANDS.VERSION,
        (frame) => frame.kind === FRAME_KINDS.VERSION,
        ANSWER_TIMEOUT_MS,
      );
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
