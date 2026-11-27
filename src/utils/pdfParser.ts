import { buildStudentKey, matchSubjectLabel, normalizeClassName, normalizeTurkish } from './examLabels';
import { branchColumn, buildBranchResults, validBranchColumns, type BranchColumn, type BranchOptions, type BranchSourceRow } from './branchAnalysis';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ExamMeta,
  ExamParticipants,
  ExamRanks,
  KazanimResult,
  ParsedExamBundle,
  SUBJECT_LIST,
  SUBJECT_MAP,
  SubjectKey,
  SubjectScore,
  StudentExamRecord,
  TOTAL_LGS_QUESTIONS,
} from '../types/exam';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export { buildStudentKey, matchSubjectLabel, normalizeClassName, normalizeTurkish } from './examLabels';

export interface TextToken {
  x: number;
  y: number;
  width: number;
  str: string;
}

interface LineCluster {
  y: number;
  tokens: TextToken[];
}

function parseTrNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  let cleaned = raw.trim().replace(/%/g, '').replace(/\s+/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '—') return null;
  // Handle Turkish decimals (18,67) and also dot decimals (18.67)
  // If both . and , appear (e.g. 1.234,56), strip thousand separator
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  }
  const val = Number(cleaned);
  return Number.isFinite(val) ? val : null;
}

function isDecimalStr(str: string): boolean {
  return /^-?\d+[.,]\d+$/.test(str.trim());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function createEmptySubjectScore(key: SubjectKey): SubjectScore {
  const soru = SUBJECT_MAP[key].questionCount;
  return {
    soru,
    dogru: 0,
    yanlis: 0,
    bos: soru,
    net: 0,
    basariYuzdesi: 0,
  };
}

function createSubjectScore(
  key: SubjectKey,
  dogru: number,
  yanlis: number,
  explicitNet?: number | null,
  soruOverride?: number | null,
  extras?: {
    bosOverride?: number | null;
    basariYuzdesi?: number;
    sinifOrt?: number;
    kurumOrt?: number;
    genelOrt?: number;
  }
): SubjectScore {
  const soru = soruOverride && soruOverride > 0 ? soruOverride : SUBJECT_MAP[key].questionCount;
  const d = Math.max(0, Math.min(soru, Math.round(dogru)));
  const y = Math.max(0, Math.min(soru - d, Math.round(yanlis)));
  const bos =
    extras?.bosOverride !== undefined && extras.bosOverride !== null && Number.isFinite(extras.bosOverride)
      ? Math.max(0, Math.min(soru, Math.round(extras.bosOverride)))
      : Math.max(0, soru - d - y);
  const net =
    explicitNet !== undefined && explicitNet !== null && Number.isFinite(explicitNet)
      ? round2(explicitNet)
      : round2(d - y / 3);
  const basariYuzdesi =
    extras?.basariYuzdesi !== undefined && Number.isFinite(extras.basariYuzdesi)
      ? Math.round(extras.basariYuzdesi)
      : Math.round((net / soru) * 100);
  return {
    soru,
    dogru: d,
    yanlis: y,
    bos,
    net,
    basariYuzdesi,
    sinifOrt: extras?.sinifOrt,
    kurumOrt: extras?.kurumOrt,
    genelOrt: extras?.genelOrt,
  };
}

function createTotalScore(
  subjects: Record<SubjectKey, SubjectScore>,
  overrides?: {
    soru?: number;
    dogru?: number;
    yanlis?: number;
    bos?: number;
    net?: number;
    basariYuzdesi?: number;
    sinifOrt?: number;
    kurumOrt?: number;
    genelOrt?: number;
  }
): SubjectScore {
  const sumSoru =
    SUBJECT_LIST.reduce((acc, s) => acc + subjects[s.key].soru, 0) || TOTAL_LGS_QUESTIONS;
  const sumDogru = SUBJECT_LIST.reduce((acc, s) => acc + subjects[s.key].dogru, 0);
  const sumYanlis = SUBJECT_LIST.reduce((acc, s) => acc + subjects[s.key].yanlis, 0);
  const sumNet = round2(SUBJECT_LIST.reduce((acc, s) => acc + subjects[s.key].net, 0));

  const soru = overrides?.soru && overrides.soru > 0 ? overrides.soru : sumSoru;
  const dogru = overrides?.dogru !== undefined ? Math.round(overrides.dogru) : sumDogru;
  const yanlis = overrides?.yanlis !== undefined ? Math.round(overrides.yanlis) : sumYanlis;
  const bos =
    overrides?.bos !== undefined ? Math.max(0, Math.round(overrides.bos)) : Math.max(0, soru - dogru - yanlis);
  const net = overrides?.net !== undefined ? round2(overrides.net) : sumNet;
  const basariYuzdesi =
    overrides?.basariYuzdesi !== undefined
      ? Math.round(overrides.basariYuzdesi)
      : Math.round((net / soru) * 100);

  return {
    soru,
    dogru,
    yanlis,
    bos,
    net,
    basariYuzdesi,
    sinifOrt: overrides?.sinifOrt,
    kurumOrt: overrides?.kurumOrt,
    genelOrt: overrides?.genelOrt,
  };
}

function clusterLines(tokens: TextToken[], yTolerance = 3.5): LineCluster[] {
  const sorted = [...tokens].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: LineCluster[] = [];
  for (const tok of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - tok.y) <= yTolerance) {
      last.tokens.push(tok);
    } else {
      lines.push({ y: tok.y, tokens: [tok] });
    }
  }
  for (const line of lines) {
    line.tokens.sort((a, b) => a.x - b.x);
  }
  return lines;
}


function splitMergedNumericToken(tok: TextToken): TextToken[] {
  const raw = tok.str.trim();
  if (!raw.includes(' ')) return [{ ...tok, str: raw }];
  const parts = raw.split(/\s+/).filter(Boolean);
  const allNumeric = parts.every((p) => /^-?\d+([.,]\d+)?%?$/.test(p));
  if (!allNumeric || parts.length <= 1) {
    return [{ ...tok, str: raw }];
  }
  const totalChars = raw.length || 1;
  const result: TextToken[] = [];
  let charCursor = 0;
  for (const part of parts) {
    const idx = raw.indexOf(part, charCursor);
    const ratio = idx / totalChars;
    const partWidth = (part.length / totalChars) * tok.width;
    result.push({
      x: tok.x + ratio * tok.width,
      y: tok.y,
      width: partWidth,
      str: part,
    });
    charCursor = idx + part.length;
  }
  return result;
}

interface DynamicColumnDef {
  key: SubjectKey | 'toplam';
  minX: number;
  maxX: number;
  dX?: number;
  yX?: number;
  bX?: number;
  nX?: number;
}

interface DynamicTableLayout {
  headerY: number;
  columns: DynamicColumnDef[];
  siraRange?: [number, number];
  noRange?: [number, number];
  nameRange: [number, number];
  sinifRange?: [number, number];
  lgsRange?: [number, number];
  rankStartX?: number;
  pageWidth: number;
}

interface OkulListRow {
  numara: string;
  name: string;
  sinif: string;
  subjects: Record<SubjectKey, SubjectScore>;
  toplam: SubjectScore;
  lgsPuan: number;
  dereceler: ExamRanks;
}

interface OkulListMeta {
  examName?: string;
  schoolName?: string;
  location?: string;
  katilimlar?: ExamParticipants;
  generalAvgLgs?: number;
  schoolAvgLgs?: number;
  generalAvgToplamNet?: number;
  schoolAvgToplamNet?: number;
  generalSubjectNets: Partial<Record<SubjectKey, number>>;
  schoolSubjectNets: Partial<Record<SubjectKey, number>>;
}

/**
 * Dynamically detects table column headers (subject spans, D/Y/B/N sub-columns, Toplam, LGS, Name, Class, No)
 * so both Portrait & Landscape PDFs from any Turkish LGS publisher work cleanly.
 */
