#!/usr/bin/env node
/*
 * su-registry asset generator — icons + banners, rendered with headless chromium.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node tools/gen-art/generate-art.mjs [--only=cron,blog] [--out=<dir>]
 *
 * With no --out it writes straight into extensions/<id>/{icon,banner}.png, so
 * re-running it regenerates every asset in place. Output is palette-quantised
 * with pngquant when available (these are git-tracked assets; raw truecolor
 * PNGs of the same images run 180-230 KB, quantised they run 40-60 KB).
 *
 * Icons (512x512, full-bleed) reproduce the existing house style measured off
 * extensions/{blog,contact,gallery}/icon.png:
 *   - 135deg linear gradient, TL -> BR, fully opaque, no rounded corners
 *   - soft white "splash" bloom centred at 25%/25%, ~+30 luminance at the peak
 *   - white lucide-idiom stroke glyph, 24-unit viewBox rendered at 309.8px
 *     (=> 2-unit stroke lands at ~25.8px and the glyph's visual bbox is 284px,
 *     which is exactly what the three existing icons measure)
 *   - very fine grain
 *
 * Banners (1200x400, 3:1) follow the studio "Paper & Ink" language: warm paper
 * ground, ink hairlines, one restrained accent wash borrowed from the matching
 * icon gradient. The centre band (28%-66%) is deliberately kept near-flat so a
 * card can overlay a title on top of it.
 *
 * No emoji, no third-party brand marks, no licensed assets. All geometry below
 * is authored here as plain SVG primitives.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, statSync, globSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- glyphs -- */
/* 24x24 viewBox, stroke-only, round caps/joins. `fills` are solid dots. */
const GLYPHS = {
  // scheduled tick: alarm clock with ears and feet
  cron: `
    <circle cx="12" cy="13" r="8"/>
    <path d="M12 8.6V13h3.4"/>
    <path d="M5 3 2 6"/>
    <path d="M19 3l3 3"/>
    <path d="M6.4 18.7 4 21"/>
    <path d="M17.6 18.7 20 21"/>`,
  // payment gateway: card with magnetic band
  newebpay: `
    <rect x="2" y="4.5" width="20" height="15" rx="2.6"/>
    <path d="M2 9.6h20"/>
    <path d="M6 14.8h3.5"/>
    <path d="M12.5 14.8h2"/>`,
  // third-party credential (deliberately NOT a Google mark): round key
  'google-login': `
    <circle cx="16" cy="8" r="5.5"/>
    <path d="M12.1 11.9 3 21"/>
    <path d="m5.8 18.2 2.6 2.6"/>
    <path d="m8.6 15.4 2.6 2.6"/>
    <circle cx="17.6" cy="6.4" r="1.05" fill="currentColor" stroke="none"/>`,
  // third-party sign-in (deliberately NOT a LINE mark): enter-the-door
  'line-login': `
    <path d="M15.5 3H20a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4.5"/>
    <path d="m8.5 17 4-5-4-5"/>
    <path d="M12.5 12H2.5"/>`,
};

/* --------------------------------------------------------------- palette -- */
/* c1 = top-left stop, c2 = bottom-right stop (135deg).
   blog #8446EF->#3DBFF8, contact #159F73->#28D4EE, gallery #F6A21A->#DA4BEF
   are the measured existing values and are kept here as the reference set. */
const PALETTE = {
  blog:            ['#8446EF', '#3DBFF8'], // existing, reference only
  contact:         ['#159F73', '#28D4EE'], // existing, reference only
  gallery:         ['#F6A21A', '#DA4BEF'], // existing, reference only
  cron:            ['#0EA5A9', '#A3E635'], // teal -> lime
  newebpay:        ['#1D4ED8', '#22D3EE'], // blue -> cyan
  'google-login':  ['#4F46E5', '#9333EA'], // indigo -> purple
  'line-login':    ['#DB2777', '#7C3AED'], // pink -> violet
};

const ICONS = ['cron', 'newebpay', 'google-login', 'line-login'];
const BANNERS = ['blog', 'gallery', 'contact'];

/* ------------------------------------------------------------------ icon -- */
const ICON_PX = 512;
const GLYPH_BOX = 309.8; // 24 units at 12.909 px/unit -> 284px visual bbox

