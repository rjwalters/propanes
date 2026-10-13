import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

process.env.PROPANES_ALLOWED_IPS = '203.0.113.10';
process.env.PROPANES_TRUSTED_PROXIES = '127.0.0.1/32,::1/128,172.18.0.0/16';
const { enforceIpAllowlist } = await import('../src/access-control.ts');
const app = new Hono();
app.use('*', enforceIpAllowlist);
app.get('/api/test', (c) => c.json({ error: 'Unauthorized' }, 401));

async function status(peer: string, forwarded?: string) {
  const headers: Record<string, string> = {};
  if (forwarded !== undefined) headers['x-forwarded-for'] = forwarded;
  const res = await app.fetch(new Request('http://localhost/api/test', { headers }), {
    incoming: { socket: { remoteAddress: peer } },
  });
  return res.status;
}

test('direct local agents reach bearer authentication over IPv4 and IPv6', async () => {
  for (const peer of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
    assert.equal(await status(peer), 401);
  }
});

test('loopback reverse proxy does not exempt a denied forwarded client', async () => {
  assert.equal(await status('127.0.0.1', '198.51.100.20'), 403);
  assert.equal(await status('::1', '198.51.100.20, 127.0.0.1'), 403);
  assert.equal(await status('127.0.0.1', '127.0.0.1'), 403);
});

test('allowed public clients still reach bearer authentication', async () => {
  assert.equal(await status('203.0.113.10'), 401);
  assert.equal(await status('172.18.0.3', '203.0.113.10, 127.0.0.1'), 401);
});

test('remote callers cannot claim to be local using forwarded headers', async () => {
  assert.equal(await status('198.51.100.20', '127.0.0.1'), 403);
  assert.equal(await status('172.18.0.3', '127.0.0.1'), 403);
  assert.equal(await status('198.51.100.20'), 403);
});
