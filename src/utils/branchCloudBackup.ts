import { doc, getDocFromServer, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { readBranchBackup, readBranchCloudRevision } from './branchArchive';
import type { BranchExam } from './branchHistory';

const partLength = 125_000;
const limit = 20;

function assertAccount(uid: string) {
  if (auth.currentUser?.uid !== uid || !auth.currentUser.emailVerified) {
    throw new Error('Branş yedeği için doğrulanmış Google hesabınızla yeniden giriş yapın.');
  }
}

function getRefs(uid: string) {
  return {
    current: doc(db, 'users', uid, 'branchBackup', 'current'),
    part: (index: number) => doc(db, 'users', uid, 'branchBackupParts', String(index)),
  };
}

function readPointer(data: Record<string, unknown>) {
  const { revision, partCount, updatedAt } = data;
  if (typeof revision !== 'string' || !Number.isInteger(partCount) ||
      typeof partCount !== 'number' || partCount < 1 || partCount > limit) {
    throw new Error('Branş bulut yedeği okunamadı.');
  }
  return { revision, partCount, backupDate: updatedAt instanceof Timestamp ? updatedAt.toDate() : null };
}

function splitSnapshot(exams: BranchExam[]) {
  const source = JSON.stringify(readBranchBackup(exams));
  const result: string[] = [];
  for (let start = 0; start < source.length;) {
    let end = Math.min(start + partLength, source.length);
    const last = source.charCodeAt(end - 1);
    if (end < source.length && last >= 0xd800 && last <= 0xdbff) end--;
    result.push(source.slice(start, end));
    start = end;
  }
  if (result.length > limit) throw new Error('Branş bulut yedeği çok büyük. Deneme Arşivi’nden JSON yedek alın.');
  return result;
}

export async function backupBranchesToCloud(uid: string, exams: BranchExam[]) {
  assertAccount(uid);
  if (!exams.length) throw new Error('Yedeklenecek branş denemesi yok.');
  const previousRevision = readBranchCloudRevision(uid);
  const parts = splitSnapshot(exams);
  const revision = crypto.randomUUID();
  const refs = getRefs(uid);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(refs.current);
    assertAccount(uid);
    const previous = snap.exists() ? readPointer(snap.data()) : null;
    if ((previous?.revision ?? null) !== previousRevision) {
      throw new Error('Bu hesapta daha yeni veya bu cihazda açılmamış bir branş yedeği var. Önce bulut yedeğini geri yükleyin.');
    }
    for (const [index, payload] of parts.entries()) tx.set(refs.part(index), { ownerId: uid, revision, payload });
    for (let index = parts.length; index < (previous?.partCount ?? 0); index++) tx.delete(refs.part(index));
    tx.set(refs.current, { ownerId: uid, revision, partCount: parts.length, updatedAt: serverTimestamp() });
  });
  return revision;
}

export async function loadBranchesFromCloud(uid: string) {
  const refs = getRefs(uid);
  for (let attempt = 0; attempt < 2; attempt++) {
    assertAccount(uid);
    const snap = await getDocFromServer(refs.current);
    if (!snap.exists()) return null;
    const pointer = readPointer(snap.data());
    const parts = await Promise.all(Array.from({ length: pointer.partCount }, (_, index) => getDocFromServer(refs.part(index))));
    assertAccount(uid);
    const data = parts.map((part) => part.data());
    if (data.every((part) => part?.ownerId === uid && part.revision === pointer.revision && typeof part.payload === 'string')) {
      return {
        ...pointer,
        exams: readBranchBackup(JSON.parse(data.map((part) => part!.payload).join(''))),
      };
    }
  }
  throw new Error('Branş yedeği okunurken değişti veya eksik. Bir daha deneyin.');
}
