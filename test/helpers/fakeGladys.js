// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the integration modules rely on:
//   - externalIds(type, platformId)  -> { device, feature(key) }
//   - publishState / publishStates   -> recorded so tests can assert them
//   - publishDiscoveredDevices       -> recorded so tests can assert them
//   - setConnectionStatus            -> recorded so tests can assert them
//   - devices / getDevices()         -> the devices "created by the user"
//
// This lets us test the registry, the protocol and the feature mapping without
// a running Gladys server, a WebSocket, or an RFLink gateway.
// -----------------------------------------------------------------------------

/**
 * @param {object[]} [createdDevices] - Devices the user has created in Gladys.
 * @returns {object} The fake SDK instance.
 */
export function createFakeGladys(createdDevices = []) {
  const published = [];
  const discovered = [];
  const connectionStatuses = [];

  return {
    published,
    discovered,
    connectionStatuses,
    devices: createdDevices,

    externalIds(type, platformId) {
      const device = `ext:rflink:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
        });
      }
    },

    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
    },

    async getDevices() {
      return this.devices;
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}

/**
 * An in-memory JsonStore: same surface, no disk. Keeps the registry tests
 * fast and free of temporary directories.
 * @param {*} [initial] - Value the store starts with.
 * @returns {object} The fake store.
 */
export function createFakeStore(initial = null) {
  return {
    value: initial,
    writes: 0,
    async read(fallback = null) {
      return this.value ?? fallback;
    },
    async write(value) {
      this.value = value;
      this.writes += 1;
      return true;
    },
    scheduleWrite(value) {
      this.value = value;
      this.writes += 1;
    },
    async flush() {},
  };
}
