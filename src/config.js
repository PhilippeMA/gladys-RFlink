// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills it in Gladys, from the `config_schema` declared in
// `gladys-assistant-integration.json`. The SDK fetches it (`getConfig()`) and
// notifies every change (`onConfigUpdated()`).
//
// This module holds the defaults and normalizes the received object, so the
// rest of the code never deals with `undefined` — nor with the strings a form
// sends where a number is expected.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in
// the `config_schema` of the manifest (a test enforces it).
export const DEFAULT_CONFIG = {
  host: '', // no sensible default: the gateway address is site-specific
  port: 1234, // RFLink32 / ser2net default
  auto_discover: true,
  ignored_protocols: '',
  debug_frames: false,
};

/**
 * Merge the user configuration with the defaults.
 * @param {Record<string, unknown>} [raw] - Configuration returned by the SDK.
 * @returns {object} The normalized configuration.
 */
export function normalizeConfig(raw = {}) {
  const port = Number(raw.port ?? DEFAULT_CONFIG.port);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    host: String(raw.host ?? DEFAULT_CONFIG.host).trim(),
    // A form can send "1234"; an out-of-range or unparseable value falls back
    // to the default rather than making `net.connect` throw at runtime.
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    // Booleans arrive as booleans from the UI, but be explicit: only a real
    // `false` disables a feature that defaults to on.
    auto_discover: raw.auto_discover !== false,
    debug_frames: raw.debug_frames === true,
    ignored_protocols: String(raw.ignored_protocols ?? DEFAULT_CONFIG.ignored_protocols),
  };
}

/**
 * Whether the integration has everything it needs to connect.
 * @param {object} config - A normalized configuration.
 * @returns {boolean} True when the gateway address is set.
 */
export function isConfigured(config) {
  return config.host !== '';
}

/**
 * Parse the comma-separated ignore list into a matcher.
 *
 * A 433 MHz receiver hears every neighbour: this is how the user silences the
 * protocols that flood the Discovery screen without turning discovery off.
 * Matching is case-insensitive, since RFLink protocol names are typed by hand.
 * @param {object} config - A normalized configuration.
 * @returns {Function} `(protocol) => boolean`, true when the protocol is ignored.
 */
export function buildProtocolFilter(config) {
  const ignored = new Set(
    config.ignored_protocols
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ''),
  );
  return (protocol) => ignored.has(String(protocol ?? '').toLowerCase());
}
