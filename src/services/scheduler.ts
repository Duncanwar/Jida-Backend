import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { notifyReviewerDeadlineApproaching } from "./notifications.js";

/**
 * Background jobs required by the SRS:
 *  - FR-R6: notify reviewers of approaching review deadlines via email.
 *  - DB-03 / RM-01: perform automated daily backups (weekly minimum required).
 */

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly tick
const REMINDER_WINDOW_MS = 48 * 60 * 60 * 1000; // remind within 48h of deadline
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily (RM-01; exceeds DB-03's weekly minimum)

type SchedulerState = {
  remindedAssignmentIds: string[];
  lastBackupAt: string | null;
};

function stateFile(): string {
  return path.join(env.BACKUP_DIR, "scheduler-state.json");
}

function loadState(): SchedulerState {
  try {
    const raw = fs.readFileSync(stateFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SchedulerState>;
    return {
      remindedAssignmentIds: parsed.remindedAssignmentIds ?? [],
      lastBackupAt: parsed.lastBackupAt ?? null,
    };
  } catch {
    return { remindedAssignmentIds: [], lastBackupAt: null };
  }
}

function saveState(state: SchedulerState): void {
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

/** FR-R6 — email reviewers whose deadline is within 48h and review not yet submitted. */
export async function sendDeadlineReminders(): Promise<void> {
  const state = loadState();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);

  const assignments = await prisma.reviewAssignment.findMany({
    where: {
      deadline: { gte: now, lte: windowEnd },
      review: null,
    },
    include: {
      reviewer: { select: { email: true } },
      manuscript: { select: { title: true } },
    },
  });

  const reminded = new Set(state.remindedAssignmentIds);
  let changed = false;

  for (const a of assignments) {
    if (reminded.has(a.id)) continue;
    await notifyReviewerDeadlineApproaching(a.reviewer.email, a.manuscript.title, a.deadline);
    reminded.add(a.id);
    changed = true;
  }

  if (changed) {
    saveState({ ...state, remindedAssignmentIds: [...reminded] });
  }
}

/** DB-03 / RM-01 — daily JSON export of all relational data to BACKUP_DIR. */
export async function runBackup(): Promise<string> {
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true });

  const [users, manuscripts, files, assignments, reviews, decisions, issues, publications, settings] =
    await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          email: true,
          role: true,
          firstName: true,
          lastName: true,
          affiliation: true,
          createdAt: true,
        },
      }),
      prisma.manuscript.findMany(),
      prisma.manuscriptFile.findMany(),
      prisma.reviewAssignment.findMany(),
      prisma.review.findMany(),
      prisma.editorialDecision.findMany(),
      prisma.issue.findMany(),
      prisma.publication.findMany(),
      prisma.journalSettings.findMany(),
    ]);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(env.BACKUP_DIR, `jida-backup-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      { createdAt: new Date().toISOString(), users, manuscripts, files, assignments, reviews, decisions, issues, publications, settings },
      null,
      2,
    ),
  );

  const state = loadState();
  saveState({ ...state, lastBackupAt: new Date().toISOString() });
  console.info(`[scheduler] backup written: ${file}`);
  return file;
}

async function tick(): Promise<void> {
  try {
    await sendDeadlineReminders();
  } catch (err) {
    console.error("[scheduler] deadline reminder job failed", err);
  }

  try {
    const state = loadState();
    const last = state.lastBackupAt ? new Date(state.lastBackupAt).getTime() : 0;
    if (Date.now() - last >= BACKUP_INTERVAL_MS) {
      await runBackup();
    }
  } catch (err) {
    console.error("[scheduler] backup job failed", err);
  }
}

export function startScheduler(): void {
  void tick();
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref();
  console.info("[scheduler] started (deadline reminders hourly, backups daily)");
}
