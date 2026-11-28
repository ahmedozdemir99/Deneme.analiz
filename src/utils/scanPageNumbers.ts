import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import corePath from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import workerPath from 'tesseract.js/dist/worker.min.js?url';
import englishData from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import { makeCanvas } from './examScan';

async function startReader() {
  const langPath = englishData.slice(0, englishData.lastIndexOf('/'));
  let timeout = 0;
  let expired = false;
  const fail = new Promise<Worker>((_, reject) => {
    timeout = window.setTimeout(() => {
      expired = true;
      reject(new Error('Sayfa numarası okuyucusu başlatılamadı. Tekrar deneyebilir veya numaraları elle girebilirsiniz.'));
    }, 20_000);
  });
  const startup = createWorker('eng', OEM.LSTM_ONLY, {
    workerPath, corePath, langPath, workerBlobURL: false,
    errorHandler: () => {},
  }).then(worker => {
    if (expired) void worker.terminate();
    return worker;
  });
  try {
    return await Promise.race([startup, fail]);
  } finally {
    window.clearTimeout(timeout);
  }
}

function prepareFooter(page: HTMLCanvasElement) {
  const footer = makeCanvas(page.width * .32, page.height * .12);
  const ctx = footer.getContext('2d')!;
  ctx.drawImage(page, page.width * .34, page.height - footer.height, footer.width, footer.height,
    0, 0, footer.width, footer.height);
  const { width, height } = footer;
  const pixels = ctx.getImageData(0, 0, width, height);
  let baseline = -1;
  let bestScore = width * .12;
  for (let y = 0; y < height; y++) {
    let leftInk = 0, rightInk = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]];
      if (r - g < 17 || g - b < 7) continue;
      if (x < width * .43) leftInk++;
      if (x > width * .57) rightInk++;
    }
    const score = Math.min(leftInk, rightInk);
    if (score > bestScore) {
      bestScore = score;
      baseline = y;
    }
  }

  for (let i = 0; i < pixels.data.length; i += 4) {
    const r = pixels.data[i], g = pixels.data[i + 1], b = pixels.data[i + 2];
    const ink = Math.max(r, g, b) - Math.min(r, g, b) < 40 && (r + g + b) / 3 < 139;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = ink ? 0 : 255;
  }
  ctx.putImageData(pixels, 0, 0);

  const fromX = Math.round(width * .25);
  const fromY = baseline < 0 ? 0 : Math.max(0, baseline - Math.round(page.height * .024));
  const toY = baseline < 0 ? height : Math.min(height, baseline + Math.round(page.height * .024));
  const cropWidth = width - fromX * 2;
  const cropHeight = toY - fromY;
  const crop = makeCanvas(cropWidth * 2 + 24, cropHeight * 2 + 24);
  const cropCtx = crop.getContext('2d')!;
  cropCtx.fillStyle = 'white';
  cropCtx.fillRect(0, 0, crop.width, crop.height);
  cropCtx.drawImage(footer, fromX, fromY, cropWidth, cropHeight, 12, 12, cropWidth * 2, cropHeight * 2);
  return crop;
}

function isolateInk(footer: HTMLCanvasElement) {
  const { width, height } = footer;
  const ctx = footer.getContext('2d', { willReadFrequently: true })!;
  const pixels = ctx.getImageData(0, 0, width, height);
  const visited = new Uint8Array(width * height);
  const minimum = Math.max(12, Math.round(width * height * .0004));
  let left = width, top = height, right = -1, bottom = -1;
  const components: number[][] = [];
  const columns = new Uint16Array(width);
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || pixels.data[start * 4] >= 150) continue;
    const component = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const i = component[cursor], x = i % width;
      for (const neighbor of [i - width, i + width, x ? i - 1 : -1, x < width - 1 ? i + 1 : -1]) {
        if (neighbor < 0 || neighbor >= visited.length || visited[neighbor] || pixels.data[4 * neighbor] >= 150) continue;
        component.push(neighbor);
        visited[neighbor] = 1;
      }
    }
    components.push(component);
  }
  const largest = components.reduce((size, component) => Math.max(size, component.length), 0);
  for (const component of components) {
    if (component.length < Math.max(minimum, largest * .14)) {
      for (const i of component) pixels.data.set([255, 255, 255, 255], 4 * i);
      continue;
    }
    for (const i of component) {
      const x = i % width, y = Math.floor(i / width);
      columns[x]++;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom - top < 15 || right - left > (bottom - top + 1) * 4) return null;
  let minDigits = 0;
  for (let x = left; x <= right; x++) {
    if (columns[x] && (x === left || !columns[x - 1])) minDigits++;
  }
  if (minDigits > 3) return null;
  const margin = 16;
  const tight = makeCanvas(right - left + 1 + margin * 2, bottom - top + 1 + margin * 2);
  const output = tight.getContext('2d')!;
  output.fillStyle = 'white';
  output.fillRect(0, 0, tight.width, tight.height);
  output.putImageData(pixels, margin - left, margin - top, left, top, right - left + 1, bottom - top + 1);
  return { canvas: tight, minDigits };
}

async function recognizeNumber(worker: Worker, canvas: HTMLCanvasElement, layout: PSM, minDigits: number) {
  await worker.setParameters({ tessedit_pageseg_mode: layout });
  const { data } = await worker.recognize(canvas);
  const match = /^[-–\s]*(\d{1,3})[-–\s]*$/.exec(data.text.trim());
  return match && match[1].length >= minDigits && Number(match[1]) > 0 && data.confidence >= 75 ? Number(match[1]) : null;
}

export async function readPageNumbers(
  count: number,
  render: (index: number) => Promise<HTMLCanvasElement>,
  onResult: (index: number, number: number | null) => void,
) {
  const worker = await startReader();
  try {
    await worker.setParameters({ tessedit_char_whitelist: '0123456789', user_defined_dpi: '220' });
    for (let index = 0; index < count; index++) {
      const page = await render(index);
      try {
        const footer = prepareFooter(page);
        const tight = isolateInk(footer);
        if (!tight) {
          onResult(index, null);
          continue;
        }
        const number = await recognizeNumber(worker, tight.canvas, PSM.SINGLE_LINE, tight.minDigits)
          ?? await recognizeNumber(worker, tight.canvas, PSM.RAW_LINE, tight.minDigits)
          ?? await recognizeNumber(worker, footer, PSM.SINGLE_LINE, tight.minDigits);
        onResult(index, number);
      } finally {
        page.width = page.height = 1;
      }
    }
  } finally {
    await worker.terminate();
  }
}
