import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = resolve('build/source.jpg');

if (!existsSync(SOURCE)) {
  console.error(
    `[make-icon] No source image at ${SOURCE}. Drop a square-ish JPG/PNG there, then re-run.`,
  );
  process.exit(1);
}

// Square the source with center-cover crop, then mask to a rounded square.
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const buildDir = resolve('build');
mkdirSync(buildDir, { recursive: true });

async function renderAt(size) {
  const radius = Math.round(size * 0.22);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>
     </svg>`,
  );
  const cropped = await sharp(SOURCE)
    .resize(size, size, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();
  return sharp(cropped)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

console.log('rendering icon at', SIZES.join(', '), 'from', SOURCE);
const buffers = await Promise.all(SIZES.map(renderAt));
const ico = await pngToIco(buffers);
writeFileSync(resolve(buildDir, 'icon.ico'), ico);

const png512 = await renderAt(512);
writeFileSync(resolve(buildDir, 'icon.png'), png512);

const png256 = buffers[buffers.length - 1];
writeFileSync(resolve(buildDir, 'icon-256.png'), png256);

console.log(`wrote build/icon.ico (${ico.length} bytes), icon.png (512x512), icon-256.png`);
