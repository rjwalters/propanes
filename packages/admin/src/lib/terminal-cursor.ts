import type { Terminal } from '@xterm/xterm';

/** xterm's DOM renderer can paint a visible cursor at intermediate TUI redraw
 * positions (spinner/status rows), even with synchronized output enabled by
 * tmux. While output is in flight, hide the cursor decoration only when the
 * cursor is off its settled row, preserving the cell's text/ANSI styling and
 * the application's own cursor visibility state.
 *
 * Hiding on every output burst instead makes the cursor blink at the TUI's
 * animation rate (a spinner redraws several times a second), so the cursor
 * stays painted whenever it sits on its home row. The home row is adopted
 * after a quiet period, or as soon as two consecutive writes leave the cursor
 * at the same spot (an animation returning the cursor to the prompt).
 * Targets the DOM renderer used by AgentTerminal, not the canvas/WebGL addons. */
export function settleTerminalCursor(
  term: Pick<Terminal, 'onRender' | 'refresh' | 'rows' | 'buffer'>,
  container: Pick<HTMLElement, 'querySelectorAll'>,
  quietMs = 100,
) {
  let busy = false;
  let disposed = false;
  let homeRow: number | null = null;
  let lastDrained: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const position = () => {
    const buf = term.buffer.active;
    return { x: buf.cursorX, y: buf.baseY + buf.cursorY };
  };
  const hide = () => {
    if (!busy || position().y === homeRow) return;
    for (const cursor of container.querySelectorAll('.xterm-cursor')) {
      cursor.classList.remove('xterm-cursor');
    }
  };
  const settle = (row: number) => {
    const moved = row !== homeRow;
    homeRow = row;
    // Let xterm restore its own cursor (or keep it hidden via DECTCEM).
    // Never inject escape sequences into a potentially partial write.
    if (moved) term.refresh(0, term.rows - 1);
  };
  // onRender runs synchronously after xterm updates its DOM, before paint.
  const render = term.onRender(hide);
  return {
    output() {
      if (disposed) return;
      clearTimeout(timer);
      busy = true;
      hide();
    },
    drained() {
      if (disposed) return;
      clearTimeout(timer);
      const pos = position();
      const key = `${pos.x},${pos.y}`;
      if (key === lastDrained) settle(pos.y);
      lastDrained = key;
      timer = setTimeout(() => {
        if (disposed) return;
        busy = false;
        settle(position().y);
      }, quietMs);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      render.dispose();
    },
  };
}
