export type OutFormat = "keep" | "jpeg" | "png" | "webp";

export interface CompressSettings {
  format: OutFormat;
  /** 1..100; undefined → tuned per-format default. */
  quality?: number;
}

export interface CompressRequest {
  id: number;
  name: string;
  type: string;
  buffer: ArrayBuffer;
  settings: CompressSettings;
}

export interface CompressResponse {
  id: number;
  ok: boolean;
  name: string;
  outType: string;
  buffer?: ArrayBuffer;
  originalSize: number;
  compressedSize: number;
  /** True when compression couldn't beat the original, so it was kept as-is. */
  skipped: boolean;
  error?: string;
}
