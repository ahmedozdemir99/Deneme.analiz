export type Point = { x: number; y: number };
export type Corners = [Point, Point, Point, Point];
export type Region = { x: number; y: number; width: number; height: number };
export type Rotation = 0 | 90 | 180 | 270;
export type ScanMode = 'auto' | 'single' | 'spread';
export type Adjustments = { light: number; contrast: number; sharpness: number };

export const DEFAULT_ADJUSTMENTS: Adjustments = { light: 28, contrast: 12, sharpness: 22 };
export const WHOLE: Region = { x: 0, y: 0, width: 1, height: 1 };
export const FULL_CORNERS: Corners = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
];

const clamp = (n: number, max = 1) => Math.min(max, Math.max(0, n));
const luma = (data: Uint8ClampedArray, i: number) => .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];

export function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error('Tarayıcı görsel işlemeyi desteklemiyor.');
  return ctx;
}

export async function photoCanvas(file: File, rotation: Rotation, region: Region, maxEdge = 3200) {
  const bitmap = await createImageBitmap(file);
  try {
    const sideways = rotation === 90 || rotation === 270;
    const width = sideways ? bitmap.height : bitmap.width;
    const height = sideways ? bitmap.width : bitmap.height;
    const scale = Math.min(1, maxEdge / Math.max(width * region.width, height * region.height),
      Math.sqrt(5_000_000 / (width * height * region.width * region.height)));
    const canvas = makeCanvas(width * region.width * scale, height * region.height * scale);
    const ctx = context(canvas);
    ctx.scale(canvas.width / (width * region.width), canvas.height / (height * region.height));
    ctx.translate(width * (.5 - region.x), height * (.5 - region.y));
    ctx.rotate(rotation * Math.PI / 180);
    ctx.fillStyle = 'white';
    ctx.fillRect(-bitmap.width / 2, -bitmap.height / 2, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    return canvas;
  } finally {
    bitmap.close();
  }
}

export function splitRegions(canvas: HTMLCanvasElement): [Region, Region] {
  const { width, height } = canvas;
  const { data } = context(canvas).getImageData(0, 0, width, height);
  let bestScore = Infinity;
  let seam = width * .5;
  for (let x = Math.round(width * .43); x <= width * .57; x++) {
    let darkness = 0;
    for (let y = Math.floor(height * .12); y < height * .9; y += 3) {
      const index = (y * width + x) * 4;
      darkness += luma(data, index);
    }
    const score = darkness / height + 160 * Math.abs(x / width - .5);
    if (score < bestScore) {
      seam = x;
      bestScore = score;
    }
  }
  const cut = seam / width;
  return [{ ...WHOLE, width: cut }, { ...WHOLE, x: cut, width: 1 - cut }];
}

function fitLine(points: Point[]) {
  function fit(samples: Point[]) {
    const meanX = samples.reduce((sum, p) => sum + p.x, 0) / samples.length;
    const meanY = samples.reduce((sum, p) => sum + p.y, 0) / samples.length;
    const spread = samples.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
    const slope = spread > 0 ? samples.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0) / spread : 0;
    return { slope, offset: meanY - slope * meanX };
  }
  if (points.length < 8) return null;
  const first = fit(points);
  const ranked = points.map(p => ({ p, error: Math.abs(p.y - first.offset - first.slope * p.x) }))
    .sort((a, b) => a.error - b.error);
  return fit(ranked.slice(0, Math.ceil(ranked.length * .78)).map(entry => entry.p));
}

