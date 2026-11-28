import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, Camera, Download, ImagePlus, RotateCw, ScanLine, Split, Trash2, X } from 'lucide-react';
import {
  applyAdjustments, canvasBlob, DEFAULT_ADJUSTMENTS, detectCorners, fingerprint, FULL_CORNERS,
  photoCanvas, rotateCorners, rotateRegion, similar, splitRegions, straighten, validCorners, WHOLE,
  type Adjustments, type Corners, type Fingerprint, type Region, type Rotation, type ScanMode,
} from '../utils/examScan';

type ScanPage = {
  id: number;
  file: File;
  key: string;
  rotation: Rotation;
  region: Region;
  corners: Corners;
  adjustments: Adjustments;
  number: string;
  print: Fingerprint;
  reviewed?: boolean;
  thumbnail: Blob;
};
type PageSource = Pick<ScanPage, 'file' | 'key' | 'rotation' | 'region'>;
type Status = { error?: boolean; text: string };

const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40';
const iconButton = button + ' px-2.5';
const primary = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-40';
const atNextPaint = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));

function useBlobUrl(blob: Blob | null) {
  const [entry, setEntry] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setEntry({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return entry?.blob === blob ? entry?.url : undefined;
}

function Thumbnail({ page }: { page: ScanPage }) {
  const url = useBlobUrl(page.thumbnail);
  return <img src={url} alt="" className="h-14 w-11 shrink-0 rounded bg-white object-contain" />;
}

async function imageKey(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let first = 2166136261, second = 0;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 16777619);
    second = Math.imul(second, 31) + byte | 0;
  }
  return [bytes.length, first, second].join('-');
}

async function renderPage(page: ScanPage, edge: number, adjust = true) {
  const original = await photoCanvas(page.file, page.rotation, page.region, edge);
  try {
    const corrected = straighten(original, page.corners);
    if (adjust) applyAdjustments(corrected, page.adjustments);
    return corrected;
  } finally {
    original.width = original.height = 1;
  }
}

const cornerNames = ['Sol üst', 'Sağ üst', 'Sağ alt', 'Sol alt'];

function CropPreview({ page, onChange }: { page: ScanPage; onChange: (corners: Corners) => void }) {
  const [mode, setMode] = useState<'preview' | 'crop'>('preview');
  const [image, setImage] = useState<Blob | null>(null);
  const url = useBlobUrl(image);
  const { file, rotation, region } = page;
  const previewCorners = mode === 'preview' ? page.corners : null;
  const previewAdjustments = mode === 'preview' ? page.adjustments : null;
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(async () => {
      try {
        const original = await photoCanvas(file, rotation, region, 850);
        const canvas = previewCorners ? straighten(original, previewCorners) : original;
        if (previewAdjustments) applyAdjustments(canvas, previewAdjustments);
        const blob = await canvasBlob(canvas, .9);
        canvas.width = canvas.height = original.width = original.height = 1;
        if (current) setImage(blob);
      } catch {
        if (current) setImage(null);
      }
    }, mode === 'crop' ? 0 : 85);
    return () => { current = false; window.clearTimeout(timer); };
  }, [mode, file, rotation, region, previewCorners, previewAdjustments]);

  function move(index: number, x: number, y: number) {
    const corners = page.corners.map((point, i) => i === index
      ? { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) } : point) as Corners;
    if (validCorners(corners)) onChange(corners);
  }

  function onPointer(index: number, event: PointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = frame.current?.getBoundingClientRect();
    if (bounds) move(index, (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height);
  }

  function onKey(index: number, event: KeyboardEvent<HTMLButtonElement>) {
    const delta = event.shiftKey ? .04 : .01;
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta],
    };
    if (!offsets[event.key]) return;
    event.preventDefault();
    const [dx, dy] = offsets[event.key];
    move(index, page.corners[index].x + dx, page.corners[index].y + dy);
  }

  return <>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>PDF önizlemesi</button>
      <button type="button" className={button} aria-pressed={mode === 'crop'} onClick={() => setMode('crop')}>Kırpma köşeleri</button>
    </div>
    <div className="flex min-h-64 justify-center rounded-xl bg-slate-200 p-4">
      {url ? <div ref={frame} className="relative self-center">
        <img src={url} alt={mode === 'crop' ? 'Kırpılacak fotoğraf' : 'Düzeltilmiş deneme sayfası'} draggable={false}
          className="block max-h-[55dvh] max-w-full rounded-sm" />
        {mode === 'crop' && <>
          <div className="pointer-events-none absolute inset-0 bg-blue-500/15" style={{
            clipPath: 'polygon(' + page.corners.map(p => `${p.x * 100}% ${p.y * 100}%`).join(',') + ')',
          }} />
          {page.corners.map((point, index) => <button key={index} type="button" aria-label={cornerNames[index] + ' kırpma köşesi'}
            onKeyDown={event => onKey(index, event)}
            onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={event => onPointer(index, event)}
            className="absolute size-7 -translate-x-1/2 -translate-y-1/2 cursor-move touch-none rounded-full border-2 border-white bg-blue-700 shadow-md"
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />)}
        </>}
      </div> : <p className="self-center text-sm text-slate-600">Önizleme hazırlanıyor…</p>}
    </div>
  </>;
}

