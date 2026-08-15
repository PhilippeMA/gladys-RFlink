// -----------------------------------------------------------------------------
// The RFLink link: a TCP client that speaks the line protocol of `protocol.js`.
//
// WHY TCP AND NOT THE SERIAL PORT
// An external integration runs in a sandboxed container whose only declarable
// hardware accesses are `coral-usb`, `coral-pcie`, `gpu` and `video` — there is
// no way to ask for `/dev/ttyUSB0`. So the gateway is reached over the network,
// which is a first-class RFLink deployment anyway:
//   - RFLink32 on an ESP8266/ESP32 exposes its TCP server natively (port 1234);
//   - a USB RFLink is bridged with ser2net / esp-link / a USR-TCP232 module.
// `docs/en.md` walks the user through both.
//
// What this class owns:
//   - the socket lifecycle and reconnection with exponential backoff;
//   - line framing (TCP gives a byte stream, not lines);
//   - a PACED write queue: RFLink transmits on 433 MHz, and two commands sent
//     back to back are physically dropped by the receiver;
//   - a keepalive `10;PING;` plus an idle watchdog, because a dead TCP bridge
//     stays "connected" from the kernel's point of view for a very long time;
//   - `request()`, to await the answer of a command (PING -> PONG).
//
// It emits: 'connected', 'disconnected', 'frame' (parsed) and 'line' (raw).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';

import { GATEWAY_COMMANDS, LINE_TERMINATOR, parseFrame } from './protocol.js';

const defaultLogger = createLogger({ name: 'rflink-gateway' });

// A single RF transmission takes a few hundred milliseconds on the air; the
// firmware buffers very little, so we space out what we write.
const DEFAULT_SEND_INTERVAL_MS = 400;

// Beyond this the queue is certainly a runaway loop, not a burst of user
// commands: fail fast rather than transmit stale orders minutes later.
const MAX_QUEUE_LENGTH = 50;

// A line longer than this cannot be RFLink: the bridge is sending us binary
// garbage (wrong baud rate is the classic cause). Drop the buffer instead of
// growing it without bound.
const MAX_LINE_LENGTH = 4096;

export class RflinkGateway extends EventEmitter {
  /**
   * @param {object} options - Gateway options.
   * @param {string} options.host - Host or IP of the RFLink TCP bridge.
   * @param {number} options.port - TCP port of the bridge.
   * @param {object} [options.logger] - Logger, defaults to the SDK named logger.
   * @param {number} [options.sendIntervalMs] - Minimum delay between two writes.
   * @param {number} [options.keepAliveMs] - Delay between two `10;PING;`.
   * @param {number} [options.idleTimeoutMs] - Silence after which the link is considered dead.
   * @param {number} [options.connectTimeoutMs] - TCP connection timeout.
   * @param {number} [options.reconnectBaseDelayMs] - First reconnection delay.
   * @param {number} [options.reconnectMaxDelayMs] - Reconnection delay ceiling.
   */
  constructor({
    host,
    port,
    logger = defaultLogger,
    sendIntervalMs = DEFAULT_SEND_INTERVAL_MS,
    keepAliveMs = 60_000,
    idleTimeoutMs = 180_000,
    connectTimeoutMs = 10_000,
    reconnectBaseDelayMs = 1_000,
    reconnectMaxDelayMs = 60_000,
  }) {
    super();
    this.host = host;
    this.port = port;
    this.logger = logger;
    this.sendIntervalMs = sendIntervalMs;
    this.keepAliveMs = keepAliveMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.reconnectBaseDelayMs = reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;

    this.connected = false;
    this.socket = null;
    this.buffer = '';
    this.queue = [];
    this.attempt = 0;
    this.stopped = true;
    this.lastSentAt = 0;
    this.timers = { reconnect: null, keepAlive: null, idle: null, drain: null };
  }

