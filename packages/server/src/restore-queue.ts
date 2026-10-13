// restore-queue.ts — the restart/restore workflow.
//
// cleanupOrphanedSessions() (agent-sessions.ts) already detects sessions
// whose process tree died out from under their DB row — typically because
// propanes.service restarted (no KillMode=process before this was fixed; see
// PR #27) and SIGKILLed every detached tmux session underneath it — and marks
// them `status: 'failed', failureReason: 'orphaned_restart'`. This module is
// what an operator uses to actually recover from that: list what needs
// triage, resume it with instructions that account for the three real shapes
// a restart interruption takes (still mid-task, already finished but not yet
// marked complete, or not started), and tell a genuine recovery apart from a
// resumed session that immediately hit a usage/billing wall.
//
// Deliberately NOT handled here: a session whose tmux is still alive but
// whose PTY reattach is racing (session-recovery.ts) — that's a live,
// recoverable-by-reattach session, never orphaned, never in this queue.

import { eq, and, isNull, desc } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { snapshotLiveness, isSessionAliveNow } from './agent-sessions.js';
import { resumeAgentSession } from './dispatch.js';
import type { PermissionProfile, AgentRuntime } from '@propanes/shared';

export const DEFAULT_RESTORE_PROMPT = [
  'This conversation was interrupted by a propanes service restart, not by you finishing or giving up.',
  'Before doing anything else, check the current state of your task (git status/log, open PRs, deployed services, whatever applies) to find out what actually happened while you were down.',
  '- If the task is already fully complete, say so briefly and stop. Do not redo finished work.',
  '- If it is partially done, resume precisely from the interruption point, re-verifying any step that was in flight when you were killed.',
  '- If it was never started, proceed normally.',
].join('\n');

export interface RestoreQueueItem {
  id: string;
  claudeSessionId: string | null;
  title: string | null;
  cwd: string | null;
  permissionProfile: string;
  runtime: string;
  ownerUserId: string | null;
  orgId: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  completedAt: string | null;
  /** How many historical rows for this same conversation got collapsed into this one item. */
  collapsedRowCount: number;
}

type CandidateRow = typeof schema.agentSessions.$inferSelect;

/**
 * Self-heal a row the original cleanupOrphanedSessions pass mis-marked —
 * confirmed alive now, so it was a transient blip (service unreachable for a
 * moment, a launcher reconnecting right after the sweep), not a real kill.
 * Clearing failureReason and restoring 'running' is what lets it disappear
 * from the queue instead of showing up as a false positive forever.
 */
function unmarkFalseOrphan(sessionId: string): void {
  db.update(schema.agentSessions)
    .set({ status: 'running', completedAt: null, failureReason: null })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();
}

/**
 * List sessions that genuinely need restart-restore triage right now.
 *
 * Dedup: group every non-deleted row sharing a claudeSessionId (rows with no
 * claudeSessionId are their own group of one), and look only at the most
 * recent row per group (by lastActivityAt, falling back to createdAt). If
 * that most-recent row is not itself an undismissed orphaned-restart
 * candidate — because it was already resumed (the new child row is now the
 * most recent and isn't orphaned), completed some other way, or dismissed —
 * the whole conversation is done with this queue and is left out, with no
 * extra bookkeeping needed: a real restore naturally supersedes itself this
 * way the moment the new session row is inserted.
 *
 * Liveness recheck: every surviving candidate is re-verified against a FRESH
 * liveness snapshot (not the one from whenever cleanupOrphanedSessions last
 * ran) before being included. One that's actually alive now — including the
 * operator's own currently-running session, if it was mis-marked by the same
 * kind of transient blip that hit 1 of the 16 sessions in the 2026-10-12
 * incident — is excluded and self-healed rather than shown as a false
 * restore candidate.
 */
export async function listRestoreQueue(): Promise<RestoreQueueItem[]> {
  const candidates = db
    .select()
    .from(schema.agentSessions)
    .where(and(
      eq(schema.agentSessions.failureReason, 'orphaned_restart'),
      isNull(schema.agentSessions.restoreDismissedAt),
    ))
    .all();

  if (candidates.length === 0) return [];

  const ctx = await snapshotLiveness();
  const items: RestoreQueueItem[] = [];
  const seenGroups = new Set<string>();

  for (const candidate of candidates) {
    const groupKey = candidate.claudeSessionId || `__solo__:${candidate.id}`;
    if (seenGroups.has(groupKey)) continue;
    seenGroups.add(groupKey);

    let head: CandidateRow = candidate;
    let collapsedRowCount = 1;

    if (candidate.claudeSessionId) {
      const family = db
        .select()
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.claudeSessionId, candidate.claudeSessionId))
        .orderBy(desc(schema.agentSessions.lastActivityAt), desc(schema.agentSessions.createdAt))
        .all();
      if (family.length > 0) {
        head = family[0];
        collapsedRowCount = family.length;
      }
    }

    // The most recent row for this conversation has moved on (resumed,
    // completed some other way, or dismissed) — nothing to restore.
    if (head.failureReason !== 'orphaned_restart' || head.restoreDismissedAt) continue;

    const alive = isSessionAliveNow(head.id, head.launcherId, ctx);
    if (alive === true) {
      unmarkFalseOrphan(head.id);
      continue;
    }

    items.push({
      id: head.id,
      claudeSessionId: head.claudeSessionId,
      title: head.title,
      cwd: head.cwd,
      permissionProfile: head.permissionProfile,
      runtime: head.runtime,
      ownerUserId: head.ownerUserId,
      orgId: head.orgId,
      lastActivityAt: head.lastActivityAt,
      createdAt: head.createdAt,
      completedAt: head.completedAt,
      collapsedRowCount,
    });
  }

  items.sort((a, b) => (b.lastActivityAt || b.createdAt).localeCompare(a.lastActivityAt || a.createdAt));
  return items;
}