export function ExamScanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const next = useRef(1);
  const operation = useRef(false);
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [activeId, setActiveId] = useState<number>();
  const [mode, setMode] = useState<ScanMode>('auto');
  const [name, setName] = useState('Deneme kitapçığı');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<Status>();
  const active = pages.find(p => p.id === activeId) ?? pages[0];

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  const duplicates = useMemo(() => {
    const repeats = new Set<number>();
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      if (!page.reviewed && pages.slice(0, index).some(earlier => similar(page.print, earlier.print))) repeats.add(page.id);
    }
    return repeats;
  }, [pages]);
  const repeatedNumbers = pages.some((page, index) => page.number &&
    pages.slice(0, index).some(earlier => page.number === earlier.number));

  async function run(label: string, task: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(label);
    setStatus(undefined);
    try {
      await atNextPaint();
      await task();
    } catch (error) {
      setStatus({ error: true, text: error instanceof Error ? error.message : 'İşlem tamamlanamadı.' });
    } finally {
      operation.current = false;
      setBusy('');
    }
  }

  async function newPage(source: PageSource, number = '', id = next.current++): Promise<ScanPage> {
    const canvas = await photoCanvas(source.file, source.rotation, source.region, 530);
    const corners = detectCorners(canvas);
    const corrected = straighten(canvas, corners);
    const print = fingerprint(corrected);
    const thumb = await canvasBlob(corrected, .78);
    canvas.width = canvas.height = corrected.width = corrected.height = 1;
    return { ...source, id, corners, print, number, thumbnail: thumb, reviewed: false, adjustments: DEFAULT_ADJUSTMENTS };
  }

  function importFiles(files: File[]) {
    if (!files.length) return;
    void run('Fotoğraflar işleniyor…', async () => {
      const collator = new Intl.Collator('tr', { numeric: true });
      const selection = [...files].sort((a, b) => collator.compare(a.name, b.name));
      const seen = new Set(pages.map(page => page.key));
      const added: ScanPage[] = [];
      let exactMatches = 0;
      const failed: string[] = [];
      for (const [index, file] of selection.entries()) {
        setBusy(`Fotoğraflar işleniyor · ${index + 1}/${selection.length}`);
        try {
          const key = await imageKey(file);
          if (seen.has(key)) {
            exactMatches++;
            continue;
          }
          const probe = await photoCanvas(file, 0, WHOLE, 420);
          const isSpread = mode === 'spread' || (mode === 'auto' && probe.width / probe.height >= 1.24);
          const regions = isSpread ? splitRegions(probe) : [WHOLE];
          probe.width = probe.height = 1;
          const prepared: ScanPage[] = [];
          for (const region of regions) prepared.push(await newPage({ file, key, rotation: 0, region }));
          added.push(...prepared);
          seen.add(key);
        } catch {
          failed.push(file.name);
        }
      }
      setPages([...pages, ...added]);
      if (!active && added.length) setActiveId(added[0].id);
      const messages = [`${added.length} sayfa eklendi.`];
      if (exactMatches) messages.push(`${exactMatches} aynı fotoğraf bir kez kullanıldı.`);
      if (failed.length) messages.push(`Açılamayan dosyalar: ${failed.join(', ')}. JPEG, PNG veya WebP deneyin.`);
      setStatus({ text: messages.join(' '), error: failed.length > 0 });
    });
  }

  function update(id: number, fields: Partial<ScanPage>) {
    setPages(current => current.map(page => page.id === id ? { ...page, ...fields } : page));
  }

  function move(id: number, step: -1 | 1) {
    setPages(current => {
      const index = current.findIndex(page => page.id === id);
      const target = index + step;
      if (target < 0 || target >= current.length) return current;
      const order = [...current];
      [order[index], order[target]] = [order[target], order[index]];
      return order;
    });
  }

  function sortByNumber(items: ScanPage[]) {
    const numbered = items.filter(page => page.number).sort((a, b) => Number(a.number) - Number(b.number));
    let index = 0;
    return items.map(page => page.number ? numbered[index++] : page);
  }

  function readNumbers() {
    void run('Sayfa numaraları okunuyor…', async () => {
      const targets = pages.filter(page => !page.number);
      const numbers = new Map<number, number>();
      if (targets.length) {
        const { readPageNumbers } = await import('../utils/scanPageNumbers');
        await readPageNumbers(targets.length, index => renderPage(targets[index], 1500, false), (index, number) => {
          if (number !== null) numbers.set(targets[index].id, number);
          setBusy(`Sayfa numaraları okunuyor · ${index + 1}/${targets.length}`);
        });
      }
      const updated = pages.map(page => numbers.has(page.id) ? { ...page, number: String(numbers.get(page.id)) } : page);
      const frequencies = new Map<string, number>();
      for (const page of updated) {
        if (page.number) frequencies.set(page.number, (frequencies.get(page.number) ?? 0) + 1);
      }
      const safe = updated.map(page => numbers.has(page.id) && (frequencies.get(page.number) ?? 0) > 1
        ? { ...page, number: '' } : page);
      setPages(sortByNumber(safe));
      const missing = safe.filter(page => !page.number).length;
      const read = safe.filter(page => page.number && numbers.has(page.id)).length;
      setStatus({ text: missing
        ? `${read} numara okundu. Numarası okunamayan ${missing} sayfayı elle numaralandırabilir veya oklarla taşıyabilirsiniz.`
        : 'Sayfalar kitapçık numarasına göre sıralandı. Önizlemeden sırayı kontrol edin.' });
    });
  }

  function rotate(page: ScanPage) {
    void run('Sayfa döndürülüyor…', async () => {
      const rotation = ((page.rotation + 90) % 360) as Rotation;
      const region = rotateRegion(page.region);
      const corners = rotateCorners(page.corners);
      const corrected = await renderPage({ ...page, rotation, region, corners }, 410, false);
      const print = fingerprint(corrected);
      const thumbnail = await canvasBlob(corrected, .78);
      corrected.width = corrected.height = 1;
      update(page.id, { rotation, region, corners, print, thumbnail });
    });
  }

  function split(page: ScanPage) {
    void run('Çift sayfa ayrılıyor…', async () => {
      const source = await photoCanvas(page.file, page.rotation, page.region, 500);
      if (source.width <= source.height) throw new Error('Çift sayfalı çekimi önce yatay konuma döndürün.');
      const regions = splitRegions(source);
      source.width = source.height = 1;
      const children: ScanPage[] = [];
      for (const half of regions) {
        const region = { ...page.region, x: page.region.x + half.x * page.region.width,
          width: half.width * page.region.width };
        children.push(await newPage({ file: page.file, key: page.key, rotation: page.rotation, region }));
      }
      setPages(current => current.flatMap(item => item.id === page.id ? children : [item]));
      setActiveId(children[0].id);
    });
  }

  function download() {
    void run('PDF hazırlanıyor…', async () => {
      if (!pages.length) return;
      if (repeatedNumbers) throw new Error('Aynı kitapçık numarasına sahip sayfaları kaldırın veya numaralarını düzeltin.');
      if (duplicates.size) throw new Error('İşaretli tekrarları kaldırın veya farklı sayfa olarak onaylayın.');
      const { createScanPdf } = await import('../utils/scanPdf');
      const title = name.trim() || 'Deneme kitapçığı';
      const file = await createScanPdf(pages.length, title, async index => {
        const canvas = await renderPage(pages[index], 3200);
        try {
          return await canvasBlob(canvas);
        } finally {
          canvas.width = canvas.height = 1;
        }
      }, finished => setBusy(`PDF hazırlanıyor · ${finished}/${pages.length}`));
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.pdf$/i, '') + '.pdf';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus({ text: `${pages.length} sayfalık PDF hazır. İndirme başlatıldı.` });
    });
  }

  return (
    <dialog ref={dialog} aria-labelledby="exam-scan-title" onCancel={event => {
      event.preventDefault();
      if (!operation.current) onClose();
    }} className="m-auto max-h-[94dvh] w-[min(96vw,72rem)] max-w-none overflow-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/55">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <ScanLine className="size-5 text-blue-700" />
          <h2 id="exam-scan-title" className="text-base font-extrabold">Fotoğraftan PDF</h2>
        </div>
        <button type="button" aria-label="Taramayı kapat" disabled={!!busy} className={iconButton} onClick={onClose}><X className="size-4" /></button>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-2">
          <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={event => {
            importFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = '';
          }} />
          <input ref={gallery} type="file" accept="image/*" multiple className="hidden" onChange={event => {
            importFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = '';
          }} />
          <button type="button" className={primary} disabled={!!busy} onClick={() => camera.current?.click()}><Camera className="size-4" /> Fotoğraf çek</button>
          <button type="button" className={button} disabled={!!busy} onClick={() => gallery.current?.click()}><ImagePlus className="size-4" /> Fotoğraf ekle</button>
          <label className="ml-1 flex flex-col gap-1 text-xs font-medium">
            Çekim türü
            <select className="min-h-10 rounded-lg border border-slate-200 bg-white px-2" value={mode} disabled={!!busy} onChange={event => setMode(event.target.value as ScanMode)}>
              <option value="auto">Otomatik</option>
              <option value="single">Tek sayfa</option>
              <option value="spread">Çift sayfa</option>
            </select>
          </label>
        </div>
        {busy && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{busy}</p>}
        {status && <p role={status.error ? 'alert' : 'status'} className={`rounded-lg p-3 text-sm ${status.error ? 'bg-red-50 text-red-800' : 'bg-slate-100 text-slate-700'}`}>{status.text}</p>}
        {!active ? <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
          Deneme sayfalarını kamerayla çekin veya galeriden seçin. Fotoğraflar cihazınızda işlenir.
        </div> : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(17rem,21rem)_1fr]">
            <section className="space-y-3" aria-label="PDF sayfa sırası">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="mr-auto text-sm">{pages.length} sayfa</strong>
                <button type="button" className={button} disabled={!!busy} onClick={readNumbers}>Numaraları oku ve sırala</button>
                <button type="button" className={button} disabled={!!busy || !pages.some(page => page.number)}
                  onClick={() => setPages(sortByNumber(pages))}>Girilen numaralara göre sırala</button>
              </div>
              {repeatedNumbers && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-950">
                Aynı kitapçık numarası birden fazla sayfada var. Numarayı düzeltin veya tekrar olan sayfayı kaldırın.
              </p>}
              {duplicates.size > 0 && <div className="space-y-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-950">
                <p>{duplicates.size} olası tekrar. İndirmeden önce işaretli sayfaları kontrol edin.</p>
                <button type="button" className={button} disabled={!!busy} onClick={() => {
                  setPages(pages.filter(page => !duplicates.has(page.id)));
                  setStatus({ text: `${duplicates.size} işaretli sayfa kaldırıldı.` });
                }}>İşaretli tekrarları kaldır</button>
                {duplicates.has(active.id) &&
                  <button type="button" className={button} disabled={!!busy} onClick={() => update(active.id, { reviewed: true })}>Seçili sayfa farklı</button>}
              </div>}
              <ol className="max-h-64 space-y-1 overflow-auto rounded-lg border border-slate-200 p-2 lg:max-h-[56dvh]">
                {pages.map((page, index) => <li key={page.id} className={`flex items-center gap-1 rounded-lg p-1 ${active.id === page.id ? 'bg-blue-50' : 'bg-slate-50'}`}>
                  <button type="button" disabled={!!busy} onClick={() => setActiveId(page.id)}
                    aria-pressed={active.id === page.id} className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left">
                    <Thumbnail page={page} />
                    <span className="min-w-0 text-xs">
                      <strong className="block">PDF sayfası {index + 1}</strong>
                      <span className="block truncate text-slate-600">{page.number ? `Kitapçık ${page.number}` : page.file.name}</span>
                      {duplicates.has(page.id) && <span className="block font-semibold text-amber-800">Olası tekrar</span>}
                    </span>
                  </button>
                  <button type="button" className={iconButton} aria-label={`${index + 1}. sayfayı yukarı taşı`} disabled={!!busy || index === 0} onClick={() => move(page.id, -1)}><ArrowUp className="size-3" /></button>
                  <button type="button" className={iconButton} aria-label={`${index + 1}. sayfayı aşağı taşı`} disabled={!!busy || index === pages.length - 1} onClick={() => move(page.id, 1)}><ArrowDown className="size-3" /></button>
                  <button type="button" className={iconButton} aria-label={`${index + 1}. sayfayı kaldır`} disabled={!!busy} onClick={() => setPages(current => current.filter(item => item.id !== page.id))}><Trash2 className="size-3" /></button>
                </li>)}
              </ol>
            </section>
            <section className="space-y-3" aria-label="Seçili sayfayı düzenle">
              <fieldset disabled={!!busy} className="space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs font-medium">Kitapçık numarası
                    <input type="text" inputMode="numeric" maxLength={3} className="min-h-10 w-28 rounded-lg border border-slate-200 px-2"
                      value={active.number} placeholder="Örn. 12" onChange={event => update(active.id, {
                        number: event.target.value.replace(/\D/g, '').replace(/^0+/, ''),
                      })} />
                  </label>
                  <button type="button" className={button} onClick={() => rotate(active)}><RotateCw className="size-4" /> 90° döndür</button>
                  <button type="button" className={button} onClick={() => split(active)}><Split className="size-4" /> İkiye ayır</button>
                  <button type="button" className={button} onClick={() => update(active.id, { corners: FULL_CORNERS })}>Tam fotoğraf</button>
                </div>
                {open && <CropPreview key={active.id} page={active} onChange={corners => update(active.id, { corners })} />}
                <div className="grid gap-3 sm:grid-cols-3">
                  {([['light', 'Işık dengeleme'], ['contrast', 'Kontrast'], ['sharpness', 'Netlik']] as const).map(([key, label]) =>
                    <label key={key} className="flex flex-col gap-1 text-xs font-medium">
                      {label} · {active.adjustments[key]}
                      <input type="range" min={0} max={100} value={active.adjustments[key]} onChange={event => update(active.id, {
                        adjustments: { ...active.adjustments, [key]: Number(event.target.value) },
                      })} />
                    </label>)}
                </div>
                <button type="button" className={button} onClick={() => {
                  setPages(current => current.map(page => ({ ...page, adjustments: active.adjustments })));
                  setStatus({ text: 'Görüntü ayarları tüm sayfalara uygulandı.' });
                }}>Ayarları tüm sayfalara uygula</button>
              </fieldset>
            </section>
          </div>
        )}
      </div>
      <div className="sticky bottom-0 z-10 flex flex-wrap items-end justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium sm:max-w-72">
          PDF adı
          <input className="min-h-10 w-full rounded-lg border border-slate-200 px-3" value={name} disabled={!!busy} onChange={event => setName(event.target.value)} />
        </label>
        <button type="button" className={primary} disabled={!!busy || !pages.length || repeatedNumbers || duplicates.size > 0} onClick={download}><Download className="size-4" /> PDF indir</button>
      </div>
    </dialog>
  );
}