export function validCorners(corners: Corners) {
  return corners.every((a, index) => {
    const b = corners[(index + 1) % 4];
    const c = corners[(index + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) > .016;
  });
}

export function detectCorners(canvas: HTMLCanvasElement): Corners {
  const { width, height } = canvas;
  const { data } = context(canvas).getImageData(0, 0, width, height);
  const center: number[] = [];
  for (let y = Math.ceil(height * .34); y < height * .72; y += 3) {
    for (let x = Math.ceil(width * .26); x < width * .74; x += 3) center.push(luma(data, (y * width + x) * 4));
  }
  if (center.length < 4) return FULL_CORNERS;
  center.sort((a, b) => a - b);
  const cutoff = Math.max(84, center[Math.floor(center.length * .67)] - 37);
  const paper = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return luma(data, i) > cutoff && Math.max(r, g, b) - Math.min(r, g, b) < 54;
  };

  function trace(length: number, depth: number, horizontal: boolean, reverse: boolean) {
    const points: Point[] = [];
    for (let along = Math.floor(length * .15); along < length * .85; along += 2) {
      let run = 0;
      for (let inset = 0; inset < depth * .29; inset++) {
        const cross = reverse ? depth - 1 - inset : inset;
        run = (horizontal ? paper(along, cross) : paper(cross, along)) ? run + 1 : 0;
        if (run === 5) {
          points.push({ x: along, y: reverse ? cross + 4 : cross - 4 });
          break;
        }
      }
    }
    return fitLine(points);
  }

  const top = trace(width, height, true, false) ?? { offset: 0, slope: 0 };
  const bottom = trace(width, height, true, true) ?? { offset: height - 1, slope: 0 };
  const left = trace(height, width, false, false) ?? { offset: 0, slope: 0 };
  const right = trace(height, width, false, true) ?? { offset: width - 1, slope: 0 };
  const corner = (row: typeof top, column: typeof left) => {
    const denominator = 1 - row.slope * column.slope;
    const x = (column.offset + column.slope * row.offset) / denominator;
    return { x: clamp(x / (width - 1)), y: clamp((row.offset + row.slope * x) / (height - 1)) };
  };
  const result: Corners = [corner(top, left), corner(top, right), corner(bottom, right), corner(bottom, left)];
  const content = result.every(({ x, y }, index) => Math.abs(x - FULL_CORNERS[index].x) < .24 &&
    Math.abs(y - FULL_CORNERS[index].y) < .22);
  return content && validCorners(result) ? result : FULL_CORNERS;
}

export function straighten(source: HTMLCanvasElement, corners: Corners) {
  const distance = (a: Point, b: Point) => Math.hypot((a.x - b.x) * source.width, (a.y - b.y) * source.height);
  const [a, b, c, d] = corners;
  const output = makeCanvas(Math.max(distance(a, b), distance(d, c)),
    Math.max(distance(a, d), distance(b, c)));
  const inputCtx = context(source);
  const outputCtx = context(output);
  if (corners.every((p, i) => p.x === FULL_CORNERS[i].x && p.y === FULL_CORNERS[i].y)) {
    outputCtx.drawImage(source, 0, 0);
    return output;
  }
  const sourceData = inputCtx.getImageData(0, 0, source.width, source.height).data;
  const image = outputCtx.createImageData(output.width, output.height);
  const dx = b.x - c.x, dy = b.y - c.y;
  const ex = d.x - c.x, ey = d.y - c.y;
  const fx = a.x - b.x + c.x - d.x, fy = a.y - b.y + c.y - d.y;
  const determinant = dx * ey - ex * dy;
  const g = (fx * ey - ex * fy) / determinant;
  const h = (dx * fy - fx * dy) / determinant;
  const ax = b.x * (1 + g) - a.x, ay = b.y * (1 + g) - a.y;
  const bx = d.x * (1 + h) - a.x, by = d.y * (1 + h) - a.y;
  for (let y = 0, out = 0; y < output.height; y++) {
    const v = (y + .5) / output.height;
    for (let x = 0; x < output.width; x++, out += 4) {
      const u = (x + .5) / output.width;
      const w = g * u + h * v + 1;
      const sx = clamp((ax * u + bx * v + a.x) / w) * (source.width - 1);
      const sy = clamp((ay * u + by * v + a.y) / w) * (source.height - 1);
      const ix = Math.floor(sx), iy = Math.floor(sy);
      const wx = sx - ix, wy = sy - iy;
      const stepX = ix < source.width - 1 ? 4 : 0;
      const stepY = iy < source.height - 1 ? source.width * 4 : 0;
      const base = (iy * source.width + ix) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const spot = base + channel;
        const upper = sourceData[spot] + wx * (sourceData[spot + stepX] - sourceData[spot]);
        const lower = sourceData[spot + stepY] + wx * (sourceData[spot + stepY + stepX] - sourceData[spot + stepY]);
        image.data[out + channel] = upper + wy * (lower - upper);
      }
      image.data[out + 3] = 255;
    }
  }
  outputCtx.putImageData(image, 0, 0);
  return output;
}

