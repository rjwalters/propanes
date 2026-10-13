import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api.js';

// Restart/restore workflow: sessions cleanupOrphanedSessions marked 'failed'
// because propanes.service restarted out from under their process tree (see
// agent-sessions.ts / restore-queue.ts for the detection + dedup rules).
// Three shapes a restart interruption can leave a conversation in — still
// mid-task, already finished but never marked complete, or never started —
// which is why every restore carries an instruction to check state first
// instead of blindly continuing. A resumed session can also come back having
// immediately hit a usage/billing rate limit rather than genuinely finishing;
// `outcome` below is how that gets told apart from real completion.

type QueueItem = {
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
  collapsedRowCount: number;
};

type ResumeOutcome = 'running' | 'pending' | 'completed' | 'rate_limited' | 'failed' | 'killed' | 'unknown';

const OUTCOME_LABEL: Record<ResumeOutcome, string> = {
  running: 'running',
  pending: 'starting…',
  completed: 'completed',
  rate_limited: 'rate-limited (not done)',
  failed: 'failed',
  killed: 'killed',
  unknown: 'unknown',
};

// Per DESIGN_SPEC.md §1.2, "running and successful states use labels,
// neutral indicators and shape" — no green. Only the states that actually
// need a warning color (rate-limited, failed, killed) get one.
const OUTCOME_COLOR: Record<ResumeOutcome, string> = {
  running: '#93c5fd',
  pending: '#93c5fd',
  completed: 'var(--pw-text)',
  rate_limited: '#fcd34d',
  failed: '#fca5a5',
  killed: '#fca5a5',
  unknown: 'var(--pw-text-muted)',
};

function relTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const btnBase = {
  padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
} as const;

