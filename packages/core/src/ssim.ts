/**
 * Mean Structural Similarity (SSIM) over non-overlapping windows of a single
 * channel (luma). Returns 1.0 for identical images, lower for more distortion.
 *
 * This is a fast, dependency-free approximation of Wang et al. (2004) used to
 * (a) drive the smart "target-SSIM" compression mode and (b) measure quality in
 * the benchmark. Both buffers must be the same width*height, one byte/pixel.
 */
export function ssim(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  windowSize = 8,
): number {
  const L = 255;
  const C1 = (0.01 * L) ** 2;
  const C2 = (0.03 * L) ** 2;
  const n = windowSize * windowSize;

  let total = 0;
  let windows = 0;

  for (let y = 0; y + windowSize <= height; y += windowSize) {
    for (let x = 0; x + windowSize <= width; x += windowSize) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;

      for (let j = 0; j < windowSize; j++) {
        const row = (y + j) * width + x;
        for (let i = 0; i < windowSize; i++) {
          const va = a[row + i];
          const vb = b[row + i];
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }

      const muA = sumA / n;
      const muB = sumB / n;
      const varA = sumAA / n - muA * muA;
      const varB = sumBB / n - muB * muB;
      const covAB = sumAB / n - muA * muB;

      const s =
        ((2 * muA * muB + C1) * (2 * covAB + C2)) /
        ((muA * muA + muB * muB + C1) * (varA + varB + C2));

      total += s;
      windows++;
    }
  }

  return windows > 0 ? total / windows : 1;
}
