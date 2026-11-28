import { PageSizes, PDFDocument } from 'pdf-lib';

export async function createScanPdf(
  count: number,
  title: string,
  render: (index: number) => Promise<Blob>,
  onProgress: (finished: number) => void,
) {
  if (!count) throw new Error('PDF için en az bir sayfa ekleyin.');
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setLanguage('tr');
  const [width, height] = PageSizes.A4;
  const margin = 9;
  for (let index = 0; index < count; index++) {
    const image = await pdf.embedJpg(await (await render(index)).arrayBuffer());
    const scale = Math.min((width - 2 * margin) / image.width, (height - 2 * margin) / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    pdf.addPage(PageSizes.A4).drawImage(image, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
    onProgress(index + 1);
  }
  const bytes = await pdf.save();
  return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
}
