import { vi } from "vitest";

/**
 * Deep mock of the Prisma client used by the routes.
 * Import `prismaMock` in tests and configure return values per test.
 * The module `src/lib/prisma.ts` is replaced via vi.mock in each integration test file.
 */
function model() {
  return {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  };
}

export const prismaMock = {
  user: model(),
  passwordResetToken: model(),
  emailVerificationToken: model(),
  journalSettings: model(),
  manuscript: model(),
  manuscriptFile: model(),
  reviewAssignment: model(),
  review: model(),
  editorialDecision: model(),
  issue: model(),
  publication: model(),
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: typeof prismaMock) => unknown)(prismaMock);
    return Promise.all(arg as Promise<unknown>[]);
  }),
  $queryRaw: vi.fn(),
  $disconnect: vi.fn(),
};

export function resetPrismaMock(): void {
  for (const value of Object.values(prismaMock)) {
    if (typeof value === "object" && value !== null) {
      for (const fn of Object.values(value)) {
        if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
      }
    }
  }
}
