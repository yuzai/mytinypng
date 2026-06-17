/// <reference lib="webworker" />
import { encode as encodeJpeg } from "@jsquash/jpeg";
import { optimise as oxipng } from "@jsquash/oxipng";
import { encode as encodePng } from "@jsquash/png";
import { encode as encodeWebp } from "@jsquash/webp";
import { applyPaletteSync, buildPaletteSync, utils } from "image-q";
import type { CompressRequest, CompressResponse } from "./types";

// Mirrors the @mytinypng/core defaults (validated against TinyPNG).
const DEFAULT_QUALITY = { jpeg: 78, webp: 80, png: 80 } as const;

type BaseFormat = "jpeg" | "png" | "webp";

function detectFormat(type: string): BaseFormat {
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  return "jpeg";
}

function outName(name: string, target: BaseFormat, converted: boolean): string {
  if (!converted) return name; // keep the original name so it can drop-in replace
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${target === "jpeg" ? "jpg" : target}`;
}

async function toImageData(buffer: ArrayBuffer, type: string): Promise<ImageData> {
  const bitmap = await createImageBitmap(new Blob([buffer], { type }), {
    imageOrientation: "from-image", // bake EXIF orientation in
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable in worker");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * PNG path that mirrors the core engine in the browser: reduce to a ≤256-color
 * palette (image-q, like libimagequant), encode, then oxipng losslessly (it
 * also reduces the RGBA encoding down to an indexed-color PNG).
 */
async function encodePngQuantized(image: ImageData, colors = 256): Promise<ArrayBuffer> {
  const inPC = utils.PointContainer.fromUint8Array(image.data, image.width, image.height);
  const palette = buildPaletteSync([inPC], {
    colors,
    paletteQuantization: "wuquant",
    colorDistanceFormula: "euclidean",
  });
  const outPC = applyPaletteSync(inPC, palette, {
    imageQuantization: "floyd-steinberg",
    colorDistanceFormula: "euclidean",
  });
  const reduced = new ImageData(
    new Uint8ClampedArray(outPC.toUint8Array()),
    image.width,
    image.height,
  );
  const png = await encodePng(reduced);
  return oxipng(png, { level: 3, optimiseAlpha: true });
}

self.onmessage = async (e: MessageEvent<CompressRequest>) => {
  const req = e.data;
  try {
    const image = await toImageData(req.buffer, req.type);
    const inFmt = detectFormat(req.type);
    const target = req.settings.format === "keep" ? inFmt : req.settings.format;
    const q = req.settings.quality ?? DEFAULT_QUALITY[target];

    let out: ArrayBuffer;
    let outType: string;
    if (target === "jpeg") {
      out = await encodeJpeg(image, { quality: q });
      outType = "image/jpeg";
    } else if (target === "webp") {
      out = await encodeWebp(image, { quality: q });
      outType = "image/webp";
    } else {
      out = await encodePngQuantized(image);
      outType = "image/png";
    }

    // Never hand back a larger file (only safe when the format is unchanged).
    const skipped = target === inFmt && out.byteLength >= req.buffer.byteLength;
    const finalBuf = skipped ? req.buffer : out;

    const res: CompressResponse = {
      id: req.id,
      ok: true,
      name: outName(req.name, target, req.settings.format !== "keep"),
      outType: skipped ? req.type : outType,
      buffer: finalBuf,
      originalSize: req.buffer.byteLength,
      compressedSize: finalBuf.byteLength,
      skipped,
    };
    self.postMessage(res, [finalBuf]);
  } catch (err) {
    const res: CompressResponse = {
      id: req.id,
      ok: false,
      name: req.name,
      outType: req.type,
      originalSize: req.buffer.byteLength,
      compressedSize: 0,
      skipped: false,
      error: (err as Error)?.message ?? String(err),
    };
    self.postMessage(res);
  }
};
