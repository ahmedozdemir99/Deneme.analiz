# Security Specification — LGS Deneme Analiz Cloud Archive

## 1. Data Invariants
1. **Strict Single-Tenant Isolation (Master Gate)**: Every user archive lives under `/users/{userId}`. Only the verified owner (`request.auth.uid == userId` and `request.auth.token.email_verified == true`) can read or write `/users/{userId}` or any document in `/users/{userId}/exams/{examId}` or `/users/{userId}/students/{studentId}`.
2. **Parent Existence Invariant**: An `ExamDocument` or `StudentDocument` cannot be created, updated, or deleted unless the parent `/users/{userId}` document exists and belongs to `request.auth.uid`.
3. **Immutable Ownership & Creation Timestamps**: `ownerId`, `id`, and `createdAt` can never be mutated after creation.
4. **Server Timestamp Integrity**: `createdAt`, `updatedAt`, and `lastBackupAt` MUST strictly equal `request.time`. Client-forged timestamps are rejected.
5. **Bounded Volumetric Payloads**: Every string enforces `maxLength` matching `firebase-blueprint.json`, every document ID satisfies `^[a-zA-Z0-9_\-]+$` (<= 128 chars), and `students.exams` is strictly bounded to `<= 100` items with element type guarding.
6. **Zero Blanket Reads / Query Enforcement**: No collection allows blanket `isSignedIn()` reads. Every `list` query explicitly enforces `resource.data.ownerId == request.auth.uid` without calling `get()`/`exists()`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read**: Read `/users/uid1/students/NO_435` with `auth == null` -> `PERMISSION_DENIED`.
2. **Cross-Tenant Read**: User `uid2` attempts `get` on `/users/uid1/exams/exam_1` -> `PERMISSION_DENIED`.
3. **Cross-Tenant List Scraping**: User `uid2` attempts `list` on `/users/uid1/students` -> `PERMISSION_DENIED`.
4. **Identity Spoofing on Create**: User `uid1` creates `/users/uid1/exams/exam_1` with `ownerId: "uid2"` -> `PERMISSION_DENIED`.
5. **Unverified Email Write**: User `uid1` with `email_verified: false` attempts to write `/users/uid1` -> `PERMISSION_DENIED`.
6. **Shadow / Ghost Field Injection**: User `uid1` creates `/users/uid1/students/NO_435` with extra field `isAdmin: true` -> `PERMISSION_DENIED`.
7. **ID Poisoning Attack**: User `uid1` writes `/users/uid1/exams/bad id with spaces!!!` -> `PERMISSION_DENIED`.
8. **Orphaned Subcollection Write**: User `uid1` creates `/users/uid1/exams/exam_1` before parent `/users/uid1` exists -> `PERMISSION_DENIED`.
9. **Immutable Field Mutation**: User `uid1` updates `/users/uid1/students/NO_435` changing `ownerId` or `createdAt` -> `PERMISSION_DENIED`.
10. **Forged Timestamp Attack**: User `uid1` writes `/users/uid1` with a client-provided `updatedAt` != `request.time` -> `PERMISSION_DENIED`.
11. **Value Poisoning / Oversized String**: User `uid1` updates `/users/uid1/exams/exam_1` setting `name` to a 500-char string (limit 200) -> `PERMISSION_DENIED`.
12. **Unbounded / Malformed Array Injection**: User `uid1` writes `/users/uid1/students/NO_435` with `exams: ["not-a-map"]` or `exams.length > 100` -> `PERMISSION_DENIED`.
