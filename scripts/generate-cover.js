// -----------------------------------------------------------------------------
// Regenerates `cover.png`, the 800x534 catalog cover of the integration.
//
// The cover is committed; this script only exists to make it reproducible (and
// to keep the repository free of an image editor's project file). It writes a
// plain RGB PNG with `node:zlib`, so it needs no dependency at all.
//
//   node scripts/generate-cover.js
// -----------------------------------------------------------------------------

import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Contract of the store: 800x534, PNG or JPEG, at most 150 KB.
const WIDTH = 800;
const HEIGHT = 534;

const BACKGROUND_TOP = [0x0a, 0x17, 0x2e];
const BACKGROUND_BOTTOM = [0x15, 0x2f, 0x5e];
const WAVE = [0x4d, 0xa3, 0xff];
const INK = [0xff, 0xff, 0xff];
const ACCENT = [0x4d, 0xa3, 0xff];

// The emitter the waves radiate from, on the left third.
const SOURCE = { x: 196, y: 267 };
const WAVE_RADII = [58, 108, 158, 208, 258, 308, 358, 408];
const WAVE_HALF_WIDTH = 2.4;
const WAVE_SPREAD_RADIANS = (78 * Math.PI) / 180;

// 5x7 bitmap glyphs — only the six letters of the wordmark are needed.
const GLYPHS = {
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
};

const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);

/**
 * Blend a colour over a pixel.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @param {number[]} color - `[r, g, b]`.
 * @param {number} alpha - Opacity, 0 to 1.
 */
function blend(x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT || alpha <= 0) {
    return;
  }
  const offset = (y * WIDTH + x) * 3;
  const opacity = Math.min(1, alpha);
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = Math.round(
      pixels[offset + channel] * (1 - opacity) + color[channel] * opacity,
    );
  }
}

/**
 * Fill an axis-aligned rectangle.
 * @param {number} x - Left.
 * @param {number} y - Top.
 * @param {number} width - Width.
 * @param {number} height - Height.
 * @param {number[]} color - `[r, g, b]`.
 * @param {number} [alpha] - Opacity.
 */
function rectangle(x, y, width, height, color, alpha = 1) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      blend(column, row, color, alpha);
    }
  }
}

/** Vertical gradient background. */
function paintBackground() {
  for (let y = 0; y < HEIGHT; y += 1) {
    const ratio = y / (HEIGHT - 1);
    const color = BACKGROUND_TOP.map((channel, index) =>
      Math.round(channel + (BACKGROUND_BOTTOM[index] - channel) * ratio),
    );
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
}

/** The concentric arcs: a radio transmission, opening to the right. */
function paintWaves() {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const dx = x - SOURCE.x;
      const dy = y - SOURCE.y;
      const angle = Math.atan2(dy, dx);
      if (Math.abs(angle) > WAVE_SPREAD_RADIANS) {
        continue;
      }
      const distance = Math.hypot(dx, dy);
      for (const radius of WAVE_RADII) {
        const offset = Math.abs(distance - radius);
        if (offset > WAVE_HALF_WIDTH) {
          continue;
        }
        // Softer as the wave travels, and as it reaches the edge of the beam.
        const edge = 1 - offset / WAVE_HALF_WIDTH;
        const travel = 1 - radius / (WAVE_RADII[WAVE_RADII.length - 1] + 90);
        const spread = 1 - (Math.abs(angle) / WAVE_SPREAD_RADIANS) ** 2;
        blend(x, y, WAVE, edge * travel * spread * 0.9);
      }
    }
  }
}

/** The emitter: a small mast with a dot on top. */
function paintEmitter() {
  rectangle(SOURCE.x - 3, SOURCE.y - 8, 6, 74, INK, 0.92);
  rectangle(SOURCE.x - 34, SOURCE.y + 62, 68, 6, INK, 0.92);
  for (let y = -22; y <= 0; y += 1) {
    for (let x = -11; x <= 11; x += 1) {
      const distance = Math.hypot(x, y + 11);
      if (distance <= 11) {
        blend(SOURCE.x + x, SOURCE.y + y - 6, ACCENT, distance > 10 ? 11 - distance : 1);
      }
    }
  }
}

/**
 * Draw a string with the bitmap font.
 * @param {string} text - Letters present in GLYPHS.
 * @param {number} x - Left of the first glyph.
 * @param {number} y - Top of the glyphs.
 * @param {number} scale - Pixel size of one font pixel.
 * @param {number} spacing - Gap between two glyphs, in pixels.
 * @returns {number} The width the text occupies.
 */
function paintText(text, x, y, scale, spacing) {
  let cursor = x;
  for (const letter of text) {
    const glyph = GLYPHS[letter];
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((bit, columnIndex) => {
        if (bit === '1') {
          rectangle(cursor + columnIndex * scale, y + rowIndex * scale, scale, scale, INK, 1);
        }
      });
    });
    cursor += glyph[0].length * scale + spacing;
  }
  return cursor - spacing - x;
}

/**
 * Encode the RGB buffer as a PNG.
 * @returns {Buffer} The PNG file.
 */
function encodePng() {
  // One filter byte (0 = none) in front of every scanline.
  const raw = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
  for (let y = 0; y < HEIGHT; y += 1) {
    raw[y * (WIDTH * 3 + 1)] = 0;
    pixels.copy(raw, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour RGB
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Build one PNG chunk (length + type + data + CRC).
 * @param {string} type - Four-letter chunk type.
 * @param {Buffer} data - Chunk payload.
 * @returns {Buffer} The chunk.
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/**
 * @param {Buffer} buffer - Bytes to checksum.
 * @returns {number} The CRC-32 of the buffer.
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

paintBackground();
paintWaves();
paintEmitter();

// Wordmark, right of the emitter, optically centred on the beam.
const TEXT = { x: 404, y: 226, scale: 9, spacing: 11 };
const textWidth = paintText('RFLINK', TEXT.x, TEXT.y, TEXT.scale, TEXT.spacing);
rectangle(TEXT.x, TEXT.y + 7 * TEXT.scale + 22, textWidth, 5, ACCENT, 1);

const outputPath = fileURLToPath(new URL('../cover.png', import.meta.url));
const png = encodePng();
await writeFile(outputPath, png);
console.log(`Written ${outputPath} (${WIDTH}x${HEIGHT}, ${(png.length / 1024).toFixed(1)} KB)`);
