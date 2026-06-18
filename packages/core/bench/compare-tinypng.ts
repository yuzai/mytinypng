/**
 * Head-to-head: the REAL TinyPNG API vs our engine, on identical images.
 *
 *   TINIFY_KEY=... pnpm --filter mytinypng-core compare         (uses cache)
 *   TINIFY_KEY=... pnpm --filter mytinypng-core compare --refresh   (re-fetch)
 *
 * Free key: https://tinypng.com/developers (500 images/month). TinyPNG results
 * are cached by content hash under bench/.tinycache, so re-running while tuning
 * OUR side spends zero API quota.
 *
 * Reads images from bench/samples (committed, your real images) and
 * bench/.fixtures (generated). Writes a side-by-side gallery to bench/output/
 * (original / ours / tinypng + index.html) for eyeball verification, and prints
 * a perceptual-SSIM table.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import tinify from "tinify";
import { compress } from "../src/compress.js";
import { detectFormat } from "../src/formats.js";
import { ssim } from "../src/ssim.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "samples");
const FIXTURES = join(HERE, ".fixtures");
const OUT = join(HERE, "output");
const CACHE = join(HERE, ".tinycache");

for (const p of [join(HERE, "../../../.env"), join(process.cwd(), ".env")]) {
  try {
    process.loadEnvFile(p);
    break;
  } catch {
    /* try next */
  }
}
if (!process.env.TINIFY_KEY) {
  console.error("Missing TINIFY_KEY. Free key: https://tinypng.com/developers");
  process.exit(1);
}
tinify.key = process.env.TINIFY_KEY;

const refresh = process.argv.includes("--refresh");