function detectDynamicTableLayout(
  lines: LineCluster[],
  pageWidth: number
): DynamicTableLayout | null {
  // Score all candidate header lines and pick the one with the most distinct subjects (+ toplam + sub-headers)
  let bestScore = -1;
  let subjectLineIdx = -1;
  let subjectAnchors: Array<{ key: SubjectKey | 'toplam'; x: number; centerX: number }> = [];

  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const line = lines[i];
    const found: Array<{ key: SubjectKey | 'toplam'; x: number; centerX: number }> = [];
    const seen = new Set<string>();

    for (const tok of line.tokens) {
      const norm = normalizeTurkish(tok.str);
      if (norm === 'TOPLAM' || norm === 'TOP') {
        if (!seen.has('toplam')) {
          seen.add('toplam');
          found.push({ key: 'toplam', x: tok.x, centerX: tok.x + tok.width / 2 });
        }
        continue;
      }
      const subj = matchSubjectLabel(tok.str);
      if (subj && !seen.has(subj)) {
        seen.add(subj);
        found.push({ key: subj, x: tok.x, centerX: tok.x + tok.width / 2 });
      }
    }

    const subjCount = found.filter((f) => f.key !== 'toplam').length;
    if (subjCount < 3) continue;

    // Bonus if the line right below has D/Y/B/N sub-headers
    let hasSubBelow = false;
    const nextLine = lines[i + 1];
    if (nextLine) {
      const dybnCount = nextLine.tokens
        .flatMap((t) => t.str.trim().split(/\s+/))
        .filter((w) => /^(D|Y|B|N|NET)$/i.test(normalizeTurkish(w))).length;
      if (dybnCount >= 6) hasSubBelow = true;
    }

    const score = subjCount * 10 + (seen.has('toplam') ? 5 : 0) + (hasSubBelow ? 8 : 0);
    if (score > bestScore) {
      bestScore = score;
      subjectLineIdx = i;
      subjectAnchors = found.sort((a, b) => a.centerX - b.centerX);
    }
  }

  if (subjectLineIdx === -1 || subjectAnchors.length < 3) return null;

  const subjectLine = lines[subjectLineIdx];

  // Check if next 1-2 lines below have D / Y / B / N sub-headers
  let subHeaderTokens: TextToken[] = [];
  for (let offset = 1; offset <= 2; offset++) {
    const candidate = lines[subjectLineIdx + offset];
    if (!candidate) break;
    const expanded = candidate.tokens.flatMap((t) => {
      if (t.str.includes(' ') && /^[DYBN\s]+$/i.test(t.str.trim())) {
        const parts = t.str.trim().split(/\s+/);
        const step = t.width / Math.max(1, parts.length);
        return parts.map((p, idx) => ({ x: t.x + idx * step, y: t.y, width: step, str: p }));
      }
      return [t];
    });
    const dybnCount = expanded.filter((t) =>
      /^(D|Y|B|N|NET|DOGRU|YANLIS|BOS)$/i.test(normalizeTurkish(t.str))
    ).length;
    if (dybnCount >= 6) {
      subHeaderTokens = expanded;
      break;
    }
  }

  // Estimate column span width from spacing between consecutive subject anchors
  const gaps: number[] = [];
  for (let i = 1; i < subjectAnchors.length; i++) {
    gaps.push(subjectAnchors[i].centerX - subjectAnchors[i - 1].centerX);
  }
  const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 45;

  // Build subject + toplam column bounding intervals
  const columns: DynamicColumnDef[] = subjectAnchors.map((anchor, idx) => {
    const prevCenter = idx > 0 ? subjectAnchors[idx - 1].centerX : anchor.centerX - medianGap;
    const nextCenter =
      idx < subjectAnchors.length - 1
        ? subjectAnchors[idx + 1].centerX
        : anchor.centerX + medianGap;
    const minX = idx === 0 ? anchor.centerX - medianGap * 0.52 : (prevCenter + anchor.centerX) / 2;
    const maxX =
      idx === subjectAnchors.length - 1
        ? anchor.centerX + medianGap * 0.52
        : (anchor.centerX + nextCenter) / 2;

    const colSubs = subHeaderTokens.filter((t) => t.x >= minX - 4 && t.x <= maxX + 4);
    let dX: number | undefined;
    let yX: number | undefined;
    let bX: number | undefined;
    let nX: number | undefined;

    for (const st of colSubs) {
      const k = normalizeTurkish(st.str);
      const cx = st.x + st.width / 2;
      if (k === 'D' || k === 'DOGRU') dX = cx;
      else if (k === 'Y' || k === 'YANLIS') yX = cx;
      else if (k === 'B' || k === 'BOS') bX = cx;
      else if (k === 'N' || k === 'NET') nX = cx;
    }

    // Refine column boundaries using actual D and N sub-header coordinates when present
    const subXs = [dX, yX, bX, nX].filter((v): v is number => v !== undefined);
    const refinedMinX = subXs.length >= 2 ? Math.min(...subXs) - 7 : minX;
    const refinedMaxX = subXs.length >= 2 ? Math.max(...subXs) + 10 : maxX;

    return {
      key: anchor.key,
      minX: refinedMinX,
      maxX: refinedMaxX,
      dX,
      yX,
      bX,
      nX,
    };
  });

  // Resolve any slight overlaps between adjacent refined columns
  for (let i = 1; i < columns.length; i++) {
    if (columns[i].minX < columns[i - 1].maxX) {
      const mid = (columns[i - 1].maxX + columns[i].minX) / 2;
      columns[i - 1].maxX = mid;
      columns[i].minX = mid;
    }
  }

  // Locate left metadata columns (Sira, O.No, Isim, Sinif) from subjectLine tokens left of first subject
  const firstSubjX = columns[0].minX;
  const leftHeaders = subjectLine.tokens.filter((t) => t.x < firstSubjX);

  const siraTok = leftHeaders.find((t) => /^(SIRA|SR|NO\.?|#)$/i.test(normalizeTurkish(t.str)));
  const noTok = leftHeaders.find((t) =>
    /^(O NO|ONO|OGR NO|NUMARA|OKUL NO|NO)$/i.test(normalizeTurkish(t.str)) && t !== siraTok
  );
  const nameTok = leftHeaders.find((t) =>
    /(ISIM|AD SOYAD|ADI SOYADI|OGRENCI)/i.test(normalizeTurkish(t.str))
  );
  const sinifTok = leftHeaders.find((t) => /(SINIF|SUBE|SNF)/i.test(normalizeTurkish(t.str)));

  // Locate LGS/Puan column right of last subject/toplam
  const lastColMaxX = columns[columns.length - 1].maxX;
  const rightHeaders = [...subjectLine.tokens, ...subHeaderTokens].filter(
    (t) => t.x >= lastColMaxX - 6
  );
  const lgsTok = rightHeaders.find((t) => /(LGS|PUAN|PUANI)/i.test(normalizeTurkish(t.str)));
  const rankTok = rightHeaders.find((t) =>
    /(DERECE|SNF|OKUL|ILCE|GENEL|SIRALAMA)/i.test(normalizeTurkish(t.str))
  );

  const lgsMinX = lgsTok ? Math.max(lastColMaxX - 4, lgsTok.x - 10) : lastColMaxX;
  const lgsMaxX = rankTok
    ? Math.max(lgsMinX + 26, rankTok.x - 4)
    : Math.min(pageWidth, lgsMinX + 42);

  // Build reasonable ranges for Sira, No, Name, Sinif
  const siraRange: [number, number] | undefined = siraTok
    ? [Math.max(0, siraTok.x - 10), noTok ? noTok.x - 2 : siraTok.x + 18]
    : [10, 39];

  const noRange: [number, number] | undefined = noTok
    ? [noTok.x - 5, nameTok ? nameTok.x - 2 : noTok.x + 22]
    : [38, 59];

  const sinifStart = sinifTok ? sinifTok.x - 8 : firstSubjX - 24;
  const sinifRange: [number, number] = [sinifStart, firstSubjX + 2];

  const nameStart = noRange ? noRange[1] - 1 : 55;
  const nameRange: [number, number] = [nameStart, sinifRange[0] + 2];

  return {
    headerY: subHeaderTokens.length > 0 ? subHeaderTokens[0].y : subjectLine.y,
    columns,
    siraRange,
    noRange,
    nameRange,
    sinifRange,
    lgsRange: [lgsMinX, lgsMaxX],
    rankStartX: rankTok ? rankTok.x - 4 : lgsMaxX,
    pageWidth,
  };
}

function parseTabularListPage(
  tokens: TextToken[],
  pageWidth: number,
  meta: OkulListMeta,
  rowsOut: OkulListRow[],
  inheritedLayout: DynamicTableLayout | null
): DynamicTableLayout | null {
  const lines = clusterLines(tokens, 3.2);
  const layout = detectDynamicTableLayout(lines, pageWidth) ?? inheritedLayout;
  if (!layout) return null;

  // Extract top header metadata if present (e.g., TRABZON / ARAKLI / OKUL / SINAV ADI)
  for (const line of lines) {
    if (line.y > layout.headerY + 25) {
      const fullStr = line.tokens.map((t) => t.str).join(' ');
      if (
        !meta.examName &&
        /(DENEME|GELISIM|IZLEME|LGS|SINAV|TARAMA|KURUMSAL)/i.test(normalizeTurkish(fullStr)) &&
        !/(OKUL NET LISTESI|SONUC LISTESI|KATILIMLAR)/i.test(normalizeTurkish(fullStr))
      ) {
        const candidateTok = line.tokens.find((t) =>
          /(DENEME|GELISIM|IZLEME|TARAMA|LGS)/i.test(normalizeTurkish(t.str))
        );
        if (candidateTok && candidateTok.str.trim().length >= 5) {
          meta.examName = candidateTok.str.trim();
        }
      }
      const okulTok = line.tokens.find((t) =>
        /(ORTAOKUL|OKULU|KOLEJ|KURS|IMAM HATIP)/i.test(normalizeTurkish(t.str))
      );
      if (okulTok && !meta.schoolName) {
        meta.schoolName = okulTok.str.trim();
      }
      // Classic TCPDF header row check (IL / ILCE / OKUL / SINAV ADI / KATILIMLAR)
      if (line.y > 762 && line.y < 782 && pageWidth < 650) {
        const ilTok = line.tokens.find((t) => t.x >= 30 && t.x < 110);
        const ilceTok = line.tokens.find((t) => t.x >= 110 && t.x < 175);
        if (ilTok && ilceTok && !meta.location) {
          meta.location = `${ilTok.str.trim()} / ${ilceTok.str.trim()}`;
        }
        const nums = line.tokens
          .filter((t) => t.x >= 450)
          .flatMap(splitMergedNumericToken)
          .map((t) => parseTrNumber(t.str))
          .filter((n): n is number => n !== null);
        if (nums.length >= 4 && !meta.katilimlar) {
          meta.katilimlar = { okul: nums[0], ilce: nums[1], il: nums[2], genel: nums[3] };
        }
      }
    }
  }

  const rightColumnTokens = layout.rankStartX
    ? tokens.filter((t) => t.x >= layout.rankStartX! + 50 && t.y < layout.headerY).sort((a, b) => b.y - a.y)
    : [];

  const subjectCols = layout.columns.filter(
    (c): c is DynamicColumnDef & { key: SubjectKey } => c.key !== 'toplam'
  );
  const toplamCol = layout.columns.find((c) => c.key === 'toplam');

  for (const line of lines) {
    if (line.y >= layout.headerY - 2) continue;
    const expanded = line.tokens.flatMap(splitMergedNumericToken);
    const fullText = expanded.map((t) => t.str).join(' ');
    const normFull = normalizeTurkish(fullText);

    // Check Genel Ortalama or Okul Ortalamasi benchmark rows
    if (normFull.includes('GENEL ORTALAMA') || normFull.includes('OKUL ORTALAMA') || normFull.includes('KURUM ORTALAMA')) {
      const isGeneral = normFull.includes('GENEL ORTALAMA');
      for (const col of subjectCols) {
        const colToks = expanded.filter((t) => t.x >= col.minX && t.x < col.maxX);
        const netTok =
          colToks.find((t) => isDecimalStr(t.str)) ?? colToks[colToks.length - 1];
        const netVal = parseTrNumber(netTok?.str);
        if (netVal !== null) {
          if (isGeneral) meta.generalSubjectNets[col.key] = netVal;
          else meta.schoolSubjectNets[col.key] = netVal;
        }
      }
      if (toplamCol) {
        const topToks = expanded.filter((t) => t.x >= toplamCol.minX && t.x < toplamCol.maxX);
        const topNet = parseTrNumber(topToks.find((t) => isDecimalStr(t.str))?.str);
        if (topNet !== null) {
          if (isGeneral) meta.generalAvgToplamNet = topNet;
          else meta.schoolAvgToplamNet = topNet;
        }
      }
      if (layout.lgsRange) {
        const lgsTok = expanded.find(
          (t) => t.x >= layout.lgsRange![0] - 4 && t.x <= layout.lgsRange![1] + 6 && isDecimalStr(t.str)
        );
        const lgsVal = parseTrNumber(lgsTok?.str);
        if (lgsVal !== null && lgsVal > 50 && lgsVal <= 500) {
          if (isGeneral) meta.generalAvgLgs = lgsVal;
          else meta.schoolAvgLgs = lgsVal;
        }
      }
      continue;
    }

    // Skip footer / non-student rows
    if (
      normFull.includes('SINIF ORTALAMA') ||
      normFull.includes('SUBE ORTALAMA') ||
      normFull.startsWith('SAYFA ')
    ) {
      continue;
    }

    // Identify student row: must have a name left of the first subject column and numeric score values
    const firstSubjectMinX = layout.columns[0].minX;
    const leftToks = expanded.filter((t) => t.x < firstSubjectMinX + 2);
    if (leftToks.length === 0) continue;

    // Class token anywhere in left section matching e.g. 8-A, 8/B, 8C, 8-XX
    const sinifTok = leftToks.find((t) => /^\d{1,2}[./\-]?[A-ZÇĞİÖŞÜ0-9]{1,3}$/i.test(t.str.trim()));

    // Number tokens (sira and/or student no)
    const intLeftToks = leftToks.filter(
      (t) => /^\d+$/.test(t.str.trim()) && t !== sinifTok
    );

    let noVal = '0';
    if (intLeftToks.length >= 2) {
      noVal = intLeftToks[1].str.trim();
    } else if (intLeftToks.length === 1) {
      const only = intLeftToks[0];
      if (layout.noRange && only.x >= layout.noRange[0] - 4) {
        noVal = only.str.trim();
      }
    }

    const nameToks = leftToks.filter(
      (t) =>
        t !== sinifTok &&
        !intLeftToks.includes(t) &&
        /[A-Za-zÇĞİÖŞÜçğıöşü]{2,}/.test(t.str)
    );
    const name = nameToks.map((t) => t.str.trim()).join(' ').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 3) continue;
    // Skip header repetitions
    if (/(OGRENCI|AD SOYAD|ADI SOYADI|ISIM|TOPLAM|ORTALAMA)/i.test(normalizeTurkish(name))) {
      continue;
    }

    // Parse all subject columns dynamically
    const subjects: Record<SubjectKey, SubjectScore> = {
      turkce: createEmptySubjectScore('turkce'),
      tarih: createEmptySubjectScore('tarih'),
      din: createEmptySubjectScore('din'),
      ingilizce: createEmptySubjectScore('ingilizce'),
      matematik: createEmptySubjectScore('matematik'),
      fen: createEmptySubjectScore('fen'),
    };

    let parsedAnyNumeric = false;
    for (const col of subjectCols) {
      const colToks = expanded.filter((t) => t.x >= col.minX - 2 && t.x < col.maxX + 2);
      if (colToks.length === 0) continue;
      parsedAnyNumeric = true;

      let dVal = 0;
      let yVal = 0;
      let bVal: number | null = null;
      let nVal: number | null = null;

      if (colToks.length === 1 && isDecimalStr(colToks[0].str)) {
        // Net-only table column
        nVal = parseTrNumber(colToks[0].str);
        dVal = Math.max(0, Math.round(nVal ?? 0));
      } else {
        for (const ct of colToks) {
          const num = parseTrNumber(ct.str);
          if (num === null) continue;
          if (isDecimalStr(ct.str)) {
            nVal = num;
          } else {
            // Assign to closest detected sub-column center (D, Y, B, N)
            const candidates: Array<{ type: 'D' | 'Y' | 'B' | 'N'; dist: number }> = [];
            const cx = ct.x + ct.width / 2;
            if (col.dX !== undefined) candidates.push({ type: 'D', dist: Math.abs(cx - col.dX) });
            if (col.yX !== undefined) candidates.push({ type: 'Y', dist: Math.abs(cx - col.yX) });
            if (col.bX !== undefined) candidates.push({ type: 'B', dist: Math.abs(cx - col.bX) });
            if (col.nX !== undefined) candidates.push({ type: 'N', dist: Math.abs(cx - col.nX) });

            if (candidates.length > 0) {
              candidates.sort((a, b) => a.dist - b.dist);
              const winner = candidates[0].type;
              if (winner === 'D') dVal = num;
              else if (winner === 'Y') yVal = num;
              else if (winner === 'B') bVal = num;
              else if (winner === 'N' && nVal === null) nVal = num;
            } else {
              // Positional fallback inside column
              const idx = colToks.indexOf(ct);
              if (idx === 0) dVal = num;
              else if (idx === 1) yVal = num;
              else if (idx === 2 && colToks.length >= 4) bVal = num;
              else nVal = num;
            }
          }
        }
      }

      subjects[col.key] = createSubjectScore(col.key, dVal, yVal, nVal, null, {
        bosOverride: bVal,
      });
    }

    if (!parsedAnyNumeric) continue;

    // Parse Toplam and LGS Puanı
    let topD: number | undefined;
    let topY: number | undefined;
    let topB: number | undefined;
    let topNet: number | undefined;
    let lgsPuan = 0;

    const afterSubjectsX =
      subjectCols.length > 0 ? subjectCols[subjectCols.length - 1].maxX : firstSubjectMinX;
    const endLgsX = layout.lgsRange ? layout.lgsRange[1] + 6 : layout.pageWidth;
    const summaryToks = expanded.filter((t) => t.x >= afterSubjectsX - 3 && t.x <= endLgsX);

    const decimals = summaryToks
      .filter((t) => isDecimalStr(t.str))
      .map((t) => ({ x: t.x, val: parseTrNumber(t.str)! }))
      .filter((o) => Number.isFinite(o.val))
      .sort((a, b) => a.x - b.x);

    const ints = summaryToks
      .filter((t) => !isDecimalStr(t.str) && /^\d+$/.test(t.str))
      .map((t) => ({ x: t.x, val: Number(t.str) }))
      .sort((a, b) => a.x - b.x);

    if (toplamCol) {
      const topInts = ints.filter((i) => i.x >= toplamCol.minX - 4 && i.x <= toplamCol.maxX + 4);
      if (topInts.length >= 2) {
        topD = topInts[0].val;
        topY = topInts[1].val;
        if (toplamCol.bX !== undefined && topInts.length >= 3) {
          topB = topInts[2].val;
        }
      }
    } else if (ints.length >= 2) {
      topD = ints[0].val;
      topY = ints[1].val;
    }

    // Distinguish Total Net (<= 90) vs LGS Score (typically 100..500)
    const lgsCandidate = decimals.find((d) => d.val > 95 && d.val <= 500);
    const netCandidate = decimals.find((d) => d !== lgsCandidate && d.val >= -30 && d.val <= 90);
    if (netCandidate) topNet = netCandidate.val;
    if (lgsCandidate) lgsPuan = lgsCandidate.val;

    const toplam = createTotalScore(subjects, {
      dogru: topD,
      yanlis: topY,
      bos: topB,
      net: topNet,
    });

    // Estimate LGS if the summary PDF did not include an LGS score column
    if (lgsPuan === 0 && toplam.net > 0) {
      lgsPuan = round2(Math.min(500, Math.max(100, 190 + toplam.net * 3.45)));
    }

    // Dereceler (if present to the right of LGS)
    const dereceler: ExamRanks = {};
    if (layout.rankStartX) {
      const rankToks = expanded
        .filter((t) => t.x >= layout.rankStartX! - 4 && /^\d+$/.test(t.str.trim()))
        .sort((a, b) => a.x - b.x);
      if (rankToks[0]) dereceler.sinif = Number(rankToks[0].str);
      if (rankToks[1]) dereceler.okul = Number(rankToks[1].str);
      if (rankToks[2]) dereceler.ilce = Number(rankToks[2].str);
      if (rankToks[3]) dereceler.il = Number(rankToks[3].str);

      const nearGenel = rightColumnTokens.find(
        (t) => t.y >= line.y + 1 && t.y <= line.y + 8 && /^\d+$/.test(t.str.trim())
      );
      const nearPct = rightColumnTokens.find(
        (t) => t.y >= line.y - 8 && t.y <= line.y - 1 && t.str.includes('%')
      );
      if (nearGenel) dereceler.genel = parseTrNumber(nearGenel.str) ?? undefined;
      if (nearPct) dereceler.yuzdelik = parseTrNumber(nearPct.str) ?? undefined;
    }

    rowsOut.push({
      numara: noVal,
      name,
      sinif: sinifTok ? normalizeClassName(sinifTok.str) : '8-A',
      subjects,
      toplam,
      lgsPuan,
      dereceler,
    });
  }

  return layout;
}

