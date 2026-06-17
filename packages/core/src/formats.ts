import type { ImageFormat } from "./types.js";

/** Formats we can decode (sharp reads more, but these are first-class). */
export const INPUT_FORMATS = [
  "jpeg",
  "png",
  "webp",
  "avif",
  "gif",
  "tiff",
] as const;

/** Formats we can encode to. */
export const OUTPUT_FORMATS: ImageFormat[] = ["jpeg", "png", "webp", "avif"];

/** Tuned visually-lossless defaults (validated by the benchmark). */
export const DEFAULT_QUALITY: Record<ImageFormat, number> = {
  jpeg: 78,
  png: 80, // libimagequant target quality for palette quantization
  webp: 80,
  avif: 55,
};

/**
 * Normalize sharp's reported format string to one of our output formats,
 * or null if it isn't directly re-encodable (caller must specify a target).
 */
export function detectFormat(raw?: string): ImageFormat | null {
  switch (raw) {
    case "jpeg":
    case "jpg":
      return "jpeg";
    case "png":
      return "png";
    case "webp":
      return "webp";
    case "avif":
    case "heif":
    case "heic":
      return "avif";
    default:
      return null;
  }
}

/** Map a file extension to an output format (used by the CLI/skill). */
export function formatFromExtension(ext: string): ImageFormat | null {
  return detectFormat(ext.replace(/^\./, "").toLowerCase());
}

/** Canonical file extension for an output format. */
export function extensionForFormat(format: ImageFormat): string {
  return format === "jpeg" ? ".jpg" : `.${format}`;
}