const kb = (n: number) => `${(n / 1024).toFixed(n < 1024 * 100 ? 1 : 0)}kB`;
const saved = (out: number, orig: number) => `${((1 - out / orig) * 100).toFixed(0)}%`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function listImages(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

async function perceptualLuma(buf: Buffer, w: number, h: number): Promise<Buffer> {
  const { data } = await sharp(buf, { failOn: "none" })
    .resize(w, h, { fit: "fill" })
    .greyscale()
    .blur(1.0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

async function tinypng(orig: Buffer): Promise<Buffer> {
  const cachePath = join(CACHE, sha(orig));
  if (!refresh) {
    try {
      return await readFile(cachePath);
    } catch {
      /* miss */
    }
  }
  const out = Buffer.from(await tinify.fromBuffer(orig).toBuffer());
  await mkdir(CACHE, { recursive: true });
  await writeFile(cachePath, out);
  return out;
}

interface Row {
  name: string;
  dims: string;
  orig: number;
  ours: number;
  sOurs: number;
  skipped: boolean;
  tiny: number | null;
  sTiny: number | null;
  tinyErr?: string;
}

async function main() {
  await mkdir(join(OUT, "original"), { recursive: true });
  await mkdir(join(OUT, "ours"), { recursive: true });
  await mkdir(join(OUT, "tinypng"), { recursive: true });

  // samples first, then fixtures; de-dupe by filename so samples win.
  const all = [...(await listImages(SAMPLES)), ...(await listImages(FIXTURES))];
  const seen = new Set<string>();
  const files = all.filter((p) => {
    const b = basename(p);
    if (seen.has(b)) return false;
    seen.add(b);
    return true;
  });
  files.sort((a, b) => basename(a).localeCompare(basename(b)));

  const rows: Row[] = [];
  console.log(`\n${files.length} images. perceptual SSIM vs original (1.0 = identical).\n`);
  console.log(
    "image".padEnd(22) + "| original |   ours              |   TinyPNG           | size Δ",
  );
  console.log("-".repeat(86));

  for (const path of files) {
    const name = basename(path);
    const orig = await readFile(path);
    const meta = await sharp(orig, { failOn: "none" }).metadata();
    if (!detectFormat(meta.format)) continue;
    const W = meta.width!;
    const H = meta.height!;
    const ref = await perceptualLuma(orig, W, H);
    const ssimOf = async (d: Buffer) => ssim(ref, await perceptualLuma(d, W, H), W, H);

    const ours = await compress(orig);
    let tiny: Buffer | null = null;
    let tinyErr: string | undefined;
    try {
      tiny = await tinypng(orig);
    } catch (e) {
      tinyErr = (e as Error)?.message ?? String(e);
    }

    await writeFile(join(OUT, "original", name), orig);
    await writeFile(join(OUT, "ours", name), ours.data);
    if (tiny) await writeFile(join(OUT, "tinypng", name), tiny);

    const sOurs = await ssimOf(ours.data);
    const sTiny = tiny ? await ssimOf(tiny) : null;
    const row: Row = {
      name,
      dims: `${W}x${H}`,
      orig: orig.length,
      ours: ours.compressedSize,
      sOurs,
      skipped: ours.skipped,
      tiny: tiny?.length ?? null,
      sTiny,
      tinyErr,
    };
    rows.push(row);

    const tinyLen = tiny?.length ?? null;
    let sizeDelta = "—";
    if (tinyLen != null) {
      const d = (ours.compressedSize / tinyLen - 1) * 100;
      sizeDelta = `${d > 0 ? "+" : ""}${d.toFixed(0)}%`;
    }
    console.log(
      name.padEnd(22) +
        `| ${kb(orig.length).padStart(8)} ` +
        `| ${kb(ours.compressedSize).padStart(7)} ${saved(ours.compressedSize, orig.length).padStart(4)} ${sOurs.toFixed(3)} ` +
        `| ${(tinyLen != null ? kb(tinyLen) : "ERR").padStart(7)} ${(tinyLen != null ? saved(tinyLen, orig.length) : "").padStart(4)} ${sTiny != null ? sTiny.toFixed(3) : "  —  "} ` +
        `| ${sizeDelta}`,
    );
  }

  console.log("-".repeat(86));
  const valid = rows.filter((r) => r.tiny != null);
  const oursTotal = valid.reduce((s, r) => s + r.ours, 0);
  const tinyTotal = valid.reduce((s, r) => s + r.tiny!, 0);
  console.log(
    `Totals (${valid.length} imgs): ours ${kb(oursTotal)}  vs  TinyPNG ${kb(tinyTotal)}  ` +
      `(ours is ${((oursTotal / tinyTotal - 1) * 100).toFixed(1)}% ${oursTotal <= tinyTotal ? "smaller-or-equal" : "larger"})`,
  );
  console.log(`Gallery: open ${join(OUT, "index.html")}`);
  console.log(`TinyPNG API calls this run: ${tinify.compressionCount ?? "?"} (cache hits cost 0)\n`);

  await writeFile(join(OUT, "index.html"), renderHtml(rows));
}

function renderHtml(rows: Row[]): string {
  const card = (
    label: string,
    folder: string,
    name: string,
    bytes: number | null,
    orig: number,
    ssimVal: number | null,
    extra = "",
  ) => {
    if (bytes == null)
      return `<div class="card"><div class="lbl">${label}</div><div class="err">${extra || "n/a"}</div></div>`;
    const pct = label === "original" ? "" : ` · −${((1 - bytes / orig) * 100).toFixed(0)}%`;
    const s = ssimVal != null ? ` · SSIM ${ssimVal.toFixed(3)}` : "";
    return `<div class="card">
      <div class="lbl">${label} · ${(bytes / 1024).toFixed(1)}kB${pct}${s}${extra}</div>
      <a href="${folder}/${encodeURIComponent(name)}" target="_blank"><img loading="lazy" src="${folder}/${encodeURIComponent(name)}"></a>
    </div>`;
  };

  const blocks = rows
    .map((r) => {
      const winner =
        r.tiny != null
          ? r.ours < r.tiny
            ? `<span class="ours">ours smaller by ${(((r.tiny - r.ours) / r.tiny) * 100).toFixed(0)}%</span>`
            : r.ours > r.tiny
              ? `<span class="tiny">TinyPNG smaller by ${(((r.ours - r.tiny) / r.ours) * 100).toFixed(0)}%</span>`
              : `<span>tie</span>`
          : "";
      return `<section>
      <h2>${r.name} <small>${r.dims}${r.skipped ? " · ours: kept original (couldn't beat it)" : ""} ${winner}</small></h2>
      <div class="grid">
        ${card("original", "original", r.name, r.orig, r.orig, null)}
        ${card("ours", "ours", r.name, r.ours, r.orig, r.sOurs)}
        ${card("TinyPNG", "tinypng", r.name, r.tiny, r.orig, r.sTiny, r.tinyErr ? ` · ${r.tinyErr}` : "")}
      </div>
    </section>`;
    })
    .join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mytinypng vs TinyPNG</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { margin: 0 0 4px; }
  p.hint { color: #888; margin: 0 0 24px; }
  section { margin: 0 0 40px; border-top: 1px solid #8884; padding-top: 16px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  h2 small { font-weight: normal; color: #888; }
  .ours { color: #16a34a; font-weight: 600; }
  .tiny { color: #dc2626; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { min-width: 0; }
  .lbl { font-size: 12px; color: #888; margin-bottom: 6px; }
  .err { color: #dc2626; }
  /* checkerboard so transparency is visible */
  img { max-width: 100%; height: auto; display: block; border: 1px solid #8884;
    background-image: linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%);
    background-size: 16px 16px; background-position: 0 0,0 8px,8px -8px,-8px 0; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
</style></head><body>
<h1>mytinypng vs TinyPNG</h1>
<p class="hint">Click any image to open it full-size in a new tab and zoom in. "ours" uses default settings (sharp + mozjpeg/libimagequant + oxipng).</p>
${blocks}
</body></html>`;
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