interface ParsedSonucBelgesi {
  examName: string;
  schoolName: string;
  location: string;
  numara: string;
  name: string;
  sinif: string;
  lgsPuan: number;
  genelOrtPuan?: number;
  dereceler: ExamRanks;
  katilimlar?: ExamParticipants;
  subjects: Record<SubjectKey, SubjectScore>;
  subjectRows: Map<SubjectKey, Omit<BranchSourceRow, 'name' | 'number' | 'classroom'>>;
  toplam: SubjectScore;
  kazanimlar: KazanimResult[];
}

function parseSonucBelgesiPage(tokens: TextToken[], pageWidth: number): ParsedSonucBelgesi | null {
  // Detect whether page is two-column (left score card + right DERSLERE GÖRE ANALİZ / KAZANIM)
  const rightAnalysisMarker = tokens.find(
    (t) =>
      t.x > pageWidth * 0.42 &&
      /(DERSLERE GORE ANALIZ|KAZANIM ANALIZ|KONU ANALIZ)/i.test(normalizeTurkish(t.str))
  );
  const splitX = rightAnalysisMarker ? Math.min(pageWidth * 0.505, rightAnalysisMarker.x - 15) : pageWidth;
  // For classic TCPDF portrait A4 (595pt), DERSLERE GÖRE ANALİZ is at x=389 and right column starts at x=303 -> splitX ~ 298
  const effectiveSplitX = rightAnalysisMarker && pageWidth < 620 ? Math.min(298, splitX) : splitX;

  const leftTokens = tokens.filter((t) => t.x < effectiveSplitX);
  const rightTokens = tokens.filter((t) => t.x >= effectiveSplitX);

  const leftLines = clusterLines(leftTokens, 3.2);
  const rightLines = clusterLines(rightTokens, 2.8);

  // Exam name sits near top right or near SONUÇ BELGESİ
  const topLines = clusterLines(
    tokens.filter((t) => t.y > 740),
    4
  );
  let examName = 'LGS Deneme Sınavı';
  const examNameTok = tokens.find(
    (t) =>
      t.y >= 785 &&
      t.x >= pageWidth * 0.35 &&
      !/(SONUC BELGESI|DERSLERE GORE)/i.test(normalizeTurkish(t.str)) &&
      t.str.trim().length >= 4
  );
  if (examNameTok) {
    examName = examNameTok.str.trim();
  } else {
    for (const l of topLines) {
      const cand = l.tokens.find((t) =>
        /(DENEME|GELISIM|IZLEME|TARAMA|LGS)/i.test(normalizeTurkish(t.str))
      );
      if (cand) {
        examName = cand.str.trim();
        break;
      }
    }
  }

  // Location / school line
  let location = '';
  let schoolName = '';
  const schoolLineTok = leftTokens.find(
    (t) =>
      t.y >= 760 &&
      (t.str.includes('/') || /(ORTAOKUL|OKULU|KOLEJ|KURS)/i.test(normalizeTurkish(t.str)))
  );
  if (schoolLineTok) {
    const parts = schoolLineTok.str
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 3) {
      location = `${parts[0]} / ${parts[1]}`;
      schoolName = parts.slice(2).join(' / ');
    } else {
      schoolName = schoolLineTok.str.trim();
    }
  }

  // Dynamically locate Student Identity (Öğrenci / Adı Soyadı, Numara, Sınıf)
  let name = '';
  let numara = '0';
  let sinif = '8-A';

  const identityHeaderIdx = leftLines.findIndex((l) =>
    l.tokens.some((t) => /^(OGRENCI|ADI SOYADI|AD SOYAD)$/i.test(normalizeTurkish(t.str)))
  );

  if (identityHeaderIdx !== -1) {
    const headerLine = leftLines[identityHeaderIdx];
    const noHeader = headerLine.tokens.find((t) =>
      /(NUMARA|OGR NO|OKUL NO|NO)/i.test(normalizeTurkish(t.str))
    );
    const sinifHeader = headerLine.tokens.find((t) =>
      /(SINIF|SUBE)/i.test(normalizeTurkish(t.str))
    );

    // Check if values sit on the line immediately below the header
    const valLine = leftLines[identityHeaderIdx + 1];
    if (valLine) {
      const noMinX = noHeader ? noHeader.x - 12 : effectiveSplitX * 0.65;
      const sinifMinX = sinifHeader ? sinifHeader.x - 10 : effectiveSplitX * 0.84;

      const nameToks = valLine.tokens.filter((t) => t.x < noMinX);
      const noTok = valLine.tokens.find((t) => t.x >= noMinX && t.x < sinifMinX);
      const sinifTok = valLine.tokens.find((t) => t.x >= sinifMinX);

      name = nameToks.map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim();
      if (noTok) numara = noTok.str.trim();
      if (sinifTok) sinif = normalizeClassName(sinifTok.str);
    }
  }

  // Fallback for "Adı Soyadı : EMİR HALİLOĞLU" inline label format
  if (!name) {
    for (const l of leftLines.slice(0, 12)) {
      const joined = l.tokens.map((t) => t.str).join(' ');
      const nameMatch = joined.match(/(?:Öğrenci|Adı\s*Soyadı|Ad\s*Soyad)\s*[:\-]\s*([^|]+?)(?:\s+(?:Numara|No|Sınıf|Şube)|$)/i);
      if (nameMatch) name = nameMatch[1].trim();
      const noMatch = joined.match(/(?:Numara|Öğr\.?\s*No|Okul\s*No)\s*[:\-]\s*(\d+)/i);
      if (noMatch) numara = noMatch[1].trim();
      const clsMatch = joined.match(/(?:Sınıf|Şube)\s*[:\-]\s*(\d{1,2}[./\-]?[A-ZÇĞİÖŞÜ0-9]+)/i);
      if (clsMatch) sinif = normalizeClassName(clsMatch[1]);
    }
  }

  if (!name) return null;

  // Score & ranks line: find line starting with or containing "LGS"
  let lgsPuan = 0;
  let genelOrtPuan: number | undefined;
  const dereceler: ExamRanks = {};
  let katilimlar: ExamParticipants | undefined;

  const lgsLine = leftLines.find((l) =>
    l.tokens.some((t) => /^(LGS|LGS PUANI|PUAN)$/i.test(normalizeTurkish(t.str)))
  );
  if (lgsLine) {
    const nums = lgsLine.tokens
      .filter((t) => t.x > 60)
      .flatMap(splitMergedNumericToken);
    const decimals = nums
      .filter((t) => isDecimalStr(t.str))
      .map((t) => ({ x: t.x, val: parseTrNumber(t.str)! }))
      .filter((o) => Number.isFinite(o.val))
      .sort((a, b) => a.x - b.x);
    if (decimals[0]) lgsPuan = decimals[0].val;
    if (decimals[1]) genelOrtPuan = decimals[1].val;

    // Extract ranks using X-position relative to score columns
    const rankNums = nums
      .filter((t) => !isDecimalStr(t.str) && /^\d+$/.test(t.str.trim()))
      .sort((a, b) => a.x - b.x);
    if (rankNums[0]) dereceler.sinif = Number(rankNums[0].str);
    if (rankNums[1]) dereceler.okul = Number(rankNums[1].str);
    if (rankNums[2]) dereceler.ilce = Number(rankNums[2].str);
    if (rankNums[3]) dereceler.il = Number(rankNums[3].str);
    if (rankNums[4]) dereceler.genel = Number(rankNums[4].str);
  }

  const katilimLine = leftLines.find((l) =>
    l.tokens.some((t) => normalizeTurkish(t.str).includes('KATILIM'))
  );
  if (katilimLine) {
    katilimlar = {};
    const kNums = katilimLine.tokens
      .flatMap(splitMergedNumericToken)
      .filter((t) => /^\d+$/.test(t.str.trim()))
      .sort((a, b) => a.x - b.x);
    if (kNums[0]) katilimlar.sinif = Number(kNums[0].str);
    if (kNums[1]) katilimlar.okul = Number(kNums[1].str);
    if (kNums[2]) katilimlar.ilce = Number(kNums[2].str);
    if (kNums[3]) katilimlar.il = Number(kNums[3].str);
    if (kNums[4]) katilimlar.genel = Number(kNums[4].str);
    if (dereceler.genel && katilimlar.genel && katilimlar.genel > 0) {
      dereceler.yuzdelik = round2((dereceler.genel / katilimlar.genel) * 100);
    }
  }

  // Dynamically detect subject table column positions from the "Ders / Soru / Doğru / Yanlış / Net" header row
  const subjHeaderIdx = leftLines.findIndex((l) => {
    const joined = normalizeTurkish(l.tokens.map((t) => t.str).join(' '));
    return joined.includes('DERS') && (joined.includes('DOGRU') || joined.includes('NET'));
  });

  // Dynamic column anchors (defaults match TCPDF SONUÇ BELGESİ layout)
  let colAnchors = {
    labelMaxX: 96,
    soruX: 106,
    dogruX: 130,
    yanlisX: 152,
    bosX: undefined as number | undefined,
    netX: 176,
    basariX: 205,
    sinifOrtX: 235,
    kurumOrtX: 260,
    genelOrtX: 284,
  };

  let tableStartY = 670;
  if (subjHeaderIdx !== -1) {
    const hLine = leftLines[subjHeaderIdx];
    const aboveLine = leftLines[subjHeaderIdx - 1];
    const mergedHeaders = [...(aboveLine && Math.abs(aboveLine.y - hLine.y) < 12 ? aboveLine.tokens : []), ...hLine.tokens];
    tableStartY = hLine.y - 2;

    const findCenter = (re: RegExp): number | undefined => {
      const tok = mergedHeaders.find((t) => re.test(normalizeTurkish(t.str)));
      return tok ? tok.x + tok.width / 2 : undefined;
    };

    const soruC = findCenter(/^(SORU|SS|S)$/);
    const dogruC = findCenter(/^(DOGRU|D)$/);
    const yanlisC = findCenter(/^(YANLIS|Y)$/);
    const bosC = findCenter(/^(BOS|B)$/);
    const netC = findCenter(/^(NET|N)$/);
    const basariC = findCenter(/^(BASARI|YUZDE|%)$/);
    const sinifC = findCenter(/^SINIF/);
    const kurumC = findCenter(/^(KURUM|OKUL)/);
    const genelC = findCenter(/^GENEL/);

    if (soruC && dogruC && yanlisC && netC) {
      colAnchors = {
        labelMaxX: soruC - 10,
        soruX: soruC,
        dogruX: dogruC,
        yanlisX: yanlisC,
        bosX: bosC,
        netX: netC,
        basariX: basariC ?? netC + 26,
        sinifOrtX: sinifC ?? netC + 55,
        kurumOrtX: kurumC ?? netC + 80,
        genelOrtX: genelC ?? netC + 104,
      };
    }
  }

  const subjects: Record<SubjectKey, SubjectScore> = {
    turkce: createEmptySubjectScore('turkce'),
    tarih: createEmptySubjectScore('tarih'),
    din: createEmptySubjectScore('din'),
    ingilizce: createEmptySubjectScore('ingilizce'),
    matematik: createEmptySubjectScore('matematik'),
    fen: createEmptySubjectScore('fen'),
  };

  const subjectRows: ParsedSonucBelgesi['subjectRows'] = new Map();
  let toplamOverrides:
    | {
        soru?: number;
        dogru?: number;
        yanlis?: number;
        bos?: number;
        net?: number;
        basariYuzdesi?: number;
        sinifOrt?: number;
        kurumOrt?: number;
        genelOrt?: number;
      }
    | undefined;

  const subjectTableLines = leftLines.filter((l) => l.y <= tableStartY && l.y >= tableStartY - 135);
  for (const line of subjectTableLines) {
    const labelTok = line.tokens.find((t) => t.x < colAnchors.labelMaxX);
    if (!labelTok) continue;
    const labelStr = labelTok.str.trim();

    const expandedVals = line.tokens
      .filter((t) => t.x >= colAnchors.labelMaxX - 4)
      .flatMap(splitMergedNumericToken);

    const pickNearest = (targetX: number | undefined, maxDist = 16): number | undefined => {
      if (targetX === undefined) return undefined;
      let best: { dist: number; val: number } | null = null;
      for (const tok of expandedVals) {
        const val = parseTrNumber(tok.str);
        if (val === null) continue;
        const cx = tok.x + tok.width / 2;
        const dist = Math.abs(cx - targetX);
        if (dist <= maxDist && (!best || dist < best.dist)) {
          best = { dist, val };
        }
      }
      return best?.val;
    };

    const soru = pickNearest(colAnchors.soruX);
    const dogru = pickNearest(colAnchors.dogruX);
    const yanlis = pickNearest(colAnchors.yanlisX);
    const bos = pickNearest(colAnchors.bosX);
    const net = pickNearest(colAnchors.netX, 18);
    const basariYuzdesi = pickNearest(colAnchors.basariX);
    const sinifOrt = pickNearest(colAnchors.sinifOrtX);
    const kurumOrt = pickNearest(colAnchors.kurumOrtX);
    const genelOrt = pickNearest(colAnchors.genelOrtX);

    if (normalizeTurkish(labelStr).startsWith('TOPLAM')) {
      toplamOverrides = {
        soru,
        dogru,
        yanlis,
        bos,
        net,
        basariYuzdesi,
        sinifOrt,
        kurumOrt,
        genelOrt,
      };
      break;
    }

    const subjKey = matchSubjectLabel(labelStr);
    if (subjKey && dogru !== undefined && yanlis !== undefined) {
      subjectRows.set(subjKey, { questionCount: soru, correct: dogru, incorrect: yanlis, blank: bos, net });
      subjects[subjKey] = createSubjectScore(subjKey, dogru, yanlis, net ?? null, soru ?? null, {
        bosOverride: bos ?? null,
        basariYuzdesi,
        sinifOrt,
        kurumOrt,
        genelOrt,
      });
    }
  }

  // Right panel: DERSLERE GÖRE ANALİZ (Kazanımlar)
  const kazanimlar: KazanimResult[] = [];
  let currentSubject: SubjectKey | null = null;
  const metricThresholdX = pageWidth * 0.87; // ~518 on 595pt page

  for (const line of rightLines) {
    if (line.y > 790) continue;
    const lineText = line.tokens
      .filter((t) => t.x < metricThresholdX)
      .map((t) => t.str)
      .join(' ')
      .trim();

    if (!lineText) continue;

    const hasHeaderCols = line.tokens.some(
      (t) => t.x >= metricThresholdX && /^(B%|%)$/.test(t.str.trim())
    );
    const maybeSubj = matchSubjectLabel(lineText);
    if (
      maybeSubj &&
      (lineText.startsWith('Sözel') ||
        lineText.startsWith('Sayısal') ||
        hasHeaderCols ||
        line.tokens.every((t) => t.x < metricThresholdX))
    ) {
      currentSubject = maybeSubj;
      continue;
    }

    if (!currentSubject) continue;
    if (normalizeTurkish(lineText) === 'KAZANIM BELIRTILMEMIS') continue;

    const metricTokens = line.tokens
      .filter((t) => t.x >= metricThresholdX)
      .flatMap(splitMergedNumericToken)
      .map((t) => ({ x: t.x, val: parseTrNumber(t.str) }))
      .filter((o): o is { x: number; val: number } => o.val !== null);

    if (metricTokens.length >= 4) {
      const [sTok, dTok, yTok, bTok] = metricTokens;
      const soru = Math.max(1, Math.round(sTok.val));
      const dogru = Math.max(0, Math.round(dTok.val));
      const yanlis = Math.max(0, Math.round(yTok.val));
      const bos = Math.max(0, soru - dogru - yanlis);
      const basariYuzdesi = Math.max(0, Math.min(100, Math.round(bTok.val)));

      kazanimlar.push({
        subject: currentSubject,
        text: lineText,
        soru,
        dogru,
        yanlis,
        bos,
        basariYuzdesi,
      });
    }
  }

  const toplam = createTotalScore(subjects, toplamOverrides);

  return {
    examName,
    schoolName,
    location,
    numara,
    name,
    sinif,
    lgsPuan,
    genelOrtPuan,
    dereceler,
    katilimlar,
    subjects,
    subjectRows,
    toplam,
    kazanimlar,
  };
}

