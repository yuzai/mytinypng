export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function savedPct(original: number, compressed: number): number {
  return original > 0 ? Math.round((1 - compressed / original) * 100) : 0;
}
