// -----------------------------------------------------------------------------
// The gateway is tested against a REAL TCP server on localhost: it is the only
// way to exercise the parts that actually break in production — chunk
// reassembly, reconnection, write pacing — and `node:net` makes it cheap.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';

import { RflinkGateway } from '../src/rflink/gateway.js';
import { FRAME_KINDS } from '../src/rflink/protocol.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Start a fake RFLink bridge and run `body` against it.
 * @param {Function} body - `({ port, sockets, received, server }) => Promise<void>`.
 * @param {Function} [onConnection] - Called with each accepted socket.
 */
async function withServer(body, onConnection) {
  const sockets = [];
  const received = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => received.push(chunk));
    socket.on('error', () => {});
    onConnection?.(socket);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await body({ port: server.address().port, sockets, received, server });
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  }
}

/**
 * Poll until a condition holds. `send()` resolves when the bytes reach the OS,
 * which is not when the peer has processed them — so assertions on what the
 * fake bridge received have to wait for it.
 * @param {Function} predicate - `() => boolean`.
 * @param {number} [timeoutMs] - How long to keep polling.
 */
async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Condition was never met');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * @param {string[]} received - Chunks collected by the fake bridge.
 * @returns {string[]} The complete lines it received.
 */
function lines(received) {
  return received.join('').split('\r\n').filter(Boolean);
}

/**
 * @param {number} port - Port of the fake bridge.
 * @param {object} [options] - Extra gateway options.
 * @returns {RflinkGateway} A gateway wired to the fake bridge.
 */
function createGateway(port, options = {}) {
  return new RflinkGateway({
    host: '127.0.0.1',
    port,
    logger: silent,
    sendIntervalMs: 20,
    keepAliveMs: 60_000,
    idleTimeoutMs: 60_000,
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 40,
    ...options,
  });
}

test('connects and turns the incoming lines into frames', async () => {
  await withServer(async ({ port, sockets }) => {
    const gateway = createGateway(port);
    const frames = [];
    gateway.on('frame', (frame) => frames.push(frame));

    gateway.start();
    await once(gateway, 'connected');

    sockets[0].write('20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;\r\n');
    await once(gateway, 'frame');

    assert.equal(frames.length, 1);
    assert.equal(frames[0].kind, FRAME_KINDS.DEVICE);
    assert.equal(frames[0].protocol, 'NewKaku');
    gateway.stop();
  });
});

test('reassembles a line split across TCP chunks, and splits a merged one', async () => {
  await withServer(async ({ port, sockets }) => {
    const gateway = createGateway(port);
    const frames = [];
    gateway.on('frame', (frame) => frames.push(frame));

    gateway.start();
    await once(gateway, 'connected');

    // TCP is a byte stream: nothing guarantees one write is one line.
    sockets[0].write('20;01;Kaku;ID=00');
    sockets[0].write('0041;SWITCH=1;CMD=ON;\r\n20;02;Kaku;ID=000041;SWITCH=1;CMD=OFF;\r\n');

    while (frames.length < 2) {
      await once(gateway, 'frame');
    }
    assert.deepEqual(
      frames.map((frame) => frame.values.CMD),
      ['ON', 'OFF'],
    );
    gateway.stop();
  });
});

test('request sends a command and resolves on the matching answer', async () => {
  // The fake bridge answers PING like a real RFLink does.
  await withServer(
    async ({ port, received }) => {
      const gateway = createGateway(port);
      gateway.start();
      await once(gateway, 'connected');

      const frame = await gateway.request(
        '10;PING;',
        (frame) => frame.kind === FRAME_KINDS.PONG,
        2_000,
      );

      assert.equal(frame.kind, FRAME_KINDS.PONG);
      assert.deepEqual(lines(received), ['10;PING;']);
      gateway.stop();
    },
    (socket) => {
      socket.on('data', (chunk) => {
        if (chunk.includes('PING')) {
          socket.write('20;07;PONG;\r\n');
        }
      });
    },
  );
});

test('request rejects when the gateway stays silent', async () => {
  await withServer(async ({ port }) => {
    const gateway = createGateway(port);
    gateway.start();
    await once(gateway, 'connected');

    await assert.rejects(
      gateway.request('10;PING;', (frame) => frame.kind === FRAME_KINDS.PONG, 100),
      /No answer from the RFLink gateway/,
    );
    gateway.stop();
  });
});

test('paces the writes: RF transmissions sent back to back are lost', async () => {
  await withServer(async ({ port, received }) => {
    const gateway = createGateway(port, { sendIntervalMs: 60 });
    gateway.start();
    await once(gateway, 'connected');

    const startedAt = Date.now();
    await Promise.all([
      gateway.send('10;Kaku;000041;1;ON;'),
      gateway.send('10;Kaku;000041;2;ON;'),
      gateway.send('10;Kaku;000041;3;ON;'),
    ]);

    // Three writes means at least two gaps of one interval.
    assert.ok(Date.now() - startedAt >= 100, 'the writes were not spaced out');
    await waitFor(() => lines(received).length === 3);
    gateway.stop();
  });
});

test('a command queued before the link is up is written once it connects', async () => {
  await withServer(async ({ port, received }) => {
    const gateway = createGateway(port);
    gateway.start();

    await gateway.send('10;PING;');

    await waitFor(() => lines(received).length === 1);
    assert.deepEqual(lines(received), ['10;PING;']);
    gateway.stop();
  });
});

test('reconnects on its own when the bridge drops the connection', async () => {
  await withServer(async ({ port, sockets }) => {
    const gateway = createGateway(port);
    gateway.start();
    await once(gateway, 'connected');

    const reconnected = once(gateway, 'connected');
    sockets[0].destroy();
    await once(gateway, 'disconnected');
    await reconnected;

    assert.equal(gateway.connected, true);
    gateway.stop();
  });
});

test('stop() drops the pending commands instead of leaving them hanging', async () => {
  await withServer(async ({ port }) => {
    const gateway = createGateway(port, { sendIntervalMs: 5_000 });
    gateway.start();
    await once(gateway, 'connected');

    gateway.send('10;PING;').catch(() => {});
    const pending = gateway.send('10;VERSION;');
    gateway.stop();

    await assert.rejects(pending, /stopped/);
    await assert.rejects(gateway.send('10;PING;'), /stopped/);
  });
});

test('refuses to grow the queue without bound', async () => {
  await withServer(async ({ port }) => {
    const gateway = createGateway(port, { sendIntervalMs: 5_000 });
    gateway.start();
    await once(gateway, 'connected');

    // The first command is written at once; the interval then holds the rest
    // in the queue, which must refuse to grow past its ceiling.
    const rejections = [];
    for (let i = 0; i < 60; i += 1) {
      gateway.send('10;PING;').catch((err) => rejections.push(err.message));
    }
    await waitFor(() => rejections.length > 0, 500);

    assert.ok(rejections.every((message) => /queue is full/.test(message)));
    gateway.stop();
  });
});