function findBranchTable(lines: LineCluster[], subject: SubjectKey) {
  const isMetricHeader = (line: LineCluster | undefined) => line && line.tokens.length >= 2 && line.tokens.every(({ str }) => {
    const column = branchColumn(str, subject);
    return column && column !== 'name' && column !== 'number' && column !== 'classroom';
  });
  let upperHeader: { columns: Map<BranchColumn, number>; subjects: Set<SubjectKey> } | undefined;
  for (const [index, line] of lines.entries()) {
    const columns = new Map<BranchColumn, number>();
    const explicit = new Set<SubjectKey>();
    for (let i = 0; i < line.tokens.length; i++) {
      const first = line.tokens[i];
      for (let size = Math.min(5, line.tokens.length - i); size >= 1; size--) {
        const segment = line.tokens.slice(i, i + size);
        const label = segment.map(({ str }) => str).join(' ');
        const channel = branchColumn(label, subject);
        if (!channel) continue;
        // Keep separate header cells from being combined just because they are on the same line.
        if (segment.some((cell, pos) => pos > 0 && cell.x - segment[pos - 1].x - segment[pos - 1].width > 20)) continue;
        if (!columns.has(channel)) columns.set(channel, first.x);
        i += size - 1;
        break;
      }
    }
    for (const token of line.tokens) {
      const normalized = normalizeTurkish(token.str)
        .replace(/\s+(SORU|D|DOGRU|Y|YANLIS|B|BOS|N|NET|NETI)$/, '');
      const detected = matchSubjectLabel(normalized);
      if (detected) explicit.add(detected);
    }
    if (upperHeader && !columns.has('name') && isMetricHeader(line)) {
      for (const [key, position] of upperHeader.columns) {
        if (!columns.has(key)) columns.set(key, position);
      }
      for (const group of upperHeader.subjects) explicit.add(group);
    }
    if (explicit.size > 1 || (explicit.size && !explicit.has(subject))) {
      upperHeader = undefined;
      continue;
    }
    if (validBranchColumns(columns.keys()) && !isMetricHeader(lines[index + 1])) return { index, columns };
    upperHeader = columns.has('name') ? {
      columns: new Map([...columns].filter(([key]) => key === 'name' || key === 'number' || key === 'classroom')),
      subjects: explicit,
    } : undefined;
  }
  return undefined;
}

