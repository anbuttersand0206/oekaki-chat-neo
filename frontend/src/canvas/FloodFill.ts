// Scanline flood fill with tolerance

function colorDist(
  data: Uint8ClampedArray,
  idx: number,
  r: number, g: number, b: number, a: number
): number {
  const dr = data[idx] - r;
  const dg = data[idx + 1] - g;
  const db = data[idx + 2] - b;
  const da = data[idx + 3] - a;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
}

export function floodFill(
  imageData: ImageData,
  startX: number,
  startY: number,
  fillR: number, fillG: number, fillB: number,
  tolerance: number
): void {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;

  const sx = Math.round(startX);
  const sy = Math.round(startY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

  const startIdx = (sy * w + sx) * 4;
  const seedR = data[startIdx];
  const seedG = data[startIdx + 1];
  const seedB = data[startIdx + 2];
  const seedA = data[startIdx + 3];

  // If click on same color skip
  if (
    Math.abs(seedR - fillR) <= 2 &&
    Math.abs(seedG - fillG) <= 2 &&
    Math.abs(seedB - fillB) <= 2 &&
    seedA === 255
  ) return;

  const visited = new Uint8Array(w * h);
  const stack: number[] = [sx + sy * w];
  visited[sx + sy * w] = 1;

  while (stack.length > 0) {
    const pos = stack.pop()!;
    const px = pos % w;
    const py = (pos - px) / w;
    const idx = pos * 4;

    const dist = colorDist(data, idx, seedR, seedG, seedB, seedA);
    if (dist > tolerance) continue;

    data[idx]     = fillR;
    data[idx + 1] = fillG;
    data[idx + 2] = fillB;
    data[idx + 3] = 255;

    const neighbors = [
      px > 0     ? pos - 1 : -1,
      px < w - 1 ? pos + 1 : -1,
      py > 0     ? pos - w : -1,
      py < h - 1 ? pos + w : -1
    ];

    for (const n of neighbors) {
      if (n >= 0 && !visited[n]) {
        visited[n] = 1;
        stack.push(n);
      }
    }
  }
}
