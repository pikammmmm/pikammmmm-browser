import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A cleaner mark: rounded square with a chat-bubble + "C" cut-out, on a refined
// copper-to-plum gradient. No extra dots; the negative space inside the C reads
// as both a search aperture and a chat speech bubble at small sizes.
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"  stop-color="#1a1320"/>
      <stop offset="60%" stop-color="#1f1a26"/>
      <stop offset="100%" stop-color="#2a1d28"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#f0a585"/>
      <stop offset="55%"  stop-color="#d4886a"/>
      <stop offset="100%" stop-color="#a85a44"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="55%">
      <stop offset="0%"   stop-color="rgba(240,165,133,0.10)"/>
      <stop offset="100%" stop-color="rgba(240,165,133,0)"/>
    </radialGradient>
  </defs>

  <!-- background -->
  <rect width="256" height="256" rx="56" ry="56" fill="url(#bg)"/>
  <rect width="256" height="256" rx="56" ry="56" fill="url(#glow)"/>
  <rect x="1.5" y="1.5" width="253" height="253" rx="55" ry="55"
        fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <!-- the C: a thick partial ring with cleanly squared end-caps -->
  <g>
    <!-- outer C arc -->
    <path d="M 184 90
             A 60 60 0 1 0 184 166"
          stroke="url(#mark)"
          stroke-width="28"
          fill="none"
          stroke-linecap="round"/>
    <!-- subtle inner highlight on top of the C -->
    <path d="M 184 90
             A 60 60 0 0 0 96 70"
          stroke="rgba(255,255,255,0.18)"
          stroke-width="6"
          fill="none"
          stroke-linecap="round"
          transform="translate(-2 -2)"/>
  </g>
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
