import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { DEFAULT_QUALITY, detectFormat } from "./formats.js";
import { oxipng } from "./oxipng.js";
import { ssim } from "./ssim.js";
import type { CompressOptions, CompressResult, ImageFormat } from "./types.js";

type Input = Buffer | Uint8Array | string;

async function toBuffer(input: Input): Promise<Buffer> {
  if (typeof input === "string") return readFile(input);
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

interface EncodeOpts {
  quality: number;
  mode: "lossy" | "lossless";
  effort?: number;
  stripMetadata: boolean;
  maxWidth?: number;
  maxHeight?: number;
  animated: boolean;
}

/** Run the sharp pipeline for one (format, quality) combination. */
async function encode(
  buf: Buffer,
  format: ImageFormat,
  opts: EncodeOpts,
): Promise<{ data: Buffer; width: number; height: number }> {
  let pipeline = sharp(buf, { failOn: "none", animated: opts.animated });

  // Auto-orient from EXIF and bake it into the pixels so we can drop EXIF
  // safely. Skipped for animated images (rotate is not frame-aware).
  if (!opts.animated) pipeline = pipeline.rotate();

  if (opts.maxWidth || opts.maxHeight) {
    pipeline = pipeline.resize({
      width: opts.maxWidth,
      height: opts.maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const lossless = opts.mode === "lossless";
  switch (format) {
    case "jpeg":
      // mozjpeg: trellis quantization + optimized Huffman tables + progressive.
      pipeline = pipeline.jpeg({ quality: opts.quality, mozjpeg: true });
      break;
    case "png":
      pipeline = lossless
        ? pipeline.png({
            palette: false,
            compressionLevel: 9,
            effort: 10,
            adaptiveFiltering: true,
          })
        : pipeline.png({
            // libimagequant lossy palette quantization (pngquant's library).
            palette: true,
            quality: opts.quality,
            dither: 1.0,
            effort: 10,
            compressionLevel: 9,
          });
      break;
    case "webp":
      pipeline = lossless
        ? pipeline.webp({ lossless: true, effort: opts.effort ?? 6 })
        : pipeline.webp({ quality: opts.quality, effort: opts.effort ?? 6 });
      break;
    case "avif":
      pipeline = pipeline.avif({
        quality: opts.quality,
        effort: opts.effort ?? 4,
        lossless,
      });
      break;
  }

  // Always keep the ICC profile (color accuracy); keep the rest only when asked.
  pipeline = opts.stripMetadata
    ? pipeline.keepIccProfile()
    : pipeline.keepMetadata();

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Light blur applied before SSIM so the metric reflects perception, not pixel
 * grain: palette dithering and fine JPEG noise are nearly invisible to the eye
 * but tank a raw SSIM. Blurring both images equally de-emphasizes that grain.
 */
const PERCEPTUAL_BLUR = 1.0;

/** Decode an image to single-channel (perceptual) luma at a fixed size for SSIM. */
async function toLuma(
  buf: Buffer,
  size?: { width: number; height: number },
): Promise<{ data: Buffer; width: number; height: number }> {
  let p = sharp(buf, { failOn: "none" }).rotate();
  if (size) p = p.resize(size.width, size.height, { fit: "fill" });
  const { data, info } = await p
    .greyscale()
    .blur(PERCEPTUAL_BLUR)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

interface Ctx {
  originalSize: number;
  inputFormat: ImageFormat;
  outFormat: ImageFormat;
  formatUnchanged: boolean;
}

function finalize(
  result: { data: Buffer; width: number; height: number; quality: number },
  original: Buffer,
  ctx: Ctx,
  resized: boolean,
): CompressResult {
  const compressedSize = result.data.length;

  // TinyPNG rule: never hand back a bigger file. Only safe to fall back to the
  // original when format is unchanged and we didn't resize.
  if (ctx.formatUnchanged && !resized && compressedSize >= ctx.originalSize) {
    return {
      data: original,
      format: ctx.inputFormat,
      originalSize: ctx.originalSize,
      compressedSize: ctx.originalSize,
      ratio: 0,
      width: result.width,
      height: result.height,
      skipped: true,
      quality: result.quality,
    };
  }

  return {
    data: result.data,
    format: ctx.outFormat,
    originalSize: ctx.originalSize,
    compressedSize,
    ratio: 1 - compressedSize / ctx.originalSize,
    width: result.width,
    height: result.height,
    skipped: false,
    quality: result.quality,
  };
}

/**
 * Compress a single image while preserving perceptual quality.
 *
 * Returns the compressed bytes in `data` (the engine does no file I/O so it can
 * be shared by the CLI, the AI skill, and a server). See {@link CompressOptions}.
 */
export async function compress(
  input: Input,
  options: CompressOptions = {},
): Promise<CompressResult> {
  const buf = await toBuffer(input);
  const originalSize = buf.length;

  const meta = await sharp(buf, { failOn: "none" }).metadata();
  const detected = detectFormat(meta.format);
  const requested =
    options.format && options.format !== "keep" ? options.format : detected;
  if (!requested) {
    throw new Error(
      `Unsupported input format "${meta.format ?? "unknown"}". ` +
        `Pass options.format to convert it explicitly.`,
    );
  }

  const outFormat = requested;
  const inputFormat = detected ?? outFormat;
  const animated = (meta.pages ?? 1) > 1;
  const resized = Boolean(options.maxWidth || options.maxHeight);
  const stripMetadata = options.stripMetadata ?? true;
  const mode = options.mode ?? "lossy";
  const ctx: Ctx = {
    originalSize,
    inputFormat,
    outFormat,
    // Only "unchanged" when the input format was actually recognized AND equals
    // the output. Otherwise (e.g. an undecoded gif/tiff being converted) the
    // never-larger fallback must not emit the original bytes under a new ext.
    formatUnchanged: detected != null && outFormat === detected,
  };

  const encodeOpts = (quality: number): EncodeOpts => ({
    quality,
    mode,
    effort: options.effort,
    stripMetadata,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    animated,
  });

  let chosen: { data: Buffer; width: number; height: number; quality: number };

  // ---- Smart mode: search for the smallest output meeting a SSIM target ----
  if (options.targetSsim != null && mode === "lossy") {
    const target = options.targetSsim;
    const lo = options.minQuality ?? 40;
    const hi = options.maxQuality ?? 95;

    const ref = await toLuma(buf);
    const measure = async (data: Buffer) => {
      const cand = await toLuma(data, { width: ref.width, height: ref.height });
      return ssim(ref.data, cand.data, ref.width, ref.height);
    };

    // SSIM rises ~monotonically with quality: binary-search the lowest quality
    // that still clears the target, then keep that (smallest) result. oxipng is
    // applied once at the end (it's lossless, so it can't change the SSIM).
    let best: { data: Buffer; width: number; height: number; quality: number } | null =
      null;
    let l = lo;
    let r = hi;
    while (l <= r) {
      const mid = (l + r) >> 1;
      const enc = await encode(buf, outFormat, encodeOpts(mid));
      if ((await measure(enc.data)) >= target) {
        best = { ...enc, quality: mid };
        r = mid - 1;
      } else {
        l = mid + 1;
      }
    }
    if (!best) {
      const enc = await encode(buf, outFormat, encodeOpts(hi));
      best = { ...enc, quality: hi };
    }
    chosen = best;
  } else {
    // ---- Fixed-quality mode ----
    const quality = options.quality ?? DEFAULT_QUALITY[outFormat];
    const enc = await encode(buf, outFormat, encodeOpts(quality));
    chosen = { ...enc, quality };
  }

  // ---- Lossless PNG post-pass (pixels unchanged) ----
  if (outFormat === "png" && (options.pngOptimize ?? true)) {
    try {
      const optimised = await oxipng(chosen.data, { level: options.oxipngLevel });
      if (optimised.length < chosen.data.length) chosen.data = optimised;
    } catch {
      // oxipng unavailable/failed — keep sharp's output.
    }
  }

  return finalize(chosen, buf, ctx, resized);
}
