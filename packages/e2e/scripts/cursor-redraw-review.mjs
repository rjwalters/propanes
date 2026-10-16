// No input or resize messages are sent to a live PTY. Optional live comparison:
// REVIEW_PTY_SESSION=<id> node scripts/cursor-redraw-review.mjs
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../admin/', import.meta.url));
const bundle = await build({ entryPoints: [root + 'src/lib/terminal-cursor.ts'], bundle: true, write: false, format: 'iife', globalName: 'CursorSettler' });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.setContent('<div id="fixed"></div><div id="baseline"></div>');
  await page.addStyleTag({ path: root + 'node_modules/@xterm/xterm/css/xterm.css' });
  await page.addScriptTag({ path: root + 'node_modules/@xterm/xterm/lib/xterm.js' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const el = document.querySelector('#fixed');
    const term = new Terminal({ cols: 80, rows: 24, cursorBlink: false });
    term.open(el); term.focus();
    const settler = CursorSettler.settleTerminalCursor(term, el);
    const write = data => new Promise(resolve => {
      settler.output(); term.write(data, () => { settler.drained(); resolve(); });
    });
    await write('\x1b[2J\x1b[20;1HWorking\x1b[24;1H> Ask Codex\x1b[24;3H');
    await sleep(180);
    const initialCursor = el.querySelectorAll('.xterm-cursor').length;
    let movingFrames = 0, decoratedMovingFrames = 0;
    const listener = term.onRender(() => {
      movingFrames++;
      // The prompt row (home) stays painted; only off-home redraw stops count.
      if (term.buffer.active.cursorY !== 23 && el.querySelector('.xterm-cursor')) decoratedMovingFrames++;
    });
    for (let i = 0; i < 20; i++) {
      await write(`\x1b[18;${i + 1}H.\x1b[?25h`);
      await sleep(20);
    }
    await write('\x1b[24;3H');
    await sleep(40);
    listener.dispose();
    await sleep(150);
    const restored = el.querySelectorAll('.xterm-cursor').length;
    const finalPosition = [term.buffer.active.cursorX, term.buffer.active.cursorY];
    await write('\x1b[?25l'); await sleep(180);
    const applicationHidden = el.querySelectorAll('.xterm-cursor').length;
    // Split escape sequences must not be interrupted with synthetic hide/show bytes.
    await write('\x1b[1'); await write('2;4H\x1b[?25h'); await sleep(180);
    const splitPosition = [term.buffer.active.cursorX, term.buffer.active.cursorY];
    window.testTerminal = term; window.testSettler = settler;
    return { initialCursor, movingFrames, decoratedMovingFrames, restored, finalPosition, applicationHidden, splitPosition };
  });
  expect(result.initialCursor).toBe(1);
  expect(result.movingFrames).toBeGreaterThan(10);
  expect(result.decoratedMovingFrames).toBe(0);
  expect(result.restored).toBe(1);
  expect(result.finalPosition).toEqual([2, 23]);
  expect(result.applicationHidden).toBe(0);
  expect(result.splitPosition).toEqual([3, 11]);
  await page.screenshot({ path: '/tmp/propanes-cursor-redraw.png' });
  console.log('PASS: burst cursor suppression, settled restoration, native hidden cursor and fragmented escape sequences', result);
  if (process.env.REVIEW_PTY_SESSION) {
    console.log('Live comparison:', await page.evaluate(async sessionId => {
      window.testSettler.dispose(); window.testTerminal.dispose();
      document.body.style.display = 'flex';
      const terms = ['baseline', 'fixed'].map(id => {
        const el = document.getElementById(id);
        el.style.width = '50%';
        const term = new Terminal({ cols: 117, rows: 44, fontSize: 9, cursorBlink: false });
        term.open(el); term.focus();
        return { term, el, settler: id === 'fixed' ? CursorSettler.settleTerminalCursor(term, el) : null, positions: new Set(), writes: 0 };
      });
      let ready = false, packets = 0;
      for (const t of terms) t.term.onRender(() => {
        if (ready && t.el.querySelector('.xterm-cursor')) t.positions.add(`${t.term.buffer.active.cursorX},${t.term.buffer.active.cursorY}`);
      });
      const ws = new WebSocket(`ws://localhost:3002/ws/agent-session?sessionId=${encodeURIComponent(sessionId)}`);
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        const data = m.type === 'history' ? m.data : m.content?.kind === 'output' ? m.content.data : '';
        if (!data) return;
        packets++;
        for (const t of terms) {
          if (m.type === 'history') t.term.resize(m.cols, m.rows);
          t.settler?.output(); t.writes++;
          t.term.write(data, () => {
            t.term.scrollToBottom();
            t.writes--; if (!t.writes) t.settler?.drained();
          });
        }
      };
      await new Promise(r => setTimeout(r, 800)); ready = true;
      await new Promise(r => setTimeout(r, 3500)); ws.close();
      await new Promise(r => setTimeout(r, 250));
      const contents = terms.map(t => Array.from({ length: t.term.buffer.active.length }, (_, i) => t.term.buffer.active.getLine(i)?.translateToString()).join('\n'));
      const result = { packets, baselineVisiblePositions: terms[0].positions.size, fixedVisiblePositions: terms[1].positions.size, identicalText: contents[0] === contents[1] };
      for (const t of terms) { t.settler?.dispose(); t.term.dispose(); }
      return result;
    }, process.env.REVIEW_PTY_SESSION));
  }
} finally { await browser.close(); }
