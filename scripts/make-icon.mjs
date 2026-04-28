import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#1d1d22"/>
      <stop offset="100%" stop-color="#2a2530"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#cc785c"/>
      <stop offset="100%" stop-color="#e08f70"/>
    </linearGradient>
  </defs>
  <!-- rounded square background -->
  <rect width="256" height="256" rx="56" ry="56" fill="url(#bg)"/>
  <!-- soft inner highlight -->
  <rect x="14" y="14" width="228" height="228" rx="44" ry="44"
        fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="2"/>
  <!-- the C: a thick partial ring opening to the right -->
  <path d="M 178 78
           A 60 60 0 1 0 178 178"
        stroke="url(#ring)" stroke-width="26" fill="none" stroke-linecap="round"/>
  <!-- search-result dot -->
  <circle cx="186" cy="178" r="14" fill="#e08f70"/>
  <circle cx="186" cy="178" r="6"  fill="#fff" opacity="0.85"/>
</svg>`;

const sizes = [16, 24, 32, 48, 64, 128, 256];
const buildDir = resolve('build');
mkdirSync(buildDir, { recursive: true });

console.log('rendering svg → pngs at', sizes.join(', '));
const buffers = await Promise.all(
  sizes.map((s) =>
    sharp(Buffer.from(SVG))
      .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer(),
  ),
);

const ico = await pngToIco(buffers);
writeFileSync(resolve(buildDir, 'icon.ico'), ico);

const png512 = await sharp(Buffer.from(SVG))
  .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
writeFileSync(resolve(buildDir, 'icon.png'), png512);

const png256 = buffers[buffers.length - 1];
writeFileSync(resolve(buildDir, 'icon-256.png'), png256);

console.log(`wrote build/icon.ico (${ico.length} bytes), icon.png (512x512), icon-256.png`);
