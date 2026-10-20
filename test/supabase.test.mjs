import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from '../server.mjs';

const user = { id: '00000000-0000-4000-8000-000000000001', name: 'Test user', email: 'user@example.invalid', role: 'ambassador' };
const employee = { id: '00000000-0000-4000-8000-000000000002', name: 'Test employee', email: 'staff@example.invalid', role: 'employee' };
const ticket = {
  id: '00000000-0000-4000-8000-000000000003', number: 1001, subject: 'Test ticket',
  ambassadorId: user.id, assigneeId: employee.id, messages: [],
};
const tokens = { access_token: 'test-access-token', refresh_token: 'test-refresh-token' };
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });

function provider() {
  const calls = [];
  let handler;
  const workspace = { user, users: [user, employee], products: [], tickets: [ticket] };
  const fetch = async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search;
    const call = { path, ...options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const custom = await handler?.(call);
    if (custom) return custom;
    if (path.startsWith('/auth/v1/token?')) return reply(tokens);
    if (path === '/auth/v1/user') return reply({ id: user.id, user_metadata: { role: 'employee' } });
    if (path.startsWith('/rest/v1/profiles?')) return reply([{ ...user, privateField: 'never expose' }]);
    if (path === '/auth/v1/logout?scope=local') return reply(null, 204);
    if (path === '/rest/v1/rpc/portal_workspace') return reply(workspace);
    if (path === '/rest/v1/rpc/portal_create_ticket' || path === '/rest/v1/rpc/portal_update_ticket') return reply({ ticket });
    if (path === '/rest/v1/rpc/portal_add_message') {
      return reply({ message: { id: '00000000-0000-4000-8000-000000000004', authorId: user.id, body: call.body.input.body, emailStatus: call.body.input.sendEmail ? 'failed' : 'not_requested' } });
    }
    if (path === '/rest/v1/rpc/portal_email_result') return reply(null, 204);
    throw new Error(`Unexpected provider request: ${path}`);
  };
  return { fetch, calls, setHandler: (value) => { handler = value; } };
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'olbrygging-supabase-'));
  const dataFile = resolve(directory, 'workspace.json');
  const mock = provider();
  const app = createApp({
    dataFile, supabaseUrl: 'https://project.supabase.co', supabaseKey: 'test-publishable-key',
    fetchSupabase: mock.fetch, ...options,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise((done) => app.close(done));
    rmSync(directory, { recursive: true, force: true });
  });
  async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { origin: options.secureCookies ? base.replace('http:', 'https:') : base, 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}), ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  }
  const login = () => call('/login', { method: 'POST', body: { email: user.email, password: ' Test password ' } });
  return { ...mock, call, login, dataFile };
}

const authCookie = `olbrygging_access=${tokens.access_token}; olbrygging_refresh=${tokens.refresh_token}`;

test('Supabase login uses trusted profiles, HttpOnly cookies and no local demo data', async (t) => {
  const { call, login, calls, dataFile } = await fixture(t, { secureCookies: true });
  assert.deepEqual((await call('/config')).body, { demoMode: false });
  assert.deepEqual((await call('/session')).body, { user: null });
  assert.equal((await call('/workspace')).status, 401);
  const result = await login();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { user });
  assert.equal(JSON.stringify(result.body).includes('token'), false);
  assert.equal(result.cookies.length, 2);
  for (const cookie of result.cookies) assert.match(cookie, /Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/);
  assert.equal(calls[0].body.password, ' Test password ');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers.apikey, 'test-publishable-key');
  assert.equal(calls[0].headers.Authorization, undefined);
  const session = await call('/session', { cookie: authCookie });
  assert.deepEqual(session.body, { user });
  const workspace = await call('/workspace', { cookie: authCookie });
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.emailConfigured, false);
  assert.equal(calls.at(-1).headers.Authorization, ['Bearer', tokens.access_token].join(' '));
  assert.equal(existsSync(dataFile), false);
});

test('Supabase sessions survive application restart without in-memory session state', async (t) => {
  const first = await fixture(t);
  await first.login();
  const restarted = await fixture(t);
  assert.deepEqual((await restarted.call('/session', { cookie: authCookie })).body, { user });
  assert.equal(restarted.calls.some((call) => call.path.startsWith('/auth/v1/token')), false);
});