function readBranchTableRows(lines: LineCluster[], columns: Map<BranchColumn, number>): BranchSourceRow[] {
  const anchors = [...columns.entries()].sort((a, b) => a[1] - b[1]);
  return lines.map((line) => {
    const values = new Map<BranchColumn, string>();
    for (const token of line.tokens) {
      const index = anchors.findIndex(([, x], pos) => {
        const next = anchors[pos + 1];
        if (!next) return true;
        // Text uses left edges. Short scores in right-aligned cells use the nearest header.
        const threshold = anchors[pos][0] === 'name' ? next[1] - 8 : (x + next[1]) / 2;
        return token.x < threshold;
      });
      const [key, x] = anchors[index];
      if (index === 0 && token.x < x - 18) continue;
      values.set(key, [values.get(key), token.str].filter(Boolean).join(' '));
    }
    return {
      ...Object.fromEntries(values),
      name: values.get('name') ?? '',
    };
  });
}

export async function parseBranchPdf(source: ArrayBuffer, options: BranchOptions) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(source), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const rows: BranchSourceRow[] = [];
    let tableColumns: Map<BranchColumn, number> | undefined;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const tokens = content.items.flatMap((item) => 'str' in item && item.str.trim() ? [
        { x: item.transform[4], y: item.transform[5], width: item.width || 0, str: item.str },
      ] : []);
      const header = normalizeTurkish(tokens.filter(({ y }) => y > viewport.height * 0.85).map(({ str }) => str).join(' '));
      if (/SONUC BELGESI|OGRENCI KARNESI|BIREYSEL KARNE/.test(header)) {
        tableColumns = undefined;
        const result = parseSonucBelgesiPage(tokens, viewport.width);
        const row = result?.subjectRows.get(options.subject);
        if (result && row && result.subjectRows.size === 1) {
          rows.push({ ...row, name: result.name, number: result.numara, classroom: result.sinif, outcomes: result.kazanimlar });
          continue;
        }
        // Some publishers use the same title for ordinary student result tables.
      }
      const lines = clusterLines(tokens);
      const table = findBranchTable(lines, options.subject);
      if (table) tableColumns = table.columns;
      if (tableColumns) rows.push(...readBranchTableRows(table ? lines.slice(table.index + 1) : lines, tableColumns));
    }
    const results = buildBranchResults(rows, options);
    if (!results.length) throw new Error('Seçilen branş için okunabilir öğrenci sonuçları bulunamadı. Metin içeren sonuç PDF’si yükleyin veya Excel şablonunu kullanın.');
    return results;
  } finally {
    await task.destroy();
  }
}

