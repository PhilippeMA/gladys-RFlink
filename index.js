// -----------------------------------------------------------------------------
// Entry point of the RFLink external integration.
//
// Role of this file: wire the SDK (Gladys side) to the RFLink gateway (radio
// side). It holds no protocol knowledge and no device logic — everything lives
// in `src/`:
//   - src/rflink/protocol.js    : the wire format (pure, testable);
//   - src/rflink/gateway.js     : the TCP link, framing, reconnection, pacing;
//   - src/devices/featureMap.js : RFLink measurement -> Gladys feature;
//   - src/devices/registry.js   : the devices heard on the air;
//   - src/pipeline.js           : frames -> states, commands -> radio;
//   - src/actions.js            : the buttons of the Configuration screen.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import { createActions } from './src/actions.js';
import { isConfigured, normalizeConfig } from './src/config.js';
import { DeviceRegistry } from './src/devices/registry.js';
import { createPipeline } from './src/pipeline.js';
import { RflinkGateway } from './src/rflink/gateway.js';
import { DEVICES_FILE, JsonStore } from './src/store.js';

const gladys = new GladysIntegration();

// Discovery is published in bursts: a chatty radio environment must not turn
// into one HTTP request per frame.
const PUBLISH_DEBOUNCE_MS = 3_000;

const store = new JsonStore(DEVICES_FILE);
const registry = new DeviceRegistry({ gladys, store });

let config = normalizeConfig();
let gateway = null;
let publishTimer = null;

const pipeline = createPipeline({
  gladys,
  registry,
  getConfig: () => config,
  getGateway: () => gateway,
  onDevicesChanged: schedulePublishDevices,
});

// --- Discovery ---------------------------------------------------------------

gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the known RFLink devices');
  await publishDevices();
});

/** Publish the whole registry as the discovery payload. */
async function publishDevices() {
  await gladys.publishDiscoveredDevices(registry.buildDiscoveredDevices());
}

/** Coalesce the discovery publishes triggered by incoming frames. */
function schedulePublishDevices() {
  if (publishTimer) {
    return;
  }
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishDevices().catch((err) => logger.error('publishDiscoveredDevices failed', err));
  }, PUBLISH_DEBOUNCE_MS);
  publishTimer.unref?.();
}

// --- Commands ----------------------------------------------------------------

gladys.onSetValue((device, feature, value) => pipeline.handleSetValue(device, feature, value));

// --- Manifest actions --------------------------------------------------------

const actions = createActions({ gladys, getGateway: () => gateway, registry, publishDevices });
for (const [key, handler] of Object.entries(actions)) {
  gladys.onAction(key, (fields) => handler(fields ?? {}));
}

// --- Gateway lifecycle -------------------------------------------------------

/**
 * (Re)build the link to the RFLink gateway for the current configuration.
 *
 * The gateway object is disposable: a host or port change tears the old one
 * down and builds a new one, which is far easier to reason about than mutating
 * a live socket.
 */
function startGateway() {
  stopGateway();

  if (!isConfigured(config)) {
    logger.warn('No RFLink gateway address configured yet, waiting for the configuration');
    reportStatus(false, {
      en: 'Set the address of your RFLink gateway in the configuration.',
      fr: "Renseignez l'adresse de votre passerelle RFLink dans la configuration.",
    });
    return;
  }

  gateway = new RflinkGateway({ host: config.host, port: config.port });

  gateway.on('connected', () => reportStatus(true));

  gateway.on('disconnected', () =>
    reportStatus(false, {
      en: `Lost the connection to the RFLink gateway (${config.host}:${config.port}).`,
      fr: `Connexion perdue avec la passerelle RFLink (${config.host}:${config.port}).`,
    }),
  );

  gateway.on('line', (line) => {
    // Explicitly at INFO: the whole point of the toggle is to read the raw
    // traffic from the Gladys log viewer while pairing a device, without
    // having to change LOG_LEVEL and restart the container.
    if (config.debug_frames) {
      logger.info(`RFLink <- ${line}`);
    }
  });

  gateway.on('frame', (frame) => {
    pipeline
      .handleFrame(frame)
      .catch((err) => logger.error('Failed to handle an RFLink frame', err));
  });

  gateway.start();
}

/** Tear the link down (configuration change, disconnection, shutdown). */
function stopGateway() {
  if (!gateway) {
    return;
  }
  gateway.removeAllListeners();
  gateway.stop();
  gateway = null;
}

/**
 * Report the RADIO link state in the Configuration screen.
 *
 * Distinct from the container state: the integration can be RUNNING, happily
 * connected to Gladys, and have no gateway at all on the other side.
 * @param {boolean} connected - Whether the gateway link is up.
 * @param {object} [message] - Multi-language explanation shown when it is not.
 */
function reportStatus(connected, message) {
  gladys
    .setConnectionStatus(connected, message)
    .catch((err) => logger.debug(`setConnectionStatus failed: ${err.message}`));
}

// --- Configuration -----------------------------------------------------------

gladys.onConfigUpdated(async (newConfig) => {
  const previous = config;
  config = normalizeConfig(newConfig);
  logger.info('Configuration updated');

  // Only a change of address justifies dropping a healthy link; the other
  // settings are read live, on each frame.
  if (config.host !== previous.host || config.port !== previous.port) {
    startGateway();
  }
});

// --- Connection lifecycle ----------------------------------------------------

gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());

    // Re-read the devices learned before the restart: an RF device is
    // invisible until it transmits again, so without this the Discovery
    // screen would be empty for minutes — or forever, for a remote control.
    await registry.load();
    await publishDevices();

    startGateway();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    reportStatus(false, {
      en: 'Initialization failed, check the integration logs.',
      fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
    });
  }
});

gladys.on('disconnected', () => {
  // Nothing to publish to any more: stop transmitting and stop listening.
  stopGateway();
});

// --- Graceful shutdown -------------------------------------------------------

gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopGateway();
  // Persist the devices learned in the last seconds before the volume goes.
  await store.flush();
});

// --- Startup -----------------------------------------------------------------

logger.info('Starting the RFLink integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