/** Mark a queue item "handled, don't restore" without resuming it. */
export function dismissRestoreQueueItem(sessionId: string): boolean {
  const row = db.select({ id: schema.agentSessions.id, failureReason: schema.agentSessions.failureReason })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();
  if (!row || row.failureReason !== 'orphaned_restart') return false;
  db.update(schema.agentSessions)
    .set({ restoreDismissedAt: new Date().toISOString() })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();
  return true;
}

/** Restore one queue item. Thin wrapper over resumeAgentSession with the recovery prompt defaulted in. */
export async function restoreQueueItem(
  sessionId: string,
  opts?: { prompt?: string | null; permissionProfile?: PermissionProfile | null; runtime?: AgentRuntime | null },
): Promise<{ sessionId: string }> {
  const prompt = opts?.prompt ?? DEFAULT_RESTORE_PROMPT;
  return resumeAgentSession(sessionId, undefined, opts?.permissionProfile ?? undefined, prompt, opts?.runtime ?? undefined);
}

export interface BulkRestoreProgress {
  total: number;
  attempted: number;
  succeeded: Array<{ parentId: string; sessionId: string }>;
  failed: Array<{ parentId: string; error: string }>;
  done: boolean;
}

const bulkRuns = new Map<string, BulkRestoreProgress>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Restore several queue items, spaced out rather than bursting them all at
 * once. Firing 16 resumes in the same instant is exactly what triggered the
 * `model_requires_usage_credits` 429s during the 2026-10-12 incident recovery
 * — this exists specifically so the automated path doesn't repeat that.
 * Runs in the background; poll the returned runId via getBulkRestoreProgress.
 */
export function startBulkRestore(
  ids: string[],
  opts?: { prompt?: string | null; intervalMs?: number },
): string {
  const runId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const intervalMs = Math.max(500, opts?.intervalMs ?? 4000);
  const progress: BulkRestoreProgress = { total: ids.length, attempted: 0, succeeded: [], failed: [], done: false };
  bulkRuns.set(runId, progress);

  (async () => {
    for (const id of ids) {
      try {
        const { sessionId } = await restoreQueueItem(id, { prompt: opts?.prompt });
        progress.succeeded.push({ parentId: id, sessionId });
      } catch (err) {
        progress.failed.push({ parentId: id, error: err instanceof Error ? err.message : String(err) });
      }
      progress.attempted += 1;
      if (progress.attempted < ids.length) await sleep(intervalMs);
    }
    progress.done = true;
    // Keep the finished record around briefly for a last poll, then drop it.
    setTimeout(() => bulkRuns.delete(runId), 5 * 60 * 1000);
  })();

  return runId;
}

export function getBulkRestoreProgress(runId: string): BulkRestoreProgress | null {
  return bulkRuns.get(runId) || null;
}

// --- Outcome classification -------------------------------------------------
//
// A resumed session that immediately hits a usage/billing rate limit can
// still exit with status 'completed' — the CLI process ends cleanly after
// printing the API error, it just didn't do anything. Reading only `status`
// nearly made that look like a genuine "already done" recovery during the
// 2026-10-12 incident; it took reading the full output tail to catch it. This
// classifier makes that check automatic.

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /model_requires_usage_credits/i,
  /"status"\s*:\s*429/,
  /\b429\b[^\n]{0,120}(usage|credit)/i,
  /reached your .{0,40} limit/i,
  /usage credits? at https:\/\/claude\.ai/i,
];

/** Strip common ANSI/OSC escape sequences before pattern-matching raw PTY output. */
function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, '');
}

export type SessionOutcome = 'running' | 'pending' | 'completed' | 'rate_limited' | 'failed' | 'killed' | 'unknown';

export function classifySessionOutcome(session: { status: string; outputLog: string | null } | null | undefined): SessionOutcome {
  if (!session) return 'unknown';
  if (session.status === 'running' || session.status === 'pending') return session.status as SessionOutcome;
  if (session.status === 'completed') {
    const text = session.outputLog ? stripAnsi(session.outputLog) : '';
    if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) return 'rate_limited';
    return 'completed';
  }
  if (session.status === 'failed' || session.status === 'killed') return session.status as SessionOutcome;
  return 'unknown';
}

export function getSessionOutcome(sessionId: string): SessionOutcome {
  const row = db
    .select({ status: schema.agentSessions.status, outputLog: schema.agentSessions.outputLog })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();
  return classifySessionOutcome(row);
}