test('expired access tokens refresh and rotate cookies; invalid refresh logs out', async (t) => {
  const { call, calls, setHandler } = await fixture(t);
  setHandler((request) => {
    if (request.path === '/auth/v1/user' && request.headers.Authorization.endsWith('expired')) return reply({ code: 'bad_jwt', msg: 'JWT expired' }, 403);
  });
  const result = await call('/session', { cookie: 'olbrygging_access=expired; olbrygging_refresh=valid-refresh' });
  assert.deepEqual(result.body, { user });
  assert.equal(result.cookies.length, 2);
  assert.deepEqual(calls.find((request) => request.path.includes('grant_type=refresh_token')).body, { refresh_token: 'valid-refresh' });
  setHandler((request) => request.path.includes('grant_type=refresh_token') ? reply({ error: 'refresh revoked' }, 400) : undefined);
  const invalid = await call('/session', { cookie: 'olbrygging_refresh=revoked-refresh' });
  assert.deepEqual(invalid.body, { user: null });
  assert.ok(invalid.cookies.every((cookie) => cookie.includes('Max-Age=0')));
});

test('profile authorization failures do not trigger token refresh', async (t) => {
  const { call, calls, setHandler } = await fixture(t);
  setHandler((request) => request.path.startsWith('/rest/v1/profiles?') ? reply({ code: '42501' }, 403) : undefined);
  assert.equal((await call('/session', { cookie: authCookie })).status, 403);
  assert.equal(calls.some((request) => request.path.includes('grant_type=refresh_token')), false);
});

test('Supabase logout revokes the session and clears both cookies', async (t) => {
  const { call, calls } = await fixture(t);
  const result = await call('/logout', { method: 'POST', cookie: authCookie });
  assert.equal(result.status, 200);
  assert.ok(result.cookies.every((cookie) => cookie.includes('Max-Age=0')));
  assert.equal(calls.at(-1).path, '/auth/v1/logout?scope=local');
  assert.deepEqual((await call('/logout', { method: 'POST' })).body, { user: null });
});

test('CRM mutations use transactional RPCs with user JWTs, never privileged keys', async (t) => {
  const { call, calls, setHandler } = await fixture(t, { supabaseServiceKey: 'test-service-key' });
  const input = { productId: 'malt', subject: 'A request', description: 'An idea', channel: 'Blogg' };
  assert.equal((await call('/tickets', { method: 'POST', cookie: authCookie, body: input })).status, 201);
  assert.deepEqual(calls.at(-1).body, { input });
  const patch = { status: 'in_progress' };
  assert.equal((await call(`/tickets/${ticket.id}`, { method: 'PATCH', cookie: authCookie, body: patch })).status, 200);
  assert.deepEqual(calls.at(-1).body, { ticket_id: ticket.id, input: patch });
  const message = await call(`/tickets/${ticket.id}/messages`, { method: 'POST', cookie: authCookie, body: { body: 'Hello' } });
  assert.equal(message.status, 201);
  assert.equal(message.body.message.emailStatus, 'not_requested');
  assert.equal(calls.at(-1).path, '/rest/v1/rpc/portal_add_message');
  assert.ok(calls.every((request) => request.headers.apikey === 'test-publishable-key'));
  setHandler((request) => request.path === '/rest/v1/rpc/portal_update_ticket' ? reply({ message: 'sensitive SQL detail' }, 403) : undefined);
  const denied = await call(`/tickets/${ticket.id}`, { method: 'PATCH', cookie: authCookie, body: patch });
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(denied.body).includes('sensitive'), false);
});

