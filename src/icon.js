'use strict';
/** Procedural app icon: rounded square, a "broadcast" dot with two arcs, and an optional status badge. */
const zlib = require('zlib');

const COLORS = {
  base: [217, 119, 87],
  ok: [46, 160, 67],
  warn: [230, 160, 20],
  busy: [60, 130, 230],
};

function drawRGBA(size, badge) {
  const S = 4; // supersampling
  const N = size * S;
  const px = new Float32Array(size * size * 4);
  const cx = N / 2;
  const cy = N / 2;
  const radius = N * 0.22;
  const inRounded = (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (N / 2 - radius - N * 0.03), 0);
    const dy = Math.max(Math.abs(y - cy) - (N / 2 - radius - N * 0.03), 0);
    return dx * dx + dy * dy <= radius * radius;
  };
  const dotX = cx - N * 0.14;
  const dotY = cy + N * 0.14;
  const ring = (x, y, r, w) => {
    const d = Math.hypot(x - dotX, y - dotY);
    return Math.abs(d - r) <= w / 2 && x >= dotX - N * 0.02 && y <= dotY + N * 0.02; // upper-right quadrant
  };
  const bc = badge ? COLORS[badge] : null;
  const bx = N * 0.74;
  const by = N * 0.74;
  const br = N * 0.2;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c = null;
      if (inRounded(x, y)) {
        c = COLORS.base;
        if (Math.hypot(x - dotX, y - dotY) <= N * 0.075 || ring(x, y, N * 0.24, N * 0.075) || ring(x, y, N * 0.4, N * 0.075)) {
          c = [255, 255, 255];
        }
      }
      if (bc) {
        const d = Math.hypot(x - bx, y - by);
        if (d <= br) c = bc;
        else if (d <= br + N * 0.04) c = [255, 255, 255];
      }
      if (c) {
        const i = ((Math.floor(y / S) * size) + Math.floor(x / S)) * 4;
        px[i] += c[0]; px[i + 1] += c[1]; px[i + 2] += c[2]; px[i + 3] += 1;
      }
    }
  }
  const out = Buffer.alloc(size * size * 4);
  const area = S * S;
  for (let i = 0; i < size * size; i++) {
    const cov = px[i * 4 + 3];
    if (cov > 0) {
      out[i * 4] = Math.round(px[i * 4] / cov);
      out[i * 4 + 1] = Math.round(px[i * 4 + 1] / cov);
      out[i * 4 + 2] = Math.round(px[i * 4 + 2] / cov);
      out[i * 4 + 3] = Math.round((cov / area) * 255);
    }
  }
  return out;
}

/** BGRA buffer for Electron's nativeImage.createFromBitmap. */
function drawBGRA(size, badge) {
  const rgba = drawRGBA(size, badge);
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i]; out[i + 3] = rgba[i + 3];
  }
  return out;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function toPNG(size, badge) {
  const rgba = drawRGBA(size, badge);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** .ico containing PNG-compressed images. */
function toICO(sizes) {
  const images = sizes.map((s) => ({ s, data: toPNG(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ s, data }) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

module.exports = { drawBGRA, toPNG, toICO };
