// -----------------------------------------------------------------------------
// RFLink wire protocol: parsing incoming lines, building outgoing commands.
//
// This module is PURE (no I/O, no SDK): give it a line, it gives you a frame.
// That is what makes the protocol testable without a gateway.
//
// The RFLink Gateway speaks a line protocol, `\r\n` terminated:
//
//   Incoming (gateway -> us), always prefixed `20;`:
//     20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;
//     20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;BAT=OK;
//     20;06;OK;                                  <- command accepted
//     20;07;PONG;                                <- answer to 10;PING;
//     20;08;VER=1.1;REV=48;BUILD=07;             <- answer to 10;VERSION;
//     20;00;Nodo RadioFrequencyLink - RFLink Gateway V1.1 - R48;   <- boot banner
//     20;09;CMD UNKNOWN;                         <- command refused
//
//   Outgoing (us -> gateway), always prefixed `10;`:
//     10;NewKaku;000005;2;ON;      <- act on an RF device
//     10;NewKaku;00c142;1;12;      <- dim level (0-15) as the command
//     10;PING;                     <- gateway keepalive
//     10;VERSION;                  <- gateway firmware version
//
// The second field of an incoming line is a rolling hexadecimal counter kept
// by the gateway; it identifies the message, not the device, so we only keep
// it for logs.
// -----------------------------------------------------------------------------

/** Line terminator expected by the RFLink firmware. */
export const LINE_TERMINATOR = '\r\n';

/** Prefix of every line sent BY the gateway. */
export const INBOUND_PREFIX = '20';

/** Prefix of every line sent TO the gateway. */
export const OUTBOUND_PREFIX = '10';

/** Ready-made gateway commands (they address the gateway, not an RF device). */
export const GATEWAY_COMMANDS = {
  PING: '10;PING;',
  VERSION: '10;VERSION;',
  REBOOT: '10;REBOOT;',
};

// A command line longer than this is certainly a mistake (the firmware input
// buffer is small); refusing it early gives a clear error instead of a
// silently truncated RF transmission.
const MAX_COMMAND_LENGTH = 128;

/**
 * Frame kinds produced by `parseFrame`.
 * - `device`  : an RF device was heard (the only kind carrying `ID=`);
 * - `ack`     : the gateway accepted the last command (`OK`);
 * - `error`   : the gateway refused it (`CMD UNKNOWN`);
 * - `pong`    : answer to `10;PING;`;
 * - `version` : answer to `10;VERSION;`;
 * - `banner`  : the boot banner, sent once on connection/reset;
 * - `status`  : anything else the gateway says (debug, settings dumps...).
 */
export const FRAME_KINDS = {
  DEVICE: 'device',
  ACK: 'ack',
  ERROR: 'error',
  PONG: 'pong',
  VERSION: 'version',
  BANNER: 'banner',
  STATUS: 'status',
};

/**
 * Parse one line coming from the gateway.
 *
 * Returns `null` for anything that is not an inbound RFLink line (an empty
 * line, the echo of a command we sent, garbage on the serial bridge): the
 * caller can then ignore it without a special case.
 * @param {string} rawLine - One line, without its terminator.
 * @returns {object|null} The parsed frame, or null when the line is not one.
 */
