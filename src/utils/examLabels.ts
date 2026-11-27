import type { SubjectKey } from '../types/exam';

export function normalizeTurkish(str: string): string {
  return str
    .normalize('NFC')
    .replace(/İ/g, 'I')
    .replace(/ı/g, 'i')
    .replace(/Ğ/g, 'G')
    .replace(/ğ/g, 'g')
    .replace(/Ü/g, 'U')
    .replace(/ü/g, 'u')
    .replace(/Ş/g, 'S')
    .replace(/ş/g, 's')
    .replace(/Ö/g, 'O')
    .replace(/ö/g, 'o')
    .replace(/Ç/g, 'C')
    .replace(/ç/g, 'c')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export function normalizeClassName(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '');
  // Convert 8/A, 8.A, 8A -> 8-A
  const m = cleaned.match(/^(\d{1,2})[./\-_]?([A-ZÇĞİÖŞÜ0-9]+)$/);
  if (m) {
    return `${m[1]}-${m[2]}`;
  }
  return cleaned || '8-A';
}

export function buildStudentKey(numara: string, name: string, sinif: string): string {
  const cleanNo = (numara || '').replace(/\D/g, '').replace(/^0+/, '');
  const cleanName = normalizeTurkish(name).replace(/\s+/g, '_');
  const cleanSinif = normalizeTurkish(normalizeClassName(sinif)).replace(/\s+/g, '_');
  if (cleanNo) {
    return `NO_${cleanNo}`;
  }
  return `NAME_${cleanName}_${cleanSinif}`.slice(0, 120);
}

export function matchSubjectLabel(raw: string): SubjectKey | null {
  const norm = normalizeTurkish(raw);
  if (!norm) return null;
  if (
    norm === 'TURKCE' ||
    norm === 'TUR' ||
    norm === 'TR' ||
    norm.includes('SOZEL TUR') ||
    norm.startsWith('TURKCE')
  ) {
    return 'turkce';
  }
  if (
    norm === 'TARIH' ||
    norm === 'TAR' ||
    norm === 'INK' ||
    norm === 'INKILAP' ||
    norm === 'SOSYAL' ||
    norm.includes('INKILAP') ||
    norm.includes('SOZEL TAR') ||
    norm.includes('T C INK') ||
    norm.includes('TC INK') ||
    norm.startsWith('TARIH')
  ) {
    return 'tarih';
  }
  if (
    norm === 'DIN' ||
    norm === 'DKAB' ||
    norm.startsWith('DIN K') ||
    norm.startsWith('DIN ') ||
    norm.includes('SOZEL DIN') ||
    norm.includes('AHLAK')
  ) {
    return 'din';
  }
  if (
    norm === 'INGILIZCE' ||
    norm === 'ING' ||
    norm === 'YABANCI DIL' ||
    norm === 'YAB DIL' ||
    norm === 'YAB' ||
    norm.startsWith('INGILIZ') ||
    norm.includes('SOZEL ING') ||
    norm.includes('YABANCI DIL')
  ) {
    return 'ingilizce';
  }
  if (
    norm === 'MATEMATIK' ||
    norm === 'MAT' ||
    norm.startsWith('MATEMAT') ||
    norm.includes('SAYISAL MAT')
  ) {
    return 'matematik';
  }
  if (
    norm === 'FEN' ||
    norm === 'FB' ||
    norm.startsWith('FEN BIL') ||
    norm.startsWith('FEN VE') ||
    norm.includes('SAYISAL FEN')
  ) {
    return 'fen';
  }
  return null;
}
