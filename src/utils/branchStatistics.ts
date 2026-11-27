import type { BranchMark, BranchResult } from './branchAnalysis';
import { normalizeTurkish } from './examLabels';

export const BRANCH_LEVELS = [
  { id: 'very-good', label: 'Çok iyi', minimum: 80, range: '80–100' },
  { id: 'good', label: 'İyi', minimum: 60, range: '60–79' },
  { id: 'medium', label: 'Orta', minimum: 40, range: '40–59' },
  { id: 'needs-work', label: 'Geliştirilmeli', minimum: 20, range: '20–39' },
  { id: 'very-low', label: 'Çok kötü', minimum: 0, range: '0–19' },
] as const;

export function branchLevel(percent: number) {
  return BRANCH_LEVELS.find(({ minimum }) => percent >= minimum) ?? BRANCH_LEVELS[4];
}

export function branchPercent(row: BranchResult) {
  return row.net / row.questionCount * 100;
}

export function rankBranchStudents(rows: BranchResult[]) {
  let rank = 0;
  let previousNet: number | undefined;
  return [...rows].sort((a, b) => b.net - a.net || a.name.localeCompare(b.name, 'tr')).map((row, index) => {
    if (row.net !== previousNet) rank = index + 1;
    previousNet = row.net;
    return { row, rank };
  });
}

export function summarizeBranchScores(rows: BranchResult[]) {
  const known = rows.filter(({ correct, incorrect, blank }) => correct !== null && incorrect !== null && blank !== null);
  const levels = new Map(BRANCH_LEVELS.map(({ id }) => [id, 0]));
  for (const row of rows) {
    const { id } = branchLevel(branchPercent(row));
    levels.set(id, (levels.get(id) ?? 0) + 1);
  }
  return {
    averageNet: rows.length ? rows.reduce((sum, row) => sum + row.net, 0) / rows.length : null,
    known: known.length,
    averageCorrect: mean(known.map((row) => row.correct!)),
    averageIncorrect: mean(known.map((row) => row.incorrect!)),
    averageBlank: mean(known.map((row) => row.blank!)),
    levels,
  };
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function summarizeBranchOutcomes(rows: BranchResult[]) {
  const topics = new Map<string, { title: string; total: number; correct: number; incorrect: number; blank: number; students: number }>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const outcome of row.outcomes ?? []) {
      const title = outcome.text.trim();
      const key = normalizeTurkish(title);
      if (!key || outcome.soru <= 0 || outcome.dogru + outcome.yanlis + outcome.bos !== outcome.soru) continue;
      const item = topics.get(key) ?? { title, total: 0, correct: 0, incorrect: 0, blank: 0, students: 0 };
      item.total += outcome.soru;
      item.correct += outcome.dogru;
      item.incorrect += outcome.yanlis;
      item.blank += outcome.bos;
      if (!seen.has(key)) item.students++;
      seen.add(key);
      topics.set(key, item);
    }
  }
  return [...topics.values()].map((item) => ({ ...item, rate: item.correct / item.total }))
    .sort((a, b) => a.rate - b.rate || b.students - a.students || a.title.localeCompare(b.title, 'tr'));
}

type Observation = { mark: BranchMark; restNet: number };

function discrimination(observations: Observation[]) {
  if (observations.length < 4) return null;
  const averageMark = observations.filter(({ mark }) => mark === 'D').length / observations.length;
  const averageNet = mean(observations.map(({ restNet }) => restNet))!;
  let covariance = 0, markVariance = 0, netVariance = 0;
  for (const { mark, restNet } of observations) {
    const x = Number(mark === 'D') - averageMark;
    const y = restNet - averageNet;
    covariance += x * y;
    markVariance += x * x;
    netVariance += y * y;
  }
  const denominator = Math.sqrt(markVariance * netVariance);
  return denominator > 1e-9 ? Math.min(1, Math.max(-1, covariance / denominator)) : null;
}

export function summarizeBranchItems(rows: BranchResult[]) {
  const questions = new Map<number, Observation[]>();
  for (const row of rows) {
    const responses = Object.entries(row.items ?? {}).flatMap(([key, mark]) => {
      const question = Number(key);
      return Number.isInteger(question) && question >= 1 && question <= row.questionCount &&
        (mark === 'D' || mark === 'Y' || mark === 'B') ? [{ question, mark }] : [];
    });
    // Use the observed response grid for corrected item-total correlation.
    const score = (mark: BranchMark) => mark === 'D' ? 1 : mark === 'Y' ? -1 / 3 : 0;
    const total = responses.length === row.questionCount
      ? responses.reduce((sum, { mark }) => sum + score(mark), 0) : null;
    for (const { question, mark } of responses) {
      const observations = questions.get(question) ?? [];
      observations.push({ mark, restNet: total === null ? NaN : total - score(mark) });
      questions.set(question, observations);
    }
  }
  return [...questions].sort(([a], [b]) => a - b).map(([question, observations]) => {
    const incorrect = observations.filter(({ mark }) => mark === 'Y').length;
    const blank = observations.filter(({ mark }) => mark === 'B').length;
    const correct = observations.length - incorrect - blank;
    const comparable = observations.filter(({ restNet }) => Number.isFinite(restNet));
    return {
      question, correct, incorrect, blank, count: observations.length,
      difficulty: correct / observations.length,
      discrimination: discrimination(comparable),
      discriminationCount: comparable.length,
    };
  });
}