  /** Open the link and keep it open (reconnects for life until `stop()`). */
  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.attempt = 0;
    this.#openSocket();
  }

  /** Close the link for good and drop everything still queued. */
  stop() {
    this.stopped = true;
    this.#clearTimer('reconnect');
    this.#clearTimer('keepAlive');
    this.#clearTimer('idle');
    this.#clearTimer('drain');
    this.#failQueue(new Error('RFLink gateway stopped'));
    this.#destroySocket();
    this.connected = false;
  }

  /**
   * Queue a command line. It resolves once the bytes are handed to the socket
   * — RFLink acknowledges with `20;xx;OK;`, use `request()` when you need it.
   * @param {string} line - Command line, without its terminator.
   * @returns {Promise<void>} Resolves once written.
   */
  send(line) {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new Error('RFLink gateway is stopped'));
        return;
      }
      if (this.queue.length >= MAX_QUEUE_LENGTH) {
        reject(new Error('RFLink command queue is full'));
        return;
      }
      this.queue.push({ line, resolve, reject });
      this.#drainQueue();
    });
  }

  /**
   * Send a command and wait for the first frame that matches.
   *
   * The RFLink protocol has no correlation id: the answer to `10;PING;` is
   * simply the next `PONG` on the link. So the caller describes what it
   * expects and we resolve on the first match.
   * @param {string} line - Command line to send.
   * @param {Function} matcher - `(frame) => boolean`, true on the awaited answer.
   * @param {number} [timeoutMs] - How long to wait for it.
   * @returns {Promise<object>} The matching frame.
   */
  request(line, matcher, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('frame', onFrame);
        reject(new Error(`No answer from the RFLink gateway after ${timeoutMs} ms`));
      }, timeoutMs);

      const onFrame = (frame) => {
        if (!matcher(frame)) {
          return;
        }
        clearTimeout(timer);
        this.off('frame', onFrame);
        resolve(frame);
      };

      // Listen BEFORE sending: the gateway can answer faster than the
      // microtask that follows `send()`.
      this.on('frame', onFrame);
      this.send(line).catch((err) => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        reject(err);
      });
    });
  }

  // --- Socket lifecycle ------------------------------------------------------

  #openSocket() {
    this.logger.info(`Connecting to the RFLink gateway ${this.host}:${this.port}...`);
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    socket.setTimeout(this.connectTimeoutMs);

    socket.once('connect', () => {
      // `setTimeout` guarded the CONNECT phase; the idle watchdog takes over.
      socket.setTimeout(0);
      this.connected = true;
      this.attempt = 0;
      this.buffer = '';
      this.logger.info(`Connected to the RFLink gateway ${this.host}:${this.port}`);
      this.#armIdleWatchdog();
      this.#armKeepAlive();
      this.emit('connected');
      this.#drainQueue();
    });

    socket.on('timeout', () => {
      // Only the connect phase arms a socket timeout (see above).
      this.logger.warn('Timed out while connecting to the RFLink gateway');
      socket.destroy(new Error('Connection timeout'));
    });

    socket.on('data', (chunk) => {
      this.#armIdleWatchdog();
      this.#consume(chunk);
    });

    socket.on('error', (err) => {
      this.logger.warn(`RFLink gateway link error: ${err.message}`);
    });

    socket.once('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.socket === socket) {
        this.socket = null;
      }
      this.#clearTimer('keepAlive');
      this.#clearTimer('idle');
      if (wasConnected) {
        this.emit('disconnected');
      }
      this.#scheduleReconnect();
    });
  }

  #destroySocket() {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = null;
    socket.removeAllListeners('close');
    socket.destroy();
  }

  #scheduleReconnect() {
    if (this.stopped || this.timers.reconnect) {
      return;
    }
    // Same backoff shape as the SDK uses towards Gladys: min(base * 2^n, max).
    const delay = Math.min(this.reconnectBaseDelayMs * 2 ** this.attempt, this.reconnectMaxDelayMs);
    this.attempt += 1;
    this.logger.warn(`RFLink gateway unreachable, retrying in ${Math.round(delay / 1000)}s`);
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = null;
      if (!this.stopped) {
        this.#openSocket();
      }
    }, delay);
    this.timers.reconnect.unref?.();
  }

  // --- Reading ---------------------------------------------------------------

  #consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_LENGTH && !this.buffer.includes('\n')) {
      this.logger.warn('Dropping an oversized RFLink line (wrong baud rate on the bridge?)');
      this.buffer = '';
      return;
    }

    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.#handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  #handleLine(line) {
    if (line.trim() === '') {
      return;
    }
    this.emit('line', line);
    const frame = parseFrame(line);
    if (frame === null) {
      this.logger.debug(`Ignored non-RFLink line: ${line}`);
      return;
    }
    this.emit('frame', frame);
  }

  // --- Writing ---------------------------------------------------------------

  #drainQueue() {
    if (this.timers.drain || this.queue.length === 0) {
      return;
    }
    if (!this.connected || !this.socket) {
      // Nothing to do: the 'connect' handler drains the queue again.
      return;
    }

    const elapsed = Date.now() - this.lastSentAt;
    if (elapsed < this.sendIntervalMs) {
      this.timers.drain = setTimeout(() => {
        this.timers.drain = null;
        this.#drainQueue();
      }, this.sendIntervalMs - elapsed);
      this.timers.drain.unref?.();
      return;
    }

    const { line, resolve, reject } = this.queue.shift();
    this.lastSentAt = Date.now();
    this.logger.debug(`-> ${line}`);
    try {
      this.socket.write(`${line}${LINE_TERMINATOR}`, (err) => (err ? reject(err) : resolve()));
    } catch (err) {
      reject(err);
    }

    if (this.queue.length > 0) {
      this.timers.drain = setTimeout(() => {
        this.timers.drain = null;
        this.#drainQueue();
      }, this.sendIntervalMs);
      this.timers.drain.unref?.();
    }
  }

  #failQueue(error) {
    const pending = this.queue;
    this.queue = [];
    for (const { reject } of pending) {
      reject(error);
    }
  }

  // --- Health ----------------------------------------------------------------

  #armKeepAlive() {
    this.#clearTimer('keepAlive');
    this.timers.keepAlive = setInterval(() => {
      this.send(GATEWAY_COMMANDS.PING).catch((err) =>
        this.logger.debug(`Keepalive ping failed: ${err.message}`),
      );
    }, this.keepAliveMs);
    this.timers.keepAlive.unref?.();
  }

  // A serial-to-TCP bridge that lost its USB device keeps the TCP session
  // open and simply goes silent. Since we ping regularly, prolonged silence
  // means the link is dead even though the socket says otherwise.
  #armIdleWatchdog() {
    this.#clearTimer('idle');
    this.timers.idle = setTimeout(() => {
      this.logger.warn(
        `No data from the RFLink gateway for ${Math.round(this.idleTimeoutMs / 1000)}s, reconnecting`,
      );
      this.socket?.destroy();
    }, this.idleTimeoutMs);
    this.timers.idle.unref?.();
  }

  #clearTimer(name) {
    if (!this.timers[name]) {
      return;
    }
    clearTimeout(this.timers[name]);
    clearInterval(this.timers[name]);
    this.timers[name] = null;
  }
}