function iconHtml(id) {
  const [c1, c2] = PALETTE[id];
  return `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${ICON_PX}px;height:${ICON_PX}px;overflow:hidden}
  .a{position:absolute;inset:0}
  .base{background:linear-gradient(135deg, ${c1} 0%, ${c2} 100%)}
  .bloom{background:radial-gradient(circle at 25% 25%,
      rgba(255,255,255,.34) 0%, rgba(255,255,255,.20) 26%,
      rgba(255,255,255,.06) 46%, rgba(255,255,255,0) 64%)}
  .shade{background:radial-gradient(circle at 88% 88%,
      rgba(0,0,0,.10) 0%, rgba(0,0,0,.04) 38%, rgba(0,0,0,0) 66%)}
  .grain{opacity:.042;mix-blend-mode:overlay}
  .glyph{position:absolute;left:50%;top:50%;
      width:${GLYPH_BOX}px;height:${GLYPH_BOX}px;transform:translate(-50%,-50%);
      color:#fff}
  .glyph svg{width:100%;height:100%;display:block}
  </style>
  <div class="a base"></div>
  <div class="a bloom"></div>
  <div class="a shade"></div>
  <svg class="a grain"><filter id="n"><feTurbulence type="fractalNoise"
      baseFrequency="0.82" numOctaves="2" stitchTiles="stitch"/></filter>
    <rect width="100%" height="100%" filter="url(#n)"/></svg>
  <div class="glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      >${GLYPHS[id]}</svg></div>`;
}

/* ---------------------------------------------------------------- banner -- */
const BAN_W = 1200, BAN_H = 400;
const PAPER = '#FBFAF6', INK = '#1E1B15';

/* Motifs live only in the outer thirds and are masked away toward the middle,
   so nothing high-contrast sits under an overlaid title. */
const MOTIFS = {
  // blog: a ruled paragraph on the left, an open folio on the right
  blog: `
    <g stroke="${INK}" stroke-opacity=".16" stroke-width="1.25" fill="none">
      ${[0, 1, 2, 3, 4, 5].map(i => {
        const y = 118 + i * 30;
        const w = [210, 168, 196, 140, 182, 116][i];
        return `<path d="M96 ${y}h${w}"/>`;
      }).join('')}
    </g>
    <g stroke="${INK}" stroke-opacity=".11" stroke-width="1.25" fill="none">
      <rect x="880" y="74" width="168" height="222" rx="6"
        transform="rotate(-4 964 185)"/>
    </g>
    <g transform="rotate(2 1022 226)" stroke="${INK}" stroke-opacity=".15"
       stroke-width="1.25" fill="none">
      <rect x="928" y="112" width="188" height="228" rx="6"
        fill="${PAPER}" fill-opacity=".6"/>
      ${[0, 1, 2, 3].map(i =>
        `<path d="M956 ${170 + i * 28}h${[128, 104, 132, 78][i]}"/>`).join('')}
    </g>`,
  // gallery: a dot grid on the left, tilted frames on the right
  gallery: `
    <g fill="${INK}" fill-opacity=".16">
      ${Array.from({ length: 6 * 4 }, (_, k) => {
        const c = k % 6, r = (k / 6) | 0;
        return `<circle cx="${100 + c * 30}" cy="${140 + r * 30}" r="2.1"/>`;
      }).join('')}
    </g>
    <g stroke="${INK}" stroke-opacity=".11" stroke-width="1.25" fill="none">
      <rect x="984" y="82" width="152" height="114" rx="5"
        transform="rotate(-6 1060 139)"/>
    </g>
    <g transform="rotate(2 1004 236)" stroke="${INK}" stroke-opacity=".16"
       stroke-width="1.25" fill="none">
      <rect x="896" y="158" width="216" height="156" rx="6"
        fill="${PAPER}" fill-opacity=".6"/>
      <circle cx="944" cy="198" r="10"/>
      <path d="M904 296l54-58 34 36 30-32 52 56"/>
    </g>`,
  // contact: a stamped grid on the left, an opened envelope on the right
  contact: `
    <g stroke="${INK}" stroke-opacity=".15" stroke-width="1.25" fill="none">
      <rect x="96" y="120" width="196" height="36" rx="6"/>
      <rect x="96" y="172" width="196" height="36" rx="6"/>
      <rect x="96" y="224" width="196" height="60" rx="6"/>
      <rect x="96" y="300" width="84" height="34" rx="17"/>
    </g>
    <g stroke="${INK}" stroke-opacity=".14" stroke-width="1.25" fill="none">
      <rect x="896" y="128" width="232" height="152" rx="7"/>
      <path d="M896 152l116 84 116-84"/>
      <path d="M896 268l84-64"/><path d="M1128 268l-84-64"/>
    </g>`,
};

