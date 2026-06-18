/**
 * Quality benchmark: encodes a set of fixtures at several qualities, measures
 * byte savings AND structural similarity (SSIM) to the original, and prints a
 * table. Use it to confirm defaults land at "visually lossless, TinyPNG-level"
 * (typically SSIM >= ~0.98 with a large size reduction).
 *
 *   pnpm --filter mytinypng-core bench
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { compress } from "../src/compress.js";
import { detectFormat } from "../src/formats.js";
import { ssim } from "../src/ssim.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, ".fixtures");
const W = 800;
const H = 600;

/** Continuous-tone, truecolor image — the hard case for PNG, base for JPEG. */
function makePhoto(): Buffer {
  const buf = Buffer.alloc(W * H * 3);
  let i = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Smooth gradients + soft structure + light grain — like a real photo,
      // not uniform noise (which is the pathological worst case for SSIM).
      const r =
        128 + 90 * Math.sin(x / 90) + 30 * Math.sin((x + y) / 70) + (Math.random() * 6 - 3);
      const g =
        128 + 80 * Math.sin(y / 80) + 30 * Math.cos(x / 110) + (Math.random() * 6 - 3);
      const b =
        128 + 70 * Math.cos((x - y) / 120) + 40 * Math.sin(y / 60) + (Math.random() * 6 - 3);
      buf[i++] = clamp(r);
      buf[i++] = clamp(g);
      buf[i++] = clamp(b);
    }
  }
  return buf;
}

/** Flat UI graphic: a handful of solid colors, sharp edges — palette's sweet spot. */
function makeUi(): Buffer {
  const palette = [
    [255, 255, 255],
    [37, 99, 235],
    [16, 185, 129],
    [239, 68, 68],
    [250, 204, 21],
    [30, 41, 59],
  ];
  const buf = Buffer.alloc(W * H * 3);
  let i = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const band = Math.floor(x / 130) + Math.floor(y / 100);
      const inCircle = (x - 400) ** 2 + (y - 300) ** 2 < 120 ** 2;
      const c = inCircle ? palette[1] : palette[band % palette.length];
      buf[i++] = c[0];
      buf[i++] = c[1];
      buf[i++] = c[2];
    }
  }
  return buf;
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

async function ensureFixtures(): Promise<void> {
  await mkdir(FIX, { recursive: true });
  const existing = await readdir(FIX);
  if (existing.length > 0) return;

  const photo = makePhoto();
  const ui = makeUi();
  const raw = { raw: { width: W, height: H, channels: 3 as const } };

  await sharp(photo, raw).png().toFile(join(FIX, "photo-truecolor.png"));
  await sharp(photo, raw).jpeg({ quality: 95 }).toFile(join(FIX, "photo.jpg"));
  await sharp(ui, raw).png().toFile(join(FIX, "ui-graphic.png"));

  // Pull a few real photos to validate against synthetic ones (and to give the
  // TinyPNG head-to-head real content). Seeds make them reproducible.
  const reals: Array<[string, (b: Buffer) => sharp.Sharp]> = [
    ["real-photo-1.jpg", (b) => sharp(b).jpeg({ quality: 92 })],
    ["real-photo-2.jpg", (b) => sharp(b).jpeg({ quality: 92 })],
    ["real-photo.png", (b) => sharp(b).png()], // a real, truecolor PNG (photo-as-PNG)
  ];
  for (const [name, enc] of reals) {
    try {
      const seed = name.replace(/\W/g, "");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`https://picsum.photos/seed/${seed}/800/600`, {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        await enc(Buffer.from(await res.arrayBuffer())).toFile(join(FIX, name));
      }
    } catch {
      console.log(`(offline: skipping ${name})`);
    }
  }
}

async function luma(buf: Buffer, w: number, h: number) {
  const { data } = await sharp(buf, { failOn: "none" })
    .resize(w, h, { fit: "fill" })
    .greyscale()
    .blur(1.0) // perceptual: de-emphasize dither/JPEG grain (see engine)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function kb(n: number) {
  return `${(n / 1024).toFixed(1)}kB`;
}
function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  await ensureFixtures();
  const files = (await readdir(FIX)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));

  for (const file of files.sort()) {
    const path = join(FIX, file);
    const buf = await readFile(path);
    const meta = await sharp(buf).metadata();
    const fmt = detectFormat(meta.format);
    if (!fmt) continue;

    const ref = await luma(buf, meta.width!, meta.height!);
    const measure = async (data: Buffer) =>
      ssim(ref, await luma(data, meta.width!, meta.height!), meta.width!, meta.height!);

    console.log(`\n=== ${file}  (${fmt}, ${kb(buf.length)}, ${meta.width}x${meta.height}) ===`);
    console.log("mode            quality   size       saved     ssim");
    console.log("-".repeat(58));

    for (const q of [50, 60, 70, 75, 80, 85, 90]) {
      const r = await compress(buf, { quality: q });
      const s = await measure(r.data);
      const tag = q === undefined ? "" : "";
      console.log(
        `fixed${tag}           ${String(q).padEnd(8)} ${kb(r.compressedSize).padEnd(10)} ` +
          `${pct(r.ratio).padStart(6)}   ${s.toFixed(4)}${r.skipped ? "  (skipped)" : ""}`,
      );
    }

    // Default (no quality passed) — what users get out of the box.
    const def = await compress(buf);
    console.log(
      `DEFAULT          ${String(def.quality).padEnd(8)} ${kb(def.compressedSize).padEnd(10)} ` +
        `${pct(def.ratio).padStart(6)}   ${(await measure(def.data)).toFixed(4)}`,
    );

    // Smart mode: smallest output keeping SSIM >= 0.98.
    const smart = await compress(buf, { targetSsim: 0.98 });
    console.log(
      `smart(ssim>=.98) ${String(smart.quality).padEnd(8)} ${kb(smart.compressedSize).padEnd(10)} ` +
        `${pct(smart.ratio).padStart(6)}   ${(await measure(smart.data)).toFixed(4)}`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