test('Supabase API retains same-origin, method, field and ticket ID validation', async (t) => {
  const { call, calls } = await fixture(t);
  assert.equal((await call('/login', { method: 'POST', body: {}, headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await call('/workspace', { method: 'POST' })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  assert.equal((await call('/tickets', { method: 'POST', cookie: authCookie, body: { role: 'employee' } })).status, 400);
  assert.equal((await call('/tickets/not-a-uuid', { method: 'PATCH', cookie: authCookie, body: { status: 'approved' } })).status, 404);
  assert.equal(calls.some((request) => request.path.includes('/rpc/')), false);
});

test('provider errors are sanitized and unavailable providers never trigger demo fallback', async (t) => {
  const { call, login, setHandler, dataFile } = await fixture(t);
  setHandler(() => reply({ message: 'secret backend detail' }, 400));
  const rejected = await login();
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error, 'Feil e-post eller passord.');
  setHandler(() => reply({ message: 'secret backend detail' }, 429));
  assert.equal((await login()).status, 429);
  setHandler(() => { throw new Error('secret backend detail'); });
  const unavailable = await call('/session', { cookie: authCookie });
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.stringify(unavailable.body).includes('secret'), false);
  assert.equal(existsSync(dataFile), false);
});

test('provider timeouts are bounded and logout clears cookies even during an outage', async (t) => {
  const { call } = await fixture(t, {
    supabaseTimeoutMs: 5,
    fetchSupabase: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  assert.equal((await call('/session', { cookie: authCookie })).status, 503);
  const logout = await call('/logout', { method: 'POST', cookie: authCookie });
  assert.equal(logout.status, 503);
  assert.equal(logout.cookies.length, 2);
  assert.ok(logout.cookies.every((cookie) => cookie.includes('Max-Age=0')));
});

test('outbound email is durable first and privileged access only records delivery status', async (t) => {
  let fixtureData;
  let delivered;
  fixtureData = await fixture(t, {
    emailApiKey: 'test-email-key', emailFrom: 'portal@example.invalid', supabaseServiceKey: 'test-service-key',
    fetchEmail: async (_url, request) => {
      assert.ok(fixtureData.calls.some((call) => call.path === '/rest/v1/rpc/portal_add_message'));
      delivered = JSON.parse(request.body);
      return new Response(null, { status: 202 });
    },
  });
  const result = await fixtureData.call(`/tickets/${ticket.id}/messages`, {
    method: 'POST', cookie: authCookie, body: { body: 'Test message', sendEmail: true },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.message.emailStatus, 'sent');
  assert.deepEqual(delivered.to, [employee.email]);
  assert.equal(fixtureData.calls.at(-1).path, '/rest/v1/rpc/portal_email_result');
  assert.equal(fixtureData.calls.at(-1).headers.apikey, 'test-service-key');
  assert.equal(fixtureData.calls.at(-1).body.delivery_status, 'sent');
  assert.equal(fixtureData.calls.filter((call) => call.headers.apikey === 'test-service-key').length, 1);
});

test('email provider failures preserve saved messages and failed delivery status', async (t) => {
  const { call, calls } = await fixture(t, {
    emailApiKey: 'test-email-key', emailFrom: 'portal@example.invalid', supabaseServiceKey: 'test-service-key',
    fetchEmail: async () => { throw new Error('email offline'); },
  });
  const result = await call(`/tickets/${ticket.id}/messages`, {
    method: 'POST', cookie: authCookie, body: { body: 'Keep this message', sendEmail: true },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.message.body, 'Keep this message');
  assert.equal(result.body.message.emailStatus, 'failed');
  assert.equal(calls.at(-1).body.delivery_status, 'failed');
});

test('Supabase configuration rejects partial settings, privileged public keys and unsafe URLs', () => {
  assert.throws(() => createApp({ supabaseUrl: 'https://project.supabase.co' }), /Set both/);
  for (const supabaseUrl of ['http://project.supabase.co', 'https://project.supabase.co?invalid=true', 'https://project.supabase.co/rest/v1']) {
    assert.throws(() => createApp({ supabaseUrl, supabaseKey: 'test-key' }), /HTTPS origin/);
  }
  assert.throws(() => createApp({ supabaseUrl: 'https://project.supabase.co', supabaseKey: 'sb_secret_test' }), /privileged/);
  const privilegedJwt = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  assert.throws(() => createApp({ supabaseUrl: 'https://project.supabase.co', supabaseKey: privilegedJwt }), /privileged/);
});

test('an empty publishable environment setting does not shadow the legacy anon key', () => {
  const previous = [process.env.SUPABASE_PUBLISHABLE_KEY, process.env.SUPABASE_ANON_KEY];
  try {
    process.env.SUPABASE_PUBLISHABLE_KEY = '';
    process.env.SUPABASE_ANON_KEY = 'test-legacy-anon-key';
    assert.doesNotThrow(() => createApp({ supabaseUrl: 'https://project.supabase.co' }));
  } finally {
    for (const [index, key] of ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY'].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
});