function bannerHtml(id) {
  const [c1, c2] = PALETTE[id];
  return `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${BAN_W}px;height:${BAN_H}px;overflow:hidden;background:${PAPER}}
  .a{position:absolute;inset:0}
  /* accent wash: the icon's own two stops, held far below Paper & Ink's ceiling */
  .wash1{background:radial-gradient(78% 160% at 99% 0%,
      ${c1}26 0%, ${c1}14 34%, ${c1}07 62%, ${c1}00 100%)}
  .wash2{background:radial-gradient(70% 150% at 1% 100%,
      ${c2}20 0%, ${c2}11 36%, ${c2}06 64%, ${c2}00 100%)}
  /* keeps the middle of the card quiet under overlaid type */
  .motif{-webkit-mask-image:linear-gradient(90deg,#000 0%,#000 21%,
      transparent 34%,transparent 66%,#000 79%,#000 100%)}
  .rule{position:absolute;left:0;right:0;bottom:0;height:1px;
      background:${INK};opacity:.10}
  .rule-t{position:absolute;left:0;right:0;top:0;height:1px;
      background:${INK};opacity:.06}
  .grain{opacity:.055;mix-blend-mode:multiply}
  </style>
  <div class="a wash1"></div>
  <div class="a wash2"></div>
  <svg class="a motif" viewBox="0 0 ${BAN_W} ${BAN_H}">${MOTIFS[id]}</svg>
  <div class="rule-t"></div><div class="rule"></div>
  <svg class="a grain"><filter id="n"><feTurbulence type="fractalNoise"
      baseFrequency="0.8" numOctaves="1" stitchTiles="stitch"/></filter>
    <rect width="100%" height="100%" filter="url(#n)"/></svg>`;
}

/* ------------------------------------------------------------------ main -- */
const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7)
  .split(',').filter(Boolean);
// default: write straight into the registry, i.e. extensions/<id>/<file>.png
const outRoot = (args.find(a => a.startsWith('--out=')) || '').slice(6)
  || join(HERE, '..', '..', 'extensions');

const jobs = [
  ...ICONS.map(id => ({ id, kind: 'icon', w: ICON_PX, h: ICON_PX,
    html: iconHtml(id), file: 'icon.png' })),
  ...BANNERS.map(id => ({ id, kind: 'banner', w: BAN_W, h: BAN_H,
    html: bannerHtml(id), file: 'banner.png' })),
].filter(j => !only.length || only.includes(j.id));

// Honour a pre-provisioned chromium when the host ships one: sandbox images
// pin a build whose revision may not match this playwright's expectation.
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return undefined;
  for (const pat of ['chromium-*/chrome-linux/chrome',
                     'chromium-*/chrome-linux64/chrome',
                     'chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
    const hit = globSync(join(root, pat));
    if (hit.length) return hit.sort().pop();
  }
  return undefined;
}
const CHROME = findChromium();

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
for (const j of jobs) {
  const page = await browser.newPage({
    viewport: { width: j.w, height: j.h }, deviceScaleFactor: 1 });
  await page.setContent(j.html, { waitUntil: 'load' });
  const buf = await page.screenshot({ type: 'png' });
  await page.close();

  const dir = join(outRoot, j.id);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, j.file);
  writeFileSync(out, buf);
  // palette-quantise: these are git-tracked assets, keep them small
  try {
    execFileSync('pngquant', ['--quality=82-98', '--speed', '1', '--strip',
      '--force', '--output', out, '--', out]);
  } catch { /* pngquant optional */ }
  const kb = (statSync(out).size / 1024).toFixed(1);
  console.log(`${j.kind.padEnd(6)} ${j.id.padEnd(14)} ${j.w}x${j.h}  ${kb} KB  ${out}`);
}
await browser.close();
