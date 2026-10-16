/**
 * Decide whether an auto-focus (e.g. the structured-view input bar focusing
 * itself when a session enters the 'waiting' state) should yield to whatever
 * the operator is already typing into.
 *
 * Typing into a PTY pane flips the session's input state active → waiting on
 * every keystroke (the keystroke marks it active, the TUI redraw marks it
 * waiting again). Without this guard the side-by-side structured view would
 * re-run its "focus on waiting" effect each time and yank the caret out of the
 * terminal mid-word.
 */

/** How long after a terminal keystroke other inputs should refrain from grabbing focus. */
export const TERMINAL_INPUT_FOCUS_GRACE_MS = 5000;

export interface FocusTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** True when `el` is the xterm.js hidden textarea or anything else inside a terminal. */
export function isTerminalElement(el: FocusTargetLike | null | undefined): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('.xterm');
}

/** True when `el` already accepts keyboard text (input, textarea, contenteditable). */
export function isTextEntryElement(el: FocusTargetLike | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

/**
 * Returns true when an auto-focus should NOT run: the operator is typing in a
 * terminal (focused or within the grace window) or already in another text field.
 */
export function shouldYieldAutoFocus(opts: {
  activeElement: FocusTargetLike | null | undefined;
  lastTerminalInputAt: number;
  now?: number;
  /** Elements the caller owns; focus already on one of these is not "stealing". */
  own?: (FocusTargetLike | null | undefined)[];
}): boolean {
  const { activeElement, lastTerminalInputAt, own = [] } = opts;
  const now = opts.now ?? Date.now();
  if (lastTerminalInputAt > 0 && now - lastTerminalInputAt < TERMINAL_INPUT_FOCUS_GRACE_MS) return true;
  if (!activeElement) return false;
  if (own.some((o) => o && o === activeElement)) return false;
  if (isTerminalElement(activeElement)) return true;
  if (isTextEntryElement(activeElement)) return true;
  return false;
}
