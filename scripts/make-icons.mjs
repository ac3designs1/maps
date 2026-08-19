import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "resources");
mkdirSync(outDir, { recursive: true });
mkdirSync(join(root, "public"), { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(w, h, pixel) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function pinPixel(x, y, size, bg, pin, hole) {
  const s = size / 1024;
  const cx = size * 0.5;
  const cy = size * 0.42;
  const r = 210 * s;
  const holeR = 78 * s;
  const tipX = cx;
  const tipY = size * 0.78;
  const dx = x - cx;
  const dy = y - cy;
  if (dx * dx + dy * dy <= holeR * holeR) return hole;
  if (dx * dx + dy * dy <= r * r) return pin;
  const ax = x - cx;
  const ay = y - (cy + r * 0.35);
  const bx = tipX - cx;
  const by = tipY - (cy + r * 0.35);
  const half = 168 * s;
  if (ay > 0 && ay < by) {
    const t = ay / by;
    const w = half * (1 - t);
    if (Math.abs(ax - bx * t) <= w) return pin;
  }
  return bg;
}

function splashPixel(x, y, w, h) {
  const size = Math.min(w, h);
  const ox = Math.floor((w - size) / 2);
  const oy = Math.floor((h - size) / 2);
  if (x < ox || y < oy || x >= ox + size || y >= oy + size) return CREAM;
  return pinPixel(x - ox, y - oy, size, CREAM, BLUE, CREAM);
}

const BLUE = [26, 115, 232];
const WHITE = [255, 255, 255];
const CREAM = [242, 242, 247];

function writePng(file, buf) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
}

const icon = png(1024, 1024, (x, y) => pinPixel(x, y, 1024, BLUE, WHITE, BLUE));
writePng(join(outDir, "icon.png"), icon);
writePng(join(root, "public", "icon-1024.png"), icon);
writePng(join(root, "public", "icon-180.png"), png(180, 180, (x, y) => pinPixel(x, y, 180, BLUE, WHITE, BLUE)));
writePng(join(root, "public", "icon-192.png"), png(192, 192, (x, y) => pinPixel(x, y, 192, BLUE, WHITE, BLUE)));
writePng(join(root, "public", "icon-512.png"), png(512, 512, (x, y) => pinPixel(x, y, 512, BLUE, WHITE, BLUE)));
writePng(join(outDir, "splash.png"), png(1284, 2778, (x, y) => splashPixel(x, y, 1284, 2778)));

const iosIcon = join(root, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png");
if (existsSync(dirname(iosIcon))) writePng(iosIcon, icon);

const iosSplashDir = join(root, "ios", "App", "App", "Assets.xcassets", "Splash.imageset");
if (existsSync(iosSplashDir)) {
  const splash2732 = png(2732, 2732, (x, y) => splashPixel(x, y, 2732, 2732));
  writePng(join(iosSplashDir, "splash-2732x2732.png"), splash2732);
  writePng(join(iosSplashDir, "splash-2732x2732-1.png"), splash2732);
  writePng(join(iosSplashDir, "splash-2732x2732-2.png"), splash2732);
}

const androidRes = join(root, "android", "app", "src", "main", "res");
if (existsSync(androidRes)) {
  const densities = [
    ["mdpi", 48, 108],
    ["hdpi", 72, 162],
    ["xhdpi", 96, 216],
    ["xxhdpi", 144, 324],
    ["xxxhdpi", 192, 432],
  ];
  for (const [name, launcher, fg] of densities) {
    const dir = join(androidRes, `mipmap-${name}`);
    const launch = png(launcher, launcher, (x, y) => pinPixel(x, y, launcher, BLUE, WHITE, BLUE));
    writePng(join(dir, "ic_launcher.png"), launch);
    writePng(join(dir, "ic_launcher_round.png"), launch);
    writePng(join(dir, "ic_launcher_foreground.png"), png(fg, fg, (x, y) => pinPixel(x, y, fg, BLUE, WHITE, BLUE)));
  }
  const ports = [
    ["drawable-port-mdpi", 320, 480],
    ["drawable-port-hdpi", 480, 800],
    ["drawable-port-xhdpi", 720, 1280],
    ["drawable-port-xxhdpi", 960, 1600],
    ["drawable-port-xxxhdpi", 1280, 1920],
  ];
  const lands = [
    ["drawable-land-mdpi", 480, 320],
    ["drawable-land-hdpi", 800, 480],
    ["drawable-land-xhdpi", 1280, 720],
    ["drawable-land-xxhdpi", 1600, 960],
    ["drawable-land-xxxhdpi", 1920, 1280],
  ];
  for (const [folder, w, h] of [...ports, ...lands]) {
    writePng(join(androidRes, folder, "splash.png"), png(w, h, (x, y) => splashPixel(x, y, w, h)));
  }
  writePng(join(androidRes, "drawable", "splash.png"), png(1080, 1920, (x, y) => splashPixel(x, y, 1080, 1920)));
  writeFileSync(join(androidRes, "values", "ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#1A73E8</color>
</resources>
`);
}
console.log("wrote store icons and splash art");