export function RestoreQueuePage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [promptDraftFor, setPromptDraftFor] = useState<string | null>(null);
  const [promptText, setPromptText] = useState('');
  // sessionId (the NEW resumed session) -> parent queue item id it came from, for outcome polling.
  const [resumed, setResumed] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<Record<string, ResumeOutcome>>({});
  const [bulkRunId, setBulkRunId] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ total: number; attempted: number; done: boolean } | null>(null);
  const [bulkPromptOpen, setBulkPromptOpen] = useState(false);
  const [bulkPromptText, setBulkPromptText] = useState('');

  async function refresh() {
    try {
      const res = await api.getRestoreQueue();
      setItems(res.items);
      setDefaultPrompt(res.defaultPrompt);
      if (!bulkPromptText) setBulkPromptText(res.defaultPrompt);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load restore queue');
    }
  }

  useEffect(() => {
    refresh();
    let alive = true;
    const id = setInterval(() => { if (alive && !document.hidden) refresh(); }, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Poll outcomes for every session we've resumed from this page, so a 429
  // that masquerades as a clean exit doesn't read as success in the UI.
  const resumedIds = Object.keys(resumed);
  const resumedKey = resumedIds.join(',');
  useEffect(() => {
    if (resumedIds.length === 0) return;
    let alive = true;
    async function poll() {
      try {
        const res = await api.getRestoreOutcomes(resumedIds);
        if (alive) setOutcomes((prev) => ({ ...prev, ...(res.outcomes as Record<string, ResumeOutcome>) }));
      } catch { /* non-fatal */ }
    }
    poll();
    const id = setInterval(() => { if (!document.hidden) poll(); }, 5_000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumedKey]);

  // Poll bulk-restore progress once a batch is running.
  const bulkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!bulkRunId) return;
    async function poll() {
      try {
        const p = await api.getBulkRestoreProgress(bulkRunId!);
        setBulkProgress({ total: p.total, attempted: p.attempted, done: p.done });
        for (const s of p.succeeded) {
          setResumed((prev) => (prev[s.sessionId] ? prev : { ...prev, [s.sessionId]: s.parentId }));
        }
        if (p.done) {
          if (bulkTimer.current) clearInterval(bulkTimer.current);
          refresh();
        }
      } catch { /* run may have expired; stop polling */
        if (bulkTimer.current) clearInterval(bulkTimer.current);
      }
    }
    poll();
    bulkTimer.current = setInterval(poll, 2_000);
    return () => { if (bulkTimer.current) clearInterval(bulkTimer.current); };
  }, [bulkRunId]);

  async function onRestore(item: QueueItem, prompt?: string) {
    setBusyId(item.id);
    setError(null);
    try {
      const { sessionId } = await api.restoreQueueItem(item.id, prompt ?? defaultPrompt);
      setResumed((prev) => ({ ...prev, [sessionId]: item.id }));
      setPromptDraftFor(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setBusyId(null);
    }
  }

  async function onDismiss(item: QueueItem) {
    setBusyId(item.id);
    setError(null);
    try {
      await api.dismissRestoreQueueItem(item.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dismiss failed');
    } finally {
      setBusyId(null);
    }
  }

  async function onRestoreAll() {
    setError(null);
    try {
      const { runId, total } = await api.restoreQueueAll(items.map((i) => i.id), bulkPromptText || defaultPrompt);
      setBulkProgress({ total, attempted: 0, done: false });
      setBulkRunId(runId);
      setBulkPromptOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk restore failed');
    }
  }

  return (
    <div style={{ padding: 16, width: '100%', overflow: 'auto' }}>
      <p style={{ color: 'var(--pw-text-secondary)', fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
        Sessions whose process tree died when propanes.service restarted — detached tmux and their agent process
        killed out from under a live conversation, not a normal task failure. Restoring sends the agent back in
        with instructions to check what actually happened first: some of these already finished before they were
        killed and just never got marked complete.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: 'var(--pw-text)' }}>
          {'↻'} Restore queue
          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--pw-text-muted)', fontWeight: 'normal' }}>
            {items.length} to triage
          </span>
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={refresh} style={{ ...btnBase, background: 'rgba(0,0,0,0.3)', color: 'var(--pw-text)', border: '1px solid var(--pw-border)' }}>
            Refresh
          </button>
          {items.length > 0 && (
            <button
              onClick={() => setBulkPromptOpen((v) => !v)}
              disabled={!!bulkRunId && !bulkProgress?.done}
              style={{
                ...btnBase,
                background: 'rgba(59,130,246,0.18)', color: '#93c5fd',
                border: '1px solid rgba(59,130,246,0.4)',
                opacity: bulkRunId && !bulkProgress?.done ? 0.6 : 1,
              }}
            >Restore all ({items.length})</button>
          )}
        </div>
      </div>

      {bulkPromptOpen && (
        <div style={{ padding: 12, marginBottom: 16, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--pw-text-muted)', marginBottom: 6 }}>
            Prompt sent to every restored session (paced a few seconds apart — not all at once, to avoid tripping a usage-rate limit the way bursting 16 at once did on 2026-10-12):
          </div>
          <textarea
            value={bulkPromptText}
            onInput={(e) => setBulkPromptText((e.currentTarget as HTMLTextAreaElement).value)}
            rows={5}
            style={{ width: '100%', fontSize: 12, fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', color: 'var(--pw-text)', border: '1px solid var(--pw-border)', borderRadius: 4, padding: 8, boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={onRestoreAll} style={{ ...btnBase, background: 'rgba(29,155,240,0.18)', color: '#93c5fd', border: '1px solid rgba(29,155,240,0.4)' }}>
              Start restoring all {items.length}
            </button>
            <button onClick={() => setBulkPromptOpen(false)} style={{ ...btnBase, background: 'transparent', color: 'var(--pw-text-muted)', border: '1px solid var(--pw-border)' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {bulkProgress && (
        <div style={{ padding: 10, marginBottom: 16, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--pw-border)', borderRadius: 6, fontSize: 12, color: 'var(--pw-text)' }}>
          Bulk restore: {bulkProgress.attempted} / {bulkProgress.total} dispatched{bulkProgress.done ? ' — done' : '…'}
        </div>
      )}

      {error && (
        <div style={{ padding: 8, marginBottom: 12, background: 'rgba(239,68,68,0.15)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, fontSize: 12 }}>
          {error}
        </div>
      )}

      {resumedIds.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--pw-text-muted)', marginBottom: 6 }}>Resumed this session</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {resumedIds.map((sid) => {
              const outcome = (outcomes[sid] || 'pending') as ResumeOutcome;
              return (
                <div key={sid} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--pw-border)', borderRadius: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: OUTCOME_COLOR[outcome], flexShrink: 0 }} />
                  <code style={{ color: 'var(--pw-text-muted)' }}>{sid.slice(0, 12)}…</code>
                  <span style={{ color: OUTCOME_COLOR[outcome], fontWeight: 600 }}>{OUTCOME_LABEL[outcome]}</span>
                  {outcome === 'rate_limited' && (
                    <span style={{ color: 'var(--pw-text-muted)' }}>— hit a usage/billing limit immediately, did not actually continue the task</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--pw-text-muted)', textAlign: 'center', fontSize: 13 }}>
          Nothing to restore.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((item) => (
            <div key={item.id} style={{ padding: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--pw-border)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: 'var(--pw-text)' }}>{item.title || '(untitled session)'}</span>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(0,0,0,0.3)', color: 'var(--pw-text-muted)', fontFamily: 'monospace' }}>
                  {item.permissionProfile}
                </span>
                {item.collapsedRowCount > 1 && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'rgba(0,0,0,0.3)', color: 'var(--pw-text-muted)' }}>
                    {item.collapsedRowCount} historical rows
                  </span>
                )}
                <span style={{ marginLeft: 'auto', color: 'var(--pw-text-muted)', fontSize: 11 }}>
                  {relTime(item.lastActivityAt || item.createdAt)}
                </span>
              </div>

              {item.cwd && (
                <div style={{ fontSize: 11, color: 'var(--pw-text-muted)', fontFamily: 'monospace' }}>{item.cwd}</div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() => onRestore(item)}
                  disabled={busyId === item.id}
                  style={{ ...btnBase, background: 'rgba(29,155,240,0.18)', color: '#93c5fd', border: '1px solid rgba(29,155,240,0.4)', opacity: busyId === item.id ? 0.6 : 1 }}
                >Restore</button>
                <button
                  onClick={() => { setPromptDraftFor(item.id); setPromptText(defaultPrompt); }}
                  disabled={busyId === item.id}
                  style={{ ...btnBase, background: 'rgba(0,0,0,0.3)', color: 'var(--pw-text)', border: '1px solid var(--pw-border)' }}
                >Restore with custom prompt</button>
                <button
                  onClick={() => onDismiss(item)}
                  disabled={busyId === item.id}
                  style={{ ...btnBase, background: 'transparent', color: 'var(--pw-text-muted)', border: '1px solid var(--pw-border)' }}
                >Dismiss</button>
              </div>

              {promptDraftFor === item.id && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    value={promptText}
                    onInput={(e) => setPromptText((e.currentTarget as HTMLTextAreaElement).value)}
                    rows={5}
                    autoFocus
                    style={{ width: '100%', fontSize: 12, fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', color: 'var(--pw-text)', border: '1px solid var(--pw-border)', borderRadius: 4, padding: 8, boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => onRestore(item, promptText)} style={{ ...btnBase, background: 'rgba(29,155,240,0.18)', color: '#93c5fd', border: '1px solid rgba(29,155,240,0.4)' }}>
                      Send
                    </button>
                    <button onClick={() => setPromptDraftFor(null)} style={{ ...btnBase, background: 'transparent', color: 'var(--pw-text-muted)', border: '1px solid var(--pw-border)' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