export async function parseExamPdf(
  source: ArrayBuffer | Uint8Array,
  fileName: string,
  options?: {
    customExamName?: string;
    examDate?: string;
    examOrder?: number;
    isSample?: boolean;
    onProgress?: (currentPage: number, totalPages: number) => void;
  }
): Promise<ParsedExamBundle> {
  const data = source instanceof Uint8Array ? source : new Uint8Array(source);
  const loadingTask = pdfjsLib.getDocument({ data, useSystemFonts: true });
  const pdfDoc = await loadingTask.promise;
  const totalPages = pdfDoc.numPages;

  const okulListMeta: OkulListMeta = {
    generalSubjectNets: {},
    schoolSubjectNets: {},
  };
  const okulListRows: OkulListRow[] = [];
  const sonucPages: ParsedSonucBelgesi[] = [];
  let activeTabularLayout: DynamicTableLayout | null = null;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pageWidth = viewport.width || 595;

    const content = await page.getTextContent();
    const tokens: TextToken[] = [];
    for (const item of content.items) {
      if ('str' in item && item.str.trim() !== '') {
        tokens.push({
          x: item.transform[4],
          y: item.transform[5],
          width: item.width || 0,
          str: item.str,
        });
      }
    }

    const headerProbe = normalizeTurkish(
      tokens
        .filter((t) => t.y > viewport.height * 0.85)
        .map((t) => t.str)
        .join(' ')
    );

    // Skip class/school summary-only report cards (ŞUBE KARNESİ / KURUM KARNESİ)
    if (headerProbe.includes('SUBE KARNESI') || headerProbe.includes('KURUM KARNESI')) {
      activeTabularLayout = null;
      options?.onProgress?.(pageNum, totalPages);
      continue;
    }

    // Check individual student report card first
    if (
      headerProbe.includes('SONUC BELGESI') ||
      headerProbe.includes('OGRENCI KARNESI') ||
      headerProbe.includes('BIREYSEL KARNE')
    ) {
      activeTabularLayout = null;
      const parsed = parseSonucBelgesiPage(tokens, pageWidth);
      if (parsed) sonucPages.push(parsed);
      options?.onProgress?.(pageNum, totalPages);
      continue;
    }

    // Check OKUL NET LİSTESİ / KURUM NET LİSTESİ / generic student result list
    // Avoid double-parsing per-class SINIFI NET LISTESI pages when OKUL NET LISTESI already exists
    const isPerClassList =
      headerProbe.includes('SINIFI NET LISTESI') || headerProbe.includes('SUBE NET LISTESI');

    if (
      headerProbe.includes('OKUL NET LISTESI') ||
      headerProbe.includes('KURUM NET LISTESI') ||
      headerProbe.includes('SONUC LISTESI') ||
      headerProbe.includes('SIRALI LISTE') ||
      (!isPerClassList && activeTabularLayout !== null)
    ) {
      const detected = parseTabularListPage(
        tokens,
        pageWidth,
        okulListMeta,
        okulListRows,
        activeTabularLayout
      );
      activeTabularLayout = detected;
      options?.onProgress?.(pageNum, totalPages);
      continue;
    }

    // Fallback: if neither known title matched and we haven't found students yet, try dynamic table detection
    if (!isPerClassList) {
      const maybeLayout = parseTabularListPage(
        tokens,
        pageWidth,
        okulListMeta,
        okulListRows,
        null
      );
      if (maybeLayout) {
        activeTabularLayout = maybeLayout;
      }
    }

    options?.onProgress?.(pageNum, totalPages);
  }

  // Deduplicate okulListRows in case a PDF repeated students across sections
  const uniqueOkulMap = new Map<string, OkulListRow>();
  for (const row of okulListRows) {
    const key = buildStudentKey(row.numara, row.name, row.sinif);
    if (!uniqueOkulMap.has(key)) {
      uniqueOkulMap.set(key, row);
    }
  }
  const dedupedOkulRows = Array.from(uniqueOkulMap.values());

  const nowIso = new Date().toISOString();
  const examDate = options?.examDate || nowIso.slice(0, 10);
  const examOrder = options?.examOrder ?? 1;

  const detectedExamName =
    options?.customExamName?.trim() ||
    okulListMeta.examName ||
    sonucPages[0]?.examName ||
    fileName.replace(/\.pdf$/i, '');

  const detectedSchoolName =
    okulListMeta.schoolName || sonucPages[0]?.schoolName || '8. Sınıf LGS Okul Arşivi';
  const detectedLocation = okulListMeta.location || sonucPages[0]?.location || '';

  const examId = `exam_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const records: ParsedExamBundle['records'] = [];

  if (sonucPages.length > 0) {
    for (const sp of sonucPages) {
      const key = buildStudentKey(sp.numara, sp.name, sp.sinif);
      const listMatch = uniqueOkulMap.get(key);

      // Prefer OKUL NET LISTESI name if SONUÇ BELGESİ dropped a glyph (e.g. "ALİ AVCIO LU" -> "ALİ AVCIOĞLU")
      const cleanName =
        listMatch && listMatch.name.length >= sp.name.length && !listMatch.name.includes('  ')
          ? listMatch.name
          : sp.name;

      const mergedSubjects: Record<SubjectKey, SubjectScore> = { ...sp.subjects };
      for (const s of SUBJECT_LIST) {
        const cur = mergedSubjects[s.key];
        const fromList = listMatch?.subjects[s.key];
        if (
          cur.dogru === 0 &&
          cur.yanlis === 0 &&
          fromList &&
          (fromList.dogru > 0 || fromList.yanlis > 0)
        ) {
          mergedSubjects[s.key] = {
            ...fromList,
            sinifOrt: cur.sinifOrt,
            kurumOrt: cur.kurumOrt ?? okulListMeta.schoolSubjectNets[s.key],
            genelOrt: cur.genelOrt ?? okulListMeta.generalSubjectNets[s.key],
          };
        } else {
          mergedSubjects[s.key] = {
            ...cur,
            kurumOrt: cur.kurumOrt ?? okulListMeta.schoolSubjectNets[s.key],
            genelOrt: cur.genelOrt ?? okulListMeta.generalSubjectNets[s.key],
          };
        }
      }

      const dereceler: ExamRanks = {
        ...sp.dereceler,
        yuzdelik: listMatch?.dereceler.yuzdelik ?? sp.dereceler.yuzdelik,
      };

      const toplam = createTotalScore(mergedSubjects, {
        soru: sp.toplam.soru,
        dogru: sp.toplam.dogru,
        yanlis: sp.toplam.yanlis,
        bos: sp.toplam.bos,
        net: sp.toplam.net,
        basariYuzdesi: sp.toplam.basariYuzdesi,
        sinifOrt: sp.toplam.sinifOrt,
        kurumOrt: sp.toplam.kurumOrt ?? okulListMeta.schoolAvgToplamNet,
        genelOrt: sp.toplam.genelOrt ?? okulListMeta.generalAvgToplamNet,
      });

      const record: StudentExamRecord = {
        examId,
        examName: detectedExamName,
        examOrder,
        examDate,
        uploadedAt: nowIso,
        lgsPuan: sp.lgsPuan || listMatch?.lgsPuan || 0,
        genelOrtPuan: sp.genelOrtPuan ?? okulListMeta.generalAvgLgs,
        okulOrtPuan: okulListMeta.schoolAvgLgs,
        dereceler,
        katilimlar: sp.katilimlar ?? okulListMeta.katilimlar,
        subjects: mergedSubjects,
        toplam,
        kazanimlar: sp.kazanimlar,
      };

      records.push({
        studentKey: buildStudentKey(sp.numara, cleanName, sp.sinif),
        numara: sp.numara,
        name: cleanName,
        sinif: normalizeClassName(sp.sinif),
        record,
      });
    }
  } else if (dedupedOkulRows.length > 0) {
    for (const row of dedupedOkulRows) {
      const enrichedSubjects = { ...row.subjects };
      for (const s of SUBJECT_LIST) {
        enrichedSubjects[s.key] = {
          ...enrichedSubjects[s.key],
          kurumOrt: okulListMeta.schoolSubjectNets[s.key],
          genelOrt: okulListMeta.generalSubjectNets[s.key],
        };
      }
      const record: StudentExamRecord = {
        examId,
        examName: detectedExamName,
        examOrder,
        examDate,
        uploadedAt: nowIso,
        lgsPuan: row.lgsPuan,
        genelOrtPuan: okulListMeta.generalAvgLgs,
        okulOrtPuan: okulListMeta.schoolAvgLgs,
        dereceler: row.dereceler,
        katilimlar: okulListMeta.katilimlar,
        subjects: enrichedSubjects,
        toplam: {
          ...row.toplam,
          kurumOrt: okulListMeta.schoolAvgToplamNet,
          genelOrt: okulListMeta.generalAvgToplamNet,
        },
        kazanimlar: [],
      };
      records.push({
        studentKey: buildStudentKey(row.numara, row.name, row.sinif),
        numara: row.numara,
        name: row.name,
        sinif: normalizeClassName(row.sinif),
        record,
      });
    }
  }

  if (records.length === 0) {
    throw new Error(
      'PDF dosyasında okunabilir LGS deneme tablosu veya sonuç belgesi bulunamadı. Taranmış resim PDF yerine metin tabanlı deneme sonuç PDF dosyası yükleyin.'
    );
  }

  // Strictly deduplicate students within the same PDF (handles multi-page reports or repeated sections)
  // Also skip absent / "Girmedi" rows with 0 score, 0 D, 0 Y, and 0 net so they never dilute averages
  const dedupedRecordsMap = new Map<string, ParsedExamBundle['records'][number]>();
  for (const item of records) {
    if (
      item.record.lgsPuan <= 0 &&
      item.record.toplam.dogru === 0 &&
      item.record.toplam.yanlis === 0 &&
      item.record.toplam.net === 0
    ) {
      continue;
    }
    const nameSig = normalizeTurkish(item.name).replace(/\s+/g, '');
    const cleanNo = (item.numara || '').replace(/\D/g, '').replace(/^0+/, '');
    const dedupKey = nameSig.length >= 4 ? `N_${nameSig}` : cleanNo ? `NO_${cleanNo}` : item.studentKey;
    const prev = dedupedRecordsMap.get(dedupKey);
    if (!prev) {
      dedupedRecordsMap.set(dedupKey, item);
    } else {
      // Merge kazanımlar and keep the fuller/higher-info record
      const mergedKazanimlar =
        prev.record.kazanimlar.length >= item.record.kazanimlar.length
          ? prev.record.kazanimlar
          : item.record.kazanimlar;
      const preferNew =
        (item.record.lgsPuan > 0 && prev.record.lgsPuan === 0) ||
        item.record.kazanimlar.length > prev.record.kazanimlar.length;
      const chosen = preferNew ? item : prev;
      const other = preferNew ? prev : item;
      dedupedRecordsMap.set(dedupKey, {
        ...chosen,
        numara: chosen.numara && chosen.numara !== '0' ? chosen.numara : other.numara,
        name: chosen.name.length >= other.name.length ? chosen.name : other.name,
        sinif: chosen.sinif && !chosen.sinif.endsWith('-XX') ? chosen.sinif : other.sinif,
        record: {
          ...chosen.record,
          kazanimlar: mergedKazanimlar,
        },
      });
    }
  }
  const uniqueRecords = Array.from(dedupedRecordsMap.values());
  records.length = 0;
  records.push(...uniqueRecords);

  // Compute school averages if not explicitly provided in header
  const avgLgs =
    okulListMeta.schoolAvgLgs ??
    round2(records.reduce((s, r) => s + r.record.lgsPuan, 0) / records.length);
  const avgToplamNet =
    okulListMeta.schoolAvgToplamNet ??
    round2(records.reduce((s, r) => s + r.record.toplam.net, 0) / records.length);

  const computedSchoolSubjectNets: Partial<Record<SubjectKey, number>> = {
    ...okulListMeta.schoolSubjectNets,
  };
  for (const s of SUBJECT_LIST) {
    if (computedSchoolSubjectNets[s.key] === undefined) {
      computedSchoolSubjectNets[s.key] = round2(
        records.reduce((acc, r) => acc + r.record.subjects[s.key].net, 0) / records.length
      );
    }
  }

  for (const r of records) {
    if (r.record.okulOrtPuan === undefined) {
      r.record.okulOrtPuan = avgLgs;
    }
    if (r.record.toplam.kurumOrt === undefined) {
      r.record.toplam.kurumOrt = avgToplamNet;
    }
    for (const s of SUBJECT_LIST) {
      if (r.record.subjects[s.key].kurumOrt === undefined) {
        r.record.subjects[s.key].kurumOrt = computedSchoolSubjectNets[s.key];
      }
    }
  }

  const examMeta: ExamMeta = {
    id: examId,
    name: detectedExamName,
    fileName,
    schoolName: detectedSchoolName,
    location: detectedLocation,
    examDate,
    uploadedAt: nowIso,
    examOrder,
    studentCount: records.length,
    isSample: options?.isSample,
    schoolAvgLgs: avgLgs,
    generalAvgLgs: okulListMeta.generalAvgLgs ?? records[0]?.record.genelOrtPuan,
    schoolAvgToplamNet: avgToplamNet,
    generalAvgToplamNet: okulListMeta.generalAvgToplamNet ?? records[0]?.record.toplam.genelOrt,
    schoolSubjectNets: computedSchoolSubjectNets,
    generalSubjectNets: okulListMeta.generalSubjectNets,
  };

  return { examMeta, records };
}
