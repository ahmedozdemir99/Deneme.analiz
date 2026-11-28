import { isAttendedExamRecord } from './analytics';
import { buildStudentKey, examRosterKey, matchSubjectLabel, normalizeClassName, normalizeTurkish } from './examLabels';
import { branchColumn, branchQuestionColumn, buildBranchResults, readBranchItems, validBranchColumns, type BranchTableColumn, type BranchItems, type BranchOptions, type BranchSourceRow } from './branchAnalysis';
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

async function loadPdfReader() {
  const reader = await import('pdfjs-dist');
  reader.GlobalWorkerOptions.workerSrc = workerSrc;
  return reader;
}

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
  classX?: number;
  rankColumns: Array<{ key: keyof ExamRanks; x: number }>;
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
  unreadSubjects: SubjectKey[];
  inconsistentTotal: boolean;
}

function pdfResultKey(row: Pick<OkulListRow, 'numara' | 'name' | 'sinif' | 'dereceler'>) {
  const identity = examRosterKey(row.numara, row.name, row.sinif);
  // A ranked list can contain distinct results for the same name and class without student numbers.
  return !/[1-9]/.test(row.numara) && row.dereceler.okul ? `${identity}:${row.dereceler.okul}` : identity;
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

const scoreHeader = /^(D|Y|B|N|NET|DOGRU|YANLIS|BOS)$/;

function splitScoreHeaders(token: TextToken): TextToken[] {
  const parts = normalizeTurkish(token.str).split(' ');
  if (parts.length < 2 || !parts.every((part) => scoreHeader.test(part))) return [token];
  return parts.map((str, index) => ({
    ...token, str, x: token.x + index * token.width / parts.length, width: token.width / parts.length,
  }));
}

function tokenCenter(token: TextToken) {
  return token.x + token.width / 2;
}

function rankColumnKey(label: string): keyof ExamRanks | undefined {
  const axis = label.replace(/ (DRC|DERECE|SIRA|SIRASI)$/, '');
  if (/^(SB|SNF|SINIF|SUBE)$/.test(axis)) return 'sinif';
  if (/^(KRM|KURUM|OKUL)$/.test(axis)) return 'okul';
  if (axis === 'ILCE' || axis === 'IL' || axis === 'GENEL') return axis.toLowerCase() as 'ilce' | 'il' | 'genel';
  return undefined;
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

    // Compact reports can place a two-line subject label just above the main header.
    const adjacent = lines.slice(Math.max(0, i - 3), i + 4)
      .filter((candidate) => Math.abs(candidate.y - line.y) <= 7);
    for (const tok of [line, ...adjacent.filter((candidate) => candidate !== line)].flatMap((candidate) => candidate.tokens)) {
      const norm = normalizeTurkish(tok.str);
      const key = norm === 'TOPLAM' || norm === 'TOP' ? 'toplam' : matchSubjectLabel(tok.str);
      if (key && !seen.has(key)) {
        seen.add(key);
        found.push({ key, x: tok.x, centerX: tokenCenter(tok) });
      }
    }

    const subjCount = found.filter((f) => f.key !== 'toplam').length;
    if (subjCount < 3) continue;

    const onMainLine = line.tokens.filter((token) => matchSubjectLabel(token.str)).length;
    const score = subjCount * 10 + (seen.has('toplam') ? 5 : 0) + onMainLine;
    if (score > bestScore) {
      bestScore = score;
      subjectLineIdx = i;
      subjectAnchors = found.sort((a, b) => a.centerX - b.centerX);
    }
  }

  if (subjectLineIdx === -1 || subjectAnchors.length < 3) return null;

  const subjectLine = lines[subjectLineIdx];

  // Some columns print D/Y/N a few points lower than their neighbors.
  const candidates = lines.slice(subjectLineIdx + 1, subjectLineIdx + 6)
    .filter((line) => subjectLine.y - line.y <= 28)
    .map((line) => line.tokens.flatMap(splitScoreHeaders).filter((token) => scoreHeader.test(normalizeTurkish(token.str))));
  const firstMetricY = candidates.find((tokens) => tokens.length >= 3)?.[0].y;
  const subHeaderTokens = firstMetricY === undefined ? [] : candidates.flat()
    .filter((token) => Math.abs(token.y - firstMetricY) <= 7);

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

    const colSubs = subHeaderTokens.filter((t) => tokenCenter(t) >= minX && tokenCenter(t) < maxX);
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
  const nearbyHeaders = lines.filter((line) => Math.abs(line.y - subjectLine.y) <= 9)
    .flatMap((line) => line.tokens);
  const leftHeaders = nearbyHeaders.filter((token) => token.x < firstSubjX);
  const siraTok = leftHeaders.find((token) => /^(SIRA(?: NO)?|SR|#)$/i.test(normalizeTurkish(token.str)));
  const noTok = leftHeaders.find((token) =>
    /^(O NO|ONO|OGR NO|OGRENCI NO|NUMARA|OKUL NO|NO)$/.test(normalizeTurkish(token.str)) &&
    (!siraTok || Math.abs(tokenCenter(token) - tokenCenter(siraTok)) > 8)
  );
  const nameTok = leftHeaders.find((token) => /^(ISIM|AD SOYAD|ADI SOYADI|OGRENCI)$/.test(normalizeTurkish(token.str)));
  const classTok = leftHeaders.find((token) => /^(SINIF|SUBE|SNF|SB)$/.test(normalizeTurkish(token.str)));

  const lastColMaxX = columns[columns.length - 1].maxX;
  const rightHeaders = nearbyHeaders.filter((token) => token.x >= lastColMaxX - 6);
  const lgsTok = rightHeaders.find((token) => /^(LGS(?: PUANI?)?|PUANI?)$/.test(normalizeTurkish(token.str)));
  const ranks = new Map<keyof ExamRanks, number>();
  for (const token of rightHeaders) {
    const key = rankColumnKey(normalizeTurkish(token.str));
    if (key && !ranks.has(key)) ranks.set(key, tokenCenter(token));
  }
  const rankColumns = [...ranks].map(([key, x]) => ({ key, x })).sort((a, b) => a.x - b.x);
  const rankTok = rightHeaders.find((token) => /^(DERECE|SIRALAMA)$/.test(normalizeTurkish(token.str)));

  const lgsMinX = lgsTok ? Math.max(lastColMaxX, lgsTok.x - 10) : lastColMaxX;
  const lgsCenter = lgsTok ? tokenCenter(lgsTok) : lgsMinX + 14;
  const lgsMaxX = rankColumns.length
    ? (lgsCenter + rankColumns[0].x) / 2
    : rankTok ? Math.max(lgsMinX + 26, rankTok.x - 4) : Math.min(pageWidth, lgsMinX + 42);

  return {
    headerY: subHeaderTokens.length ? Math.min(...subHeaderTokens.map((token) => token.y)) : subjectLine.y,
    columns,
    siraRange: siraTok ? [siraTok.x - 10, Math.min(noTok?.x ?? Infinity, classTok?.x ?? Infinity, siraTok.x + 18)] : undefined,
    noRange: noTok ? [noTok.x - 5, nameTok && nameTok.x > noTok.x ? nameTok.x - 2 : noTok.x + 22] : undefined,
    classX: classTok && tokenCenter(classTok),
    lgsRange: [lgsMinX, lgsMaxX],
    rankStartX: rankTok ? rankTok.x - 4 : lgsMaxX,
    rankColumns,
    pageWidth,
  };
}

function readTableScore(tokens: TextToken[], column: DynamicColumnDef) {
  const numbers = tokens.flatMap((token) => {
    const x = tokenCenter(token);
    const value = parseTrNumber(token.str);
    return x >= column.minX && x < column.maxX && value !== null
      ? [{ x, value, decimal: isDecimalStr(token.str) }] : [];
  });
  const slots = [
    { key: 'dogru', x: column.dX }, { key: 'yanlis', x: column.yX },
    { key: 'bos', x: column.bX }, { key: 'net', x: column.nX },
  ] as const;
  const score: Partial<Pick<SubjectScore, 'dogru' | 'yanlis' | 'bos' | 'net'>> = {};
  const distances = new Map<string, number>();
  for (const number of numbers) {
    let closest: typeof slots[number] | undefined;
    let distance = Infinity;
    for (const slot of slots) {
      if (slot.x === undefined) continue;
      const gap = Math.abs(slot.x - number.x);
      if (gap < distance) {
        closest = slot;
        distance = gap;
      }
    }
    if (closest && distance < (distances.get(closest.key) ?? Infinity)) {
      distances.set(closest.key, distance);
      score[closest.key] = number.value;
    }
  }
  if (distances.size) return score;
  if (numbers.length === 1 && numbers[0].decimal) {
    return { net: numbers[0].value };
  }
  return {
    dogru: numbers[0]?.value, yanlis: numbers[1]?.value,
    bos: numbers.length >= 4 ? numbers[2]?.value : undefined,
    net: numbers.slice(2).find((number) => number.decimal)?.value ?? numbers[3]?.value ?? numbers[2]?.value,
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
    if (line.y > layout.headerY + 14) {
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
        const netVal = readTableScore(expanded, col).net;
        if (netVal !== undefined) {
          if (isGeneral) meta.generalSubjectNets[col.key] = netVal;
          else meta.schoolSubjectNets[col.key] = netVal;
        }
      }
      if (toplamCol) {
        const topNet = readTableScore(expanded, toplamCol).net;
        if (topNet !== undefined) {
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
      /(?:^| )ORTALAMA(?:LAR|SI)?(?: |$)/.test(normFull) ||
      normFull.startsWith('SAYFA ')
    ) {
      continue;
    }

    // Identify student row: must have a name left of the first subject column and numeric score values
    const firstSubjectMinX = layout.columns[0].minX;
    const leftToks = expanded.filter((token) => tokenCenter(token) < firstSubjectMinX);
    if (leftToks.length === 0) continue;

    const intLeftToks = leftToks.filter((token) => /^\d+$/.test(token.str));
    const siraRange = layout.siraRange;
    if (siraRange && !intLeftToks.some((token) => tokenCenter(token) >= siraRange[0] && tokenCenter(token) < siraRange[1])) continue;

    const classX = layout.classX;
    const sinifTok = leftToks.find((token) => /^\d{1,2}(?:[./-][A-ZÇĞİÖŞÜ0-9]{1,3}|[A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ0-9]{0,2})$/i.test(token.str))
      ?? leftToks.find((token) => classX !== undefined && Math.abs(tokenCenter(token) - classX) <= 7 && /^[A-ZÇĞİÖŞÜ]{1,2}$/i.test(token.str));
    const rawClass = sinifTok?.str;
    const classroom = rawClass && /^\d/.test(rawClass) ? rawClass : rawClass ? `8-${rawClass}` : '8-XX';
    const noRange = layout.noRange;
    const noVal = (noRange
      ? intLeftToks.find((token) => tokenCenter(token) >= noRange[0] && tokenCenter(token) < noRange[1])?.str
      : intLeftToks[1]?.str) || '0';

    const nameToks = leftToks.filter(
      (t) =>
        t !== sinifTok &&
        !intLeftToks.includes(t) &&
        /\p{L}/u.test(t.str)
    );
    const name = nameToks.map((t) => t.str.trim()).join(' ').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 3) continue;
    // Skip header repetitions
    if (/^(OGRENCI|AD SOYAD|ADI SOYADI|ISIM|TOPLAM|ORTALAMA)$/.test(normalizeTurkish(name))) {
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

    const unreadSubjects = new Set(SUBJECT_LIST.map(({ key }) => key));
    for (const col of subjectCols) {
      const value = readTableScore(expanded, col);
      if (Object.values(value).every((metric) => metric === undefined)) continue;
      unreadSubjects.delete(col.key);
      const correct = value.dogru ?? (value.yanlis === undefined ? Math.max(0, Math.round(value.net ?? 0)) : 0);
      subjects[col.key] = createSubjectScore(col.key, correct, value.yanlis ?? 0, value.net, null, { bosOverride: value.bos });
    }

    if (unreadSubjects.size === SUBJECT_LIST.length) continue;

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
      const score = readTableScore(expanded, toplamCol);
      topD = score.dogru;
      topY = score.yanlis;
      topB = score.bos;
      topNet = score.net;
    } else if (ints.length >= 2) {
      topD = ints[0].val;
      topY = ints[1].val;
    }

    const lgsRange = layout.lgsRange;
    const lgsCandidate = lgsRange && expanded.find((token) => {
      const x = tokenCenter(token);
      const value = parseTrNumber(token.str);
      return x >= lgsRange[0] && x < lgsRange[1] && value !== null && value > 95 && value <= 500;
    });
    const fallbackLgs = decimals.find((number) => number.val > 95 && number.val <= 500)?.val;
    lgsPuan = parseTrNumber(lgsCandidate?.str) ?? fallbackLgs ?? 0;
    const scoreTotals = createTotalScore(subjects);
    const inconsistentTotal = (topD !== undefined && topD !== scoreTotals.dogru) ||
      (topY !== undefined && topY !== scoreTotals.yanlis) ||
      (topNet !== undefined && Math.abs(topNet - scoreTotals.net) > 0.04);
    topNet ??= decimals.find((number) => number.val >= -30 && number.val <= 90)?.val;

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
    if (layout.rankColumns.length >= 2) {
      const rankNumbers = expanded.filter((token) => /^\d+$/.test(token.str));
      layout.rankColumns.forEach(({ key, x }, index) => {
        const previous = layout.rankColumns[index - 1];
        const following = layout.rankColumns[index + 1];
        const left = previous ? (previous.x + x) / 2 : layout.lgsRange?.[1] ?? x - 10;
        const right = following ? (following.x + x) / 2 : layout.pageWidth;
        const value = rankNumbers.find((token) => tokenCenter(token) >= left && tokenCenter(token) < right);
        if (value) dereceler[key] = Number(value.str);
      });
    } else if (layout.rankStartX) {
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
      sinif: normalizeClassName(classroom),
      subjects,
      toplam,
      lgsPuan,
      dereceler,
      unreadSubjects: [...unreadSubjects],
      inconsistentTotal,
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
    const column = branchQuestionColumn(str) ?? branchColumn(str, subject);
    return column && column !== 'name' && column !== 'number' && column !== 'classroom';
  });
  let upperHeader: { columns: Map<BranchTableColumn, number>; subjects: Set<SubjectKey> } | undefined;
  for (const [index, line] of lines.entries()) {
    const columns = new Map<BranchTableColumn, number>();
    const explicit = new Set<SubjectKey>();
    for (let i = 0; i < line.tokens.length; i++) {
      const first = line.tokens[i];
      for (let size = Math.min(5, line.tokens.length - i); size >= 1; size--) {
        const segment = line.tokens.slice(i, i + size);
        const label = segment.map(({ str }) => str).join(' ');
        const channel = branchQuestionColumn(label) ?? branchColumn(label, subject);
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

function readBranchTableRows(lines: LineCluster[], columns: Map<BranchTableColumn, number>): BranchSourceRow[] {
  const anchors = [...columns.entries()].sort((a, b) => a[1] - b[1]);
  return lines.map((line) => {
    const values = new Map<BranchTableColumn, string>();
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
      items: readBranchItems(values),
    };
  });
}

function readZipGradeBranchPage(lines: LineCluster[], options: BranchOptions): BranchSourceRow | undefined {
  // PDF.js can combine adjacent header cells (such as "Pts Poss") into a single text item.
  const header = lines.find(({ tokens }) => {
    const text = tokens.map(({ str }) => str).join(' ').normalize('NFC');
    const labels = normalizeTurkish(text);
    return text.includes('#') && /\b(?:ANAHT|ANAHTAR|KEY) STU PTS POSS\b/.test(labels);
  });
  if (!header) return undefined;
  const labels = header.tokens.flatMap(({ str, x, width }) =>
    [...str.matchAll(/\S+/g)].map((word) => ({ str: word[0], x: x + width * word.index / str.length })));
  const numberX = labels.find(({ str }) => str.trim() === '#')!.x;
  const keyX = labels.find(({ str }) => ['ANAHT', 'ANAHTAR', 'KEY'].includes(normalizeTurkish(str)))!.x;
  const studentX = labels.find(({ str }) => normalizeTurkish(str) === 'STU')!.x;
  const pointsX = labels.find(({ str }) => normalizeTurkish(str) === 'PTS')!.x;
  const possibleX = labels.find(({ str }) => normalizeTurkish(str) === 'POSS')!.x;
  if (!(numberX < keyX && keyX < studentX && studentX < pointsX && pointsX < possibleX)) {
    throw new Error('ZipGrade soru tablosunun sütunları okunamadı.');
  }

  const studentFields = new Map<string, string>();
  for (const line of lines) {
    const text = line.tokens.filter(({ x }) => x < numberX - 12).map(({ str }) => str).join(' ');
    const separator = text.indexOf(':');
    if (separator >= 0) studentFields.set(normalizeTurkish(text.slice(0, separator)), text.slice(separator + 1).trim());
  }
  const studentName = studentFields.get('OGRENCI') ?? studentFields.get('OGRENCI ADI') ??
    studentFields.get('STUDENT') ?? studentFields.get('STUDENT NAME');
  if (!studentName) throw new Error('ZipGrade öğrenci adı okunamadı.');

  const marks: BranchItems = {};
  const edges = [numberX - 14, (numberX + keyX) / 2, (keyX + studentX) / 2,
    (studentX + pointsX) / 2, (pointsX + possibleX) / 2, possibleX + 55];
  for (const { tokens } of lines.slice(lines.indexOf(header) + 1)) {
    const cells = edges.slice(0, -1).map((left, index) =>
      tokens.filter(({ x }) => x >= left && x < edges[index + 1]).map(({ str }) => str).join(' ').trim());
    const question = Number(cells[0]);
    if (!/^\d+$/.test(cells[0]) || question < 1 || !cells[1]) continue;
    const earned = parseTrNumber(cells[3]);
    const possible = parseTrNumber(cells[4]);
    if (earned === null || possible === null || possible <= 0 ||
        (earned !== 0 && Math.abs(earned - possible) > 1e-6) || marks[question]) {
      throw new Error(`ZipGrade tablosunda ${question}. sorunun puanı geçersiz, kısmi veya yinelenmiş.`);
    }
    const answer = normalizeTurkish(cells[2]);
    marks[question] = earned > 0 ? 'D' : !answer || answer === 'BOS' || answer === 'BLANK' ? 'B' : 'Y';
  }

  const questions = Object.keys(marks).length;
  if (questions !== options.questionCount || Array.from({ length: questions }, (_, index) => index + 1).some((n) => !marks[n])) {
    throw new Error(`ZipGrade sayfasında ${questions} soru okundu. Soru sayısını kontrol edin ve eksiksiz sonuç PDF’sini seçin.`);
  }
  return {
    name: studentName,
    number: studentFields.get('OGRENCI NO') ?? studentFields.get('STUDENT ID') ?? '',
    classroom: studentFields.get('SINIF') ?? studentFields.get('CLASS') ?? '',
    questionCount: questions,
    items: marks,
  };
}

export async function parseBranchPdf(source: ArrayBuffer, options: BranchOptions) {
  const pdfjsLib = await loadPdfReader();
  const task = pdfjsLib.getDocument({ data: new Uint8Array(source), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const rows: BranchSourceRow[] = [];
    let tableColumns: Map<BranchTableColumn, number> | undefined;
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
      const zipGrade = readZipGradeBranchPage(lines, options);
      if (zipGrade) {
        tableColumns = undefined;
        rows.push(zipGrade);
        continue;
      }
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
  const pdfjsLib = await loadPdfReader();
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
  let activeClassroom: string | undefined;
  let dateFromPdf: string | undefined;

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

    const dateMatch = headerProbe.match(/SINAV TARIHI (\d{1,2}) (\d{1,2}) (\d{4})(?: |$)/);
    if (!dateFromPdf && dateMatch) {
      const [, day, month, year] = dateMatch;
      const candidate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      const parsedDate = new Date(candidate);
      if (Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === candidate) {
        dateFromPdf = candidate;
      }
    }

    const classList = headerProbe.match(/(?:^|\s)(\d{1,2}\s+[A-Z]) (?:SINIFI|SUBE) NET LISTESI/);
    const explicitSchoolList = /(?:OKUL|KURUM) NET LISTESI|SONUC LISTESI|SIRALI LISTE/.test(headerProbe);
    if (explicitSchoolList) activeClassroom = undefined;
    if (classList) activeClassroom = normalizeClassName(classList[1]);
    const explicitClassList = /SINIFI NET LISTESI|SUBE NET LISTESI/.test(headerProbe);
    const isPerClassList = Boolean(activeClassroom) || explicitClassList;

    // Skip class/school summary-only report cards (ŞUBE KARNESİ / KURUM KARNESİ)
    if (headerProbe.includes('SUBE KARNESI') || headerProbe.includes('KURUM KARNESI') ||
      (!explicitSchoolList && /^(?:DERS BASARI ORANLARI|PUAN) KARSILASTIRMA GRAFIGI/.test(headerProbe))) {
      activeTabularLayout = null;
      activeClassroom = undefined;
      options?.onProgress?.(pageNum, totalPages);
      continue;
    }

    // Check individual student report card first
    if (!explicitSchoolList && !explicitClassList && /SONUC BELGESI|OGRENCI KARNESI|BIREYSEL KARNE/.test(headerProbe)) {
      const parsed = parseSonucBelgesiPage(tokens, pageWidth);
      if (parsed) {
        sonucPages.push(parsed);
        activeTabularLayout = null;
        activeClassroom = undefined;
        options?.onProgress?.(pageNum, totalPages);
        continue;
      }
    }

    // Class lists can be the only roster. Parse them alongside the school list and
    // remove repeated rows later, when their actual student identity is available.
    const pageMeta: OkulListMeta = isPerClassList
      ? { generalSubjectNets: {}, schoolSubjectNets: {} }
      : okulListMeta;
    const startingRow = okulListRows.length;
    activeTabularLayout = parseTabularListPage(
      tokens,
      pageWidth,
      pageMeta,
      okulListRows,
      activeTabularLayout
    );
    if (activeClassroom) {
      for (let index = startingRow; index < okulListRows.length; index++) {
        if (okulListRows[index].sinif === '8-XX') {
          okulListRows[index].sinif = activeClassroom;
        }
      }
    }

    options?.onProgress?.(pageNum, totalPages);
  }

  await loadingTask.destroy();

  // Deduplicate okulListRows in case a PDF repeated students across sections
  const uniqueOkulMap = new Map<string, OkulListRow>();
  for (const row of okulListRows) {
    const key = pdfResultKey(row);
    if (!uniqueOkulMap.has(key)) {
      uniqueOkulMap.set(key, row);
    }
  }
  const coveredListRows = new Set<string>();

  const nowIso = new Date().toISOString();
  const examDate = options?.examDate || dateFromPdf || nowIso.slice(0, 10);
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
      const key = pdfResultKey(sp);
      const identity = examRosterKey(sp.numara, sp.name, sp.sinif);
      const sameIdentity = [...uniqueOkulMap.values()].filter((row) =>
        examRosterKey(row.numara, row.name, row.sinif) === identity);
      const listMatch = uniqueOkulMap.get(key) ?? (sameIdentity.length === 1 ? sameIdentity[0] : undefined);

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

      if (listMatch && isAttendedExamRecord(record)) coveredListRows.add(pdfResultKey(listMatch));
      records.push({
        studentKey: buildStudentKey(sp.numara, cleanName, sp.sinif),
        numara: sp.numara,
        name: cleanName,
        sinif: normalizeClassName(sp.sinif),
        record,
      });
    }
  }
  for (const [key, row] of uniqueOkulMap) {
    if (coveredListRows.has(key)) continue;
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

  if (records.length === 0) {
    throw new Error(
      'PDF dosyasında okunabilir LGS deneme tablosu veya sonuç belgesi bulunamadı. Taranmış resim PDF yerine metin tabanlı deneme sonuç PDF dosyası yükleyin.'
    );
  }

  // Strictly deduplicate students within the same PDF (handles multi-page reports or repeated sections)
  // Also skip absent / "Girmedi" rows with 0 score, 0 D, 0 Y, and 0 net so they never dilute averages
  const dedupedRecordsMap = new Map<string, ParsedExamBundle['records'][number]>();
  for (const item of records) {
    if (!isAttendedExamRecord(item.record)) continue;
    const dedupKey = pdfResultKey({ ...item, dereceler: item.record.dereceler });
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
  if (!records.length) throw new Error('PDF dosyasında sınava katılan öğrencilerin sonucu bulunamadı.');

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

  const unreadSubjects = new Set([...uniqueOkulMap.values()].flatMap((row) => row.unreadSubjects));
  const inconsistentTotals = [...uniqueOkulMap.values()].filter((row) => row.inconsistentTotal).length;
  const warnings = [];
  if (unreadSubjects.size) {
    warnings.push(`Bazı sonuçlarda şu derslerin değerleri okunamadı: ${[...unreadSubjects].map((key) => SUBJECT_MAP[key].label).join(', ')}.`);
  }
  if (inconsistentTotals) {
    warnings.push(`${inconsistentTotals} satırda ders değerleri PDF’deki toplamla uyuşmuyor. Sonuçları kaynak listeyle karşılaştırın.`);
  }
  return { examMeta, records, warnings };
}