export function applyAdjustments(canvas: HTMLCanvasElement, settings: Adjustments) {
  if (!settings.light && !settings.contrast && !settings.sharpness) return;
  const { width, height } = canvas;
  const ctx = context(canvas);
  const image = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = luma(image.data, i * 4);

  // A heavily reduced copy estimates illumination without following individual letters.
  const sample = makeCanvas(18, Math.max(12, Math.min(30, 18 * height / width)));
  const sampleCtx = context(sample);
  sampleCtx.imageSmoothingQuality = 'high';
  sampleCtx.drawImage(canvas, 0, 0, sample.width, sample.height);
  const tones = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;
  const background = makeCanvas(width, height);
  const backCtx = context(background);
  const estimate = sampleCtx.createImageData(sample.width, sample.height);
  for (let y = 0; y < sample.height; y++) {
    for (let x = 0; x < sample.width; x++) {
      let local = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          local = Math.max(local, luma(tones, (clamp(y + dy, sample.height - 1) * sample.width +
            clamp(x + dx, sample.width - 1)) * 4));
        }
      }
      const i = (y * sample.width + x) * 4;
      estimate.data.set([local, local, local, 255], i);
    }
  }
  sampleCtx.putImageData(estimate, 0, 0);
  backCtx.drawImage(sample, 0, 0, width, height);
  const illumination = backCtx.getImageData(0, 0, width, height).data;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const p = 4 * i;
      const center = gray[i];
      const light = Math.min(75, Math.max(0, 237 - illumination[p])) * settings.light / 100;
      const neighbor = (gray[i - (x > 0 ? 1 : 0)] + gray[i + (x < width - 1 ? 1 : 0)] +
        gray[i - (y > 0 ? width : 0)] + gray[i + (y < height - 1 ? width : 0)]) / 4;
      const detail = Math.max(-26, Math.min(26, center - neighbor)) * settings.sharpness / 48;
      const contrast = (center + light - 154) * settings.contrast / 110;
      for (let channel = 0; channel < 3; channel++) image.data[p + channel] += light + detail + contrast;
    }
  }
  ctx.putImageData(image, 0, 0);
  background.width = background.height = 1;
}

export function canvasBlob(canvas: HTMLCanvasElement, quality = .94) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Görsel kaydedilemedi.')), 'image/jpeg', quality);
  });
}

export type Fingerprint = { values: number[]; edges: number[] };

export function fingerprint(canvas: HTMLCanvasElement): Fingerprint {
  const side = 24;
  const thumbnail = makeCanvas(side, side);
  const ctx = context(thumbnail);
  ctx.drawImage(canvas, 0, 0, side, side);
  const { data } = ctx.getImageData(0, 0, side, side);
  const values = Array.from({ length: side * side }, (_, i) => luma(data, i * 4));
  const sorted = [...values].sort((a, b) => a - b);
  const background = sorted[Math.floor(sorted.length * .78)];
  const edges = values.map((value, i) => Math.max(0, value - (values[i + 1] ?? value)));
  return { values: values.map(value => Math.max(0, background - value)), edges };
}

export function similar(a: Fingerprint, b: Fingerprint) {
  const difference = a.values.reduce((sum, value, i) => sum + Math.abs(value - b.values[i]), 0) / a.values.length;
  const structure = a.edges.reduce((sum, value, i) => sum + Math.abs(value - b.edges[i]), 0) / a.edges.length;
  const ink = Math.min(a.values.reduce((sum, v) => sum + v, 0), b.values.reduce((sum, v) => sum + v, 0));
  return ink > 1600 && difference < 3.6 && structure < 2.8;
}

export function rotateRegion(region: Region): Region {
  return { x: 1 - region.y - region.height, y: region.x, width: region.height, height: region.width };
}

export function rotateCorners([a, b, c, d]: Corners): Corners {
  return [d, a, b, c].map(p => ({ x: 1 - p.y, y: p.x })) as Corners;
}