export function parseFrame(rawLine) {
  const line = String(rawLine ?? '').trim();
  if (line === '') {
    return null;
  }

  const fields = line.split(';');
  // Well-formed lines end with ';', which yields a trailing empty field.
  if (fields[fields.length - 1] === '') {
    fields.pop();
  }
  // `20` + counter + at least one payload field.
  if (fields.length < 3 || fields[0] !== INBOUND_PREFIX) {
    return null;
  }

  const [, counter, ...payload] = fields;
  const base = { kind: FRAME_KINDS.STATUS, counter, raw: line };

  // Split the payload into `KEY=VALUE` pairs and bare words: RFLink mixes
  // both in the same line (`20;2D;NewKaku;ID=000005;CMD=ON;`).
  const values = {};
  const words = [];
  for (const field of payload) {
    const separator = field.indexOf('=');
    if (separator > 0) {
      values[field.slice(0, separator).trim().toUpperCase()] = field.slice(separator + 1).trim();
    } else {
      words.push(field.trim());
    }
  }

  const firstWord = (words[0] ?? '').toUpperCase();
  if (firstWord === 'OK') {
    return { ...base, kind: FRAME_KINDS.ACK };
  }
  if (firstWord === 'PONG') {
    return { ...base, kind: FRAME_KINDS.PONG };
  }
  if (firstWord.startsWith('CMD UNKNOWN')) {
    return { ...base, kind: FRAME_KINDS.ERROR, message: words.join(';') };
  }
  if (values.VER !== undefined || values.REV !== undefined) {
    return { ...base, kind: FRAME_KINDS.VERSION, values };
  }
  // The boot banner is the only line whose counter is `00` and whose payload
  // is free text (`Nodo RadioFrequencyLink - RFLink Gateway V1.1 - R48`).
  if (counter === '00' && values.ID === undefined) {
    return { ...base, kind: FRAME_KINDS.BANNER, message: payload.join(';') };
  }

  // From here on, only an `ID=` field makes a frame a device report. Without
  // it we are looking at a settings dump or a debug line: keep it as status
  // so `debug_frames` can show it, but never turn it into a device.
  if (values.ID === undefined || words.length === 0) {
    return { ...base, message: payload.join(';'), values };
  }

  const { ID: id, SWITCH: unit, ...measures } = values;
  return {
    ...base,
    kind: FRAME_KINDS.DEVICE,
    protocol: words[0],
    id,
    // `SWITCH=` is the button/unit inside a multi-button remote or address
    // block. Sensors do not carry one.
    unit: unit ?? null,
    values: measures,
  };
}

/**
 * Build the command line that acts on one RF device.
 * @param {object} target - The device to address.
 * @param {string} target.protocol - RFLink protocol name, e.g. 'NewKaku'.
 * @param {string} target.id - Device id as reported by the gateway.
 * @param {string|null} target.unit - Button/unit id, or null when there is none.
 * @param {string|number} command - 'ON', 'OFF', 'ALLON', 'ALLOFF' or a dim level (0-15).
 * @returns {string} The command line, without its terminator.
 */
export function buildDeviceCommand({ protocol, id, unit }, command) {
  // RFLink always expects the 4 positional fields; devices without a unit take
  // `0`, which the firmware accepts as "no sub-address".
  return `${OUTBOUND_PREFIX};${protocol};${id};${unit ?? '0'};${command};`;
}

/**
 * Check that a line can safely be written on the gateway link.
 *
 * The `send_command` action lets the user type a raw command (that is how you
 * pair a NewKaku receiver), so the input needs the same care as any other
 * user input: a `\n` inside it would inject a SECOND command the user never
 * reviewed.
 * @param {string} line - Candidate command line.
 * @returns {string} The trimmed line, guaranteed to be a single command.
 * @throws {Error} When the line is empty, too long, multi-line or not a `10;` command.
 */
export function assertSafeCommand(line) {
  const command = String(line ?? '').trim();
  if (command === '') {
    throw new Error('Empty command');
  }
  if (/[\r\n]/.test(command)) {
    throw new Error('A command must be a single line');
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`A command must be at most ${MAX_COMMAND_LENGTH} characters`);
  }
  if (!command.startsWith(`${OUTBOUND_PREFIX};`)) {
    throw new Error('An RFLink command must start with "10;"');
  }
  return command;
}

/**
 * Read an RFLink hexadecimal measurement.
 * @param {string} raw - Raw field value, e.g. '00b4'.
 * @returns {number|null} The value, or null when it is not hexadecimal.
 */
export function parseHex(raw) {
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]+$/.test(raw.trim())) {
    return null;
  }
  return parseInt(raw.trim(), 16);
}

/**
 * Read an RFLink decimal measurement.
 * @param {string} raw - Raw field value, e.g. '44'.
 * @returns {number|null} The value, or null when it is not a decimal number.
 */
export function parseDecimal(raw) {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
    return null;
  }
  return parseInt(raw.trim(), 10);
}

/**
 * Read a signed RFLink temperature: 4 hexadecimal digits in tenths of a
 * degree, whose HIGH BIT (0x8000) carries the sign instead of two's
 * complement — `80b4` is -18.0 degrees, not a huge positive number.
 * @param {string} raw - Raw field value, e.g. '00b4' or '80b4'.
 * @returns {number|null} Degrees, or null when the field is not hexadecimal.
 */
export function parseSignedTemperature(raw) {
  const value = parseHex(raw);
  if (value === null) {
    return null;
  }
  const negative = (value & 0x8000) !== 0;
  const magnitude = (value & 0x7fff) / 10;
  // Round to one decimal: the division above can produce 21.700000000000003.
  return Number((negative ? -magnitude : magnitude).toFixed(1));
}
