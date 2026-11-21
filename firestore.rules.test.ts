/**
 * Phase 0 Security TDD Specification for Firestore Security Rules.
 * Documents the 12 adversarial ("Dirty Dozen") test cases that must return PERMISSION_DENIED
 * when evaluated against firestore.rules in the Firebase Rules Unit Testing emulator.
 */

export interface DirtyDozenTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: DirtyDozenTestCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read blocked',
    operation: 'get',
    path: '/users/userA/students/NO_435',
    auth: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-tenant single document read blocked',
    operation: 'get',
    path: '/users/userA/exams/exam_1',
    auth: { uid: 'userB', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-tenant list scraping blocked',
    operation: 'list',
    path: '/users/userA/students',
    auth: { uid: 'userB', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Identity spoofing via mismatched ownerId blocked',
    operation: 'create',
    path: '/users/userA/exams/exam_1',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      id: 'exam_1',
      ownerId: 'userB',
      name: 'Deneme 1',
      fileName: 'deneme1.pdf',
      schoolName: 'Okul',
      location: '',
      examDate: '2026-11-21',
      uploadedAt: '2026-11-21T00:00:00.000Z',
      examOrder: 1,
      studentCount: 88,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Unverified email write blocked',
    operation: 'create',
    path: '/users/userA',
    auth: { uid: 'userA', email_verified: false },
    payload: {
      ownerId: 'userA',
      displayName: 'Teacher',
      examCount: 0,
      studentCount: 0,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Shadow / ghost field injection blocked',
    operation: 'create',
    path: '/users/userA/students/NO_435',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      id: 'NO_435',
      ownerId: 'userA',
      numara: '435',
      name: 'HALİL BALCI',
      sinif: '8-B',
      exams: [],
      isAdmin: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Invalid document ID characters rejected',
    operation: 'create',
    path: '/users/userA/exams/invalid id!!!',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      id: 'invalid id!!!',
      ownerId: 'userA',
      name: 'Deneme',
      fileName: 'a.pdf',
      schoolName: '',
      location: '',
      examDate: '2026-11-21',
      uploadedAt: '2026-11-21T00:00:00.000Z',
      examOrder: 1,
      studentCount: 1,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Orphaned exam write without parent user archive blocked',
    operation: 'create',
    path: '/users/userA/exams/exam_orphan',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      id: 'exam_orphan',
      ownerId: 'userA',
      name: 'Orphan',
      fileName: 'orphan.pdf',
      schoolName: '',
      location: '',
      examDate: '2026-11-21',
      uploadedAt: '2026-11-21T00:00:00.000Z',
      examOrder: 1,
      studentCount: 1,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Immutable ownerId/createdAt mutation on update blocked',
    operation: 'update',
    path: '/users/userA/students/NO_435',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      ownerId: 'userB',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Forged client timestamp rejected',
    operation: 'update',
    path: '/users/userA',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      examCount: 2,
      updatedAt: '2020-01-01T00:00:00.000Z',
      lastBackupAt: '2020-01-01T00:00:00.000Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Oversized exam name (>200 chars) rejected',
    operation: 'update',
    path: '/users/userA/exams/exam_1',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      name: 'A'.repeat(250),
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Malformed non-map element in student exams array rejected',
    operation: 'update',
    path: '/users/userA/students/NO_435',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      exams: ['malicious-string-instead-of-record-map'],
    },
    expected: 'PERMISSION_DENIED',
  },
];
