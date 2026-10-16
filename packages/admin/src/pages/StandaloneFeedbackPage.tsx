import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { FeedbackDetailPage } from './FeedbackDetailPage.js';
import { StandaloneSessionView } from './StandaloneSessionPage.js';
import { SshSetupDialog } from '../components/modals/SshSetupDialog.js';
import { startSessionPolling } from '../lib/sessions.js';
import { api } from '../lib/api.js';
import { applyTheme } from '../lib/settings.js';
import { selectedAppId } from '../lib/state.js';

export function StandaloneFeedbackPage({ feedbackId }: { feedbackId: string }) {
  const appId = useSignal<string | null>(selectedAppId.value);
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);
  const attachedSessionId = useSignal<string | null>(null);
  const splitPct = useSignal(50);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => { applyTheme(); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fb = await api.getFeedbackById(feedbackId);
        if (cancelled) return;
        if (fb?.appId) {
          appId.value = fb.appId;
          selectedAppId.value = fb.appId;
        }
      } catch (err: any) {
        if (!cancelled) error.value = err?.message || 'Failed to load feedback';
      } finally {
        if (!cancelled) loading.value = false;
      }
    })();
    return () => { cancelled = true; };
  }, [feedbackId]);

  useEffect(() => {
    document.title = `Feedback ${feedbackId.slice(-6)}`;
  }, [feedbackId]);

  const attached = attachedSessionId.value;
  useEffect(() => {
    if (!attached) return;
    return startSessionPolling();
  }, [!!attached]);

  const startDividerDrag = (e: PointerEvent) => {
    const container = splitRef.current;
    if (!container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      splitPct.value = Math.min(80, Math.max(20, pct));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('standalone-fb-split-dragging');
    };
    document.body.classList.add('standalone-fb-split-dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (loading.value) {
    return (
      <div class="standalone-session-root" style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--pw-text-muted)' }}>Loading feedback…</div>
      </div>
    );
  }

  if (error.value) {
    return (
      <div class="standalone-session-root" style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--pw-error, #c33)' }}>{error.value}</div>
      </div>
    );
  }

  const detail = (
    <FeedbackDetailPage
      id={feedbackId}
      appId={appId.value}
      embedded
      onOpenSession={(sid) => { attachedSessionId.value = sid; }}
    />
  );

  if (!attached) {
    return (
      <div class="standalone-session-root" style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        {detail}
      </div>
    );
  }

  return (
    <div class="standalone-session-root standalone-fb-split" ref={splitRef} style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)' }}>
      <div class="standalone-fb-split-detail" style={{ flexBasis: `${splitPct.value}%` }}>
        {detail}
      </div>
      <div
        class="standalone-fb-split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        onPointerDown={startDividerDrag}
      />
      <div class="standalone-fb-split-session">
        <StandaloneSessionView
          key={attached}
          sessionId={attached}
          showFeedbackLink={false}
          onClose={() => { attachedSessionId.value = null; }}
        />
      </div>
      <SshSetupDialog />
    </div>
  );
}
