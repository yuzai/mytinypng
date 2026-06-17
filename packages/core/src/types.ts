/** Output container formats the engine can encode to. */
export type ImageFormat = "jpeg" | "png" | "webp" | "avif";

/** Lossy (default, visually-lossless) or strict lossless. */
export type CompressMode = "lossy" | "lossless";

export interface CompressOptions {
  /**
   * Output format. "keep" (default) re-encodes in the input's own format.
   * Set explicitly to convert (e.g. png -> webp).
   */
  format?: ImageFormat | "keep";

  /** lossy (default) or lossless. */
  mode?: CompressMode;

  /**
   * Target quality 1..100 (higher = better/larger). Ignored when `targetSsim`
   * is set. Defaults are tuned per-format (see DEFAULT_QUALITY).
   */
  quality?: number;

  /**
   * Smart mode: instead of a fixed quality, search for the smallest output
   * whose structural similarity (SSIM) to the original stays >= this value
   * (e.g. 0.985). This is the per-image adaptive mode closest to TinyPNG.
   */
  targetSsim?: number;

  /** Lower bound for the smart-mode quality search. Default 40. */
  minQuality?: number;
  /** Upper bound for the smart-mode quality search. Default 95. */
  maxQuality?: number;

  /**
   * Strip EXIF/XMP metadata to save bytes. The ICC color profile is always
   * preserved and EXIF orientation is baked into the pixels. Default true.
   */
  stripMetadata?: boolean;

  /** Optional max width — never enlarges; preserves aspect ratio. */
  maxWidth?: number;
  /** Optional max height — never enlarges; preserves aspect ratio. */
  maxHeight?: number;

  /** Encoder effort (cpu vs. size). Format-specific default if omitted. */
  effort?: number;

  /**
   * Run a lossless oxipng pass on PNG output (pixels unchanged, a few % smaller
   * — this is what matches TinyPNG's PNG size). Default true. Adds CPU time on
   * large images; turn off for speed.
   */
  pngOptimize?: boolean;
  /** oxipng level 1..6 (higher = smaller + slower). Default 3. */
  oxipngLevel?: number;
}

export interface CompressResult {
  /** The compressed bytes (or the original bytes if `skipped`). */
  data: Buffer;
  /** Container format of `data`. */
  format: ImageFormat;
  originalSize: number;
  compressedSize: number;
  /** Bytes-saved fraction, 0..1 (0 when skipped). */
  ratio: number;
  width: number;
  height: number;
  /**
   * True when compression did not beat the original (same format, no resize),
   * so the original bytes are returned unchanged — TinyPNG never grows a file.
   */
  skipped: boolean;
  /** The quality actually used (resolved default, or chosen by smart mode). */
  quality: number;
}
