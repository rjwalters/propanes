import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldYieldAutoFocus, TERMINAL_INPUT_FOCUS_GRACE_MS } from '../src/lib/focus-guard.js';

const NOW = 1_000_000;
const xtermTextarea = { tagName: 'TEXTAREA', closest: (sel: string) => (sel === '.xterm' ? {} : null) };
const plainInput = { tagName: 'INPUT', closest: () => null };
const body = { tagName: 'BODY', closest: () => null };

test('yields while the operator is typing in a terminal', () => {
  assert.equal(shouldYieldAutoFocus({ activeElement: body, lastTerminalInputAt: NOW - 200, now: NOW }), true);
  assert.equal(shouldYieldAutoFocus({ activeElement: body, lastTerminalInputAt: NOW - TERMINAL_INPUT_FOCUS_GRACE_MS - 1, now: NOW }), false);
  assert.equal(shouldYieldAutoFocus({ activeElement: body, lastTerminalInputAt: 0, now: NOW }), false);
});

test('yields when an xterm helper textarea has focus', () => {
  assert.equal(shouldYieldAutoFocus({ activeElement: xtermTextarea, lastTerminalInputAt: 0, now: NOW }), true);
});

test('yields when another text field has focus, but not its own', () => {
  assert.equal(shouldYieldAutoFocus({ activeElement: plainInput, lastTerminalInputAt: 0, now: NOW }), true);
  assert.equal(shouldYieldAutoFocus({ activeElement: plainInput, lastTerminalInputAt: 0, now: NOW, own: [plainInput] }), false);
  assert.equal(shouldYieldAutoFocus({ activeElement: { tagName: 'DIV', isContentEditable: true, closest: () => null }, lastTerminalInputAt: 0, now: NOW }), true);
});

test('does not yield when nothing editable is focused', () => {
  assert.equal(shouldYieldAutoFocus({ activeElement: body, lastTerminalInputAt: 0, now: NOW }), false);
  assert.equal(shouldYieldAutoFocus({ activeElement: null, lastTerminalInputAt: 0, now: NOW }), false);
});
