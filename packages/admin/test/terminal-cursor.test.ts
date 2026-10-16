import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleTerminalCursor } from '../src/lib/terminal-cursor.ts';

function fixture() {
  let onRender = () => {};
  let refreshes = 0;
  let disposed = false;
  const classes = new Set(['xterm-cursor', 'xterm-fg-2']);
  const cell = { classList: { remove: (name: string) => classes.delete(name) } };
  const active = { cursorX: 2, cursorY: 23, baseY: 0 };
  const term = {
    rows: 24,
    buffer: { active },
    onRender(callback: () => void) { onRender = callback; return { dispose() { disposed = true; } }; },
    refresh() { refreshes++; classes.add('xterm-cursor'); onRender(); },
  };
  const container = { querySelectorAll: () => classes.has('xterm-cursor') ? [cell] : [] };
  const cursor = settleTerminalCursor(term as any, container as any);
  const moveTo = (x: number, y: number) => { active.cursorX = x; active.cursorY = y; };
  const render = () => { classes.add('xterm-cursor'); onRender(); };
  const visible = () => classes.has('xterm-cursor');
  // Establish the prompt row as home: one write that drains and goes quiet.
  const settleAt = (t: any, x: number, y: number) => {
    cursor.output(); moveTo(x, y); render(); cursor.drained(); t.mock.timers.tick(100);
  };
  return { cursor, classes, moveTo, render, visible, settleAt, refreshes: () => refreshes, disposed: () => disposed };
}

test('hides decoration off the home row without removing ANSI cell styling', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.settleAt(t, 2, 23);
  const base = f.refreshes();
  f.cursor.output(); f.moveTo(0, 18); f.render();
  assert.deepEqual([...f.classes], ['xterm-fg-2']);
  t.mock.timers.tick(500);
  assert.equal(f.refreshes(), base, 'do not restore while xterm is still draining');
  f.cursor.drained(); t.mock.timers.tick(99);
  assert.equal(f.refreshes(), base);
  t.mock.timers.tick(1);
  assert.equal(f.refreshes(), base + 1, 'new resting row is adopted after quiet');
  assert.ok(f.visible());
  f.cursor.dispose();
});

test('animation that returns the cursor home never blinks it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.settleAt(t, 2, 23);
  for (let frame = 0; frame < 20; frame++) {
    f.cursor.output(); f.moveTo(0, 18); f.moveTo(2, 23); f.render();
    assert.ok(f.visible(), `frame ${frame} kept the cursor`);
    f.cursor.drained(); t.mock.timers.tick(60);
  }
  f.cursor.dispose();
});

test('typing on the home row keeps the cursor visible', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.settleAt(t, 2, 23);
  for (let x = 3; x < 10; x++) {
    f.cursor.output(); f.moveTo(x, 23); f.render();
    assert.ok(f.visible());
    f.cursor.drained(); t.mock.timers.tick(30);
  }
  f.cursor.dispose();
});

test('two writes ending at the same spot adopt it as home without waiting for quiet', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.settleAt(t, 2, 23);
  f.cursor.output(); f.moveTo(2, 10); f.render(); f.cursor.drained();
  assert.ok(!f.visible());
  t.mock.timers.tick(50);
  f.cursor.output(); f.moveTo(0, 5); f.moveTo(2, 10); f.render();
  assert.ok(!f.visible());
  f.cursor.drained();
  assert.ok(f.visible(), 'restored on the repeated resting position');
  f.cursor.output(); f.render();
  assert.ok(f.visible());
  f.cursor.dispose();
});

test('new output cancels restoration until the new write drains', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.settleAt(t, 2, 23);
  const base = f.refreshes();
  f.cursor.output(); f.moveTo(0, 18); f.cursor.drained(); t.mock.timers.tick(80);
  f.cursor.output(); f.moveTo(1, 17); t.mock.timers.tick(200);
  assert.equal(f.refreshes(), base);
  f.cursor.drained(); t.mock.timers.tick(100);
  assert.equal(f.refreshes(), base + 1);
  f.cursor.dispose();
});

test('dispose cancels pending restoration and unregisters the render listener', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.cursor.output(); f.cursor.drained(); f.cursor.dispose();
  t.mock.timers.tick(200);
  assert.equal(f.refreshes(), 0);
  assert.ok(f.disposed());
  f.cursor.output(); f.cursor.drained(); t.mock.timers.tick(200);
  assert.equal(f.refreshes(), 0);
});
