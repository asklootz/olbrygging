import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../server.mjs';

const user = { id: 'ambassador00001', name: 'Test user', email: 'user@example.invalid', role: 'ambassador' };
const employee = { id: 'employee0000001', name: 'Test employee', email: 'staff@example.invalid', role: 'employee' };
const ticket = { id: 'ticket000000001', number: 1001, subject: 'Test ticket', ambassadorId: user.id, assigneeId: employee.id, messages: [] };
const messageId = 'message00000001';
const jwt = (exp = Math.floor(Date.now() / 1000) + 86400, signature = 'signature') =>
  ['header', Buffer.from(JSON.stringify({ exp })).toString('base64url'), signature].join('.');
const token = jwt();
const refreshedToken = jwt(undefined, 'refreshed');
const adminToken = jwt(undefined, 'admin');
const authCookie = `olbrygging_pb_auth=${token}`;
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });
const userAuth = '/api/collections/users/auth-with-password';
const refreshAuth = '/api/collections/users/auth-refresh';
const adminAuth = '/api/collections/_superusers/auth-with-password';
const workspacePath = '/api/portal/workspace';
const ticketsPath = '/api/portal/tickets';
const messagePath = `${ticketsPath}/${ticket.id}/messages`;
const resultPath = `/api/portal/messages/${messageId}/email-result`;
const applicationBody = {
  name: ' Applicant ', email: 'APPLICANT@example.invalid', phone: '+47 12345678',
  addressLine1: 'Testveien 1', addressLine2: '', postalCode: '0123', city: 'Oslo', region: '', country: 'Norge',
  socialLinks: { instagram: 'https://www.instagram.com/test', facebook: '', tiktok: '', twitter: '', bluesky: '', youtube: 'https://www.youtube.com/@test' }, termsAccepted: true,
};

function provider() {
  const calls = [];
  let handler;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const call = { path, ...options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const custom = await handler?.(call);
    if (custom) return custom;
    if (path === userAuth) return reply({ token, record: { ...user, password: 'private', privateField: 'never expose' } });
    if (path === refreshAuth) return reply({ token: refreshedToken, record: { ...user, privateField: 'never expose' } });
    if (path === adminAuth) return reply({ token: adminToken, record: { id: 'superuser000001' } });
    if (path === workspacePath) return reply({ user, users: [user, employee], products: [], tickets: [ticket] });
    if (path === ticketsPath || path === `${ticketsPath}/${ticket.id}`) return reply({ ticket });
    if (path === messagePath) {
      return reply({ message: { id: messageId, authorId: user.id, body: call.body.body, emailStatus: call.body.sendEmail ? 'failed' : 'not_requested' } }, 201);
    }
    if (path === resultPath) return reply({});
    throw new Error(`Unexpected provider request: ${path}`);
  };
  return { fetch, calls, setHandler: (value) => { handler = value; } };
}

async function fixture(t, options = {}) {
  const root = resolve('.test-data');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'pocketbase-'));
  const dataFile = resolve(directory, 'workspace.json');
  const mock = provider();
  const app = createApp({ dataFile, pocketbaseUrl: 'https://pb.example.invalid', fetchPocketbase: mock.fetch, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise((done) => app.close(done));
    rmSync(directory, { recursive: true, force: true });
  });
  async function call(path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { origin: options.secureCookies ? base.replace('http:', 'https:') : base, 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}), ...headers,
      },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  }
  const login = () => call('/login', { method: 'POST', body: { email: user.email.toUpperCase(), password: ' Test password ' } });
  return { ...mock, call, login, dataFile };
}

test('PocketBase is the default even when no backend URL is configured', async (t) => {
  const previous = process.env.POCKETBASE_URL;
  delete process.env.POCKETBASE_URL;
  try {
    const { call, login, calls, dataFile } = await fixture(t, { pocketbaseUrl: undefined });
    assert.deepEqual((await call('/config')).body, { demoMode: false });
    assert.equal((await login()).status, 200);
    assert.equal(calls[0].path, userAuth);
    assert.equal(existsSync(dataFile), false);
  } finally {
    if (previous === undefined) delete process.env.POCKETBASE_URL;
    else process.env.POCKETBASE_URL = previous;
  }
});

test('staff task creation fetches URL metadata server-side and never requires a catalogue, ambassador or platform', async (t) => {
  const { call, calls, setHandler } = await fixture(t, {
    fetchProductPage: async () => new Response(`<html><head><meta property="og:image" content="/product.jpg"><script type="application/ld+json">{"@type":"Product","name":"URL product","description":"Freshly fetched description","offers":{"price":"399.50","priceCurrency":"NOK"}}</script></head></html>`, { headers: { 'content-type': 'text/html' } }),
  });
  const body = { productUrl: 'https://www.olbrygging.no/produkt/new', subject: 'An idea', description: 'Staff input', acceptBy: '2028-01-01', dueDate: '2028-01-15' };
  assert.equal((await call('/tasks', { method: 'POST', cookie: authCookie, body })).status, 403);
  setHandler(({ path }) => path === refreshAuth ? reply({ token: refreshedToken, record: employee })
    : path === '/api/portal/tasks' ? reply({ ticket: { ...ticket, ...body, status: 'available' } }, 201) : undefined);
  const created = await call('/tasks', { method: 'POST', cookie: authCookie, body });
  assert.equal(created.status, 201);
  const request = calls.at(-1);
  assert.equal(request.path, '/api/portal/tasks');
  assert.equal(request.headers.Authorization, refreshedToken);
  assert.deepEqual(request.body.productSnapshot, {
    url: body.productUrl, name: 'URL product', description: 'Freshly fetched description', price: 399.5,
    currency: 'NOK', image: 'https://www.olbrygging.no/product.jpg',
  });
  for (const key of ['productId', 'ambassadorId', 'channel']) assert.equal(request.body[key], undefined);
  for (const changes of [{ ambassadorId: user.id }, { channel: 'Instagram' }, { productSnapshot: {} }]) {
    assert.equal((await call('/tasks', { method: 'POST', cookie: authCookie, body: { ...body, ...changes } })).status, 400);
  }
});

test('accept-task routes use current user authorization and reject forged input and wrong methods', async (t) => {
  const { call, calls, setHandler } = await fixture(t);
  const path = `/api/portal/tickets/${ticket.id}/accept`;
  setHandler(({ path: route }) => route === path ? reply({ ticket: { ...ticket, status: 'approved' } }) : undefined);
  const result = await call(`/tickets/${ticket.id}/accept`, { method: 'POST', cookie: authCookie, body: {} });
  assert.equal(result.status, 200);
  assert.equal(calls.at(-1).path, path);
  assert.equal(calls.at(-1).headers.Authorization, refreshedToken);
  assert.equal((await call(`/tickets/${ticket.id}/accept`, { method: 'GET', cookie: authCookie })).status, 405);
  assert.equal((await call(`/tickets/${ticket.id}/accept`, { method: 'POST', cookie: authCookie, body: { ambassadorId: employee.id } })).status, 400);
});

test('public applications submit only to the scoped hook without auth, cookies or privileged credentials', async (t) => {
  const { call, calls, setHandler } = await fixture(t, {
    pocketbaseAdminEmail: 'admin@example.invalid', pocketbaseAdminPassword: 'test-password',
  });
  setHandler(({ path }) => path === '/api/portal/ambassador-applications' ? reply({ submitted: true }, 201) : undefined);
  const result = await call('/ambassador-applications', { method: 'POST', body: applicationBody, cookie: authCookie });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { submitted: true });
  assert.deepEqual(result.cookies, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/portal/ambassador-applications');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].body.name, 'Applicant');
  assert.equal(calls[0].body.email, 'applicant@example.invalid');
  assert.deepEqual(calls[0].body.socialLinks, applicationBody.socialLinks);
});

test('application endpoint enforces methods, same origin and validation before reaching PocketBase', async (t) => {
  const { call, calls } = await fixture(t);
  assert.equal((await call('/ambassador-applications')).status, 405);
  assert.equal((await call('/ambassador-applications', { method: 'PATCH', body: applicationBody })).status, 405);
  assert.equal((await call('/ambassador-applications', { method: 'POST', body: applicationBody, headers: { origin: 'https://other.invalid' } })).status, 403);
  for (const changes of [{ termsAccepted: false }, { socialLinks: {} }, { status: 'approved' }, { userId: user.id }, { postalCode: '' }]) {
    assert.equal((await call('/ambassador-applications', { method: 'POST', body: { ...applicationBody, ...changes } })).status, 400);
  }
  assert.equal((await call('/ambassador-applications', { method: 'POST', raw: '{' })).status, 400);
  assert.equal((await call('/ambassador-applications', { method: 'POST', raw: 'x'.repeat(25000) })).status, 413);
  assert.equal(calls.length, 0);
});

test('application attempts are rate limited even when emails rotate, and failures never return success', async (t) => {
  const { call, calls, setHandler } = await fixture(t);
  setHandler(() => reply({ message: 'private backend details' }, 503));
  for (let i = 0; i < 10; i++) {
    const result = await call('/ambassador-applications', { method: 'POST', body: { ...applicationBody, email: `applicant${i}@example.invalid` } });
    assert.equal(result.status, 503);
    assert.ok(!JSON.stringify(result.body).includes('private backend'));
  }
  assert.equal((await call('/ambassador-applications', { method: 'POST', body: applicationBody })).status, 429);
  assert.equal(calls.length, 10);
});

test('PocketBase config, safe login projection and separate secure bounded auth cookie', async (t) => {
  const { call, login, calls, dataFile } = await fixture(t, { secureCookies: true });
  assert.deepEqual((await call('/config')).body, { demoMode: false });
  assert.deepEqual((await call('/session')).body, { user: null });
  assert.equal((await call('/workspace')).status, 401);
  const loggedIn = await login();
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(loggedIn.body, { user });
  assert.equal(loggedIn.cookies.length, 1);
  assert.equal(loggedIn.cookies[0], `${authCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure`);
  assert.deepEqual(calls[0].body, { identity: user.email, password: ' Test password ' });
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers.apikey, undefined);
  assert.equal(calls[0].redirect, 'error');
  assert.ok(calls[0].signal instanceof AbortSignal);
  const workspace = await call('/workspace', { cookie: authCookie });
  assert.equal(workspace.status, 200);
  assert.deepEqual(workspace.cookies, []);
  assert.equal(workspace.body.emailConfigured, false);
  assert.equal(calls.at(-1).headers.Authorization, refreshedToken);
  assert.equal(existsSync(dataFile), false);
});

test('sessions refresh across app restarts without renewing cookies and trust refreshed roles', async (t) => {
  const first = await fixture(t);
  await first.login();
  const restarted = await fixture(t);
  const result = await restarted.call('/session', { cookie: authCookie });
  assert.deepEqual(result.body, { user });
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.calls[0].path, refreshAuth);
  assert.equal(restarted.calls[0].method, 'POST');
  assert.equal(restarted.calls[0].headers.Authorization, token);
  assert.deepEqual(result.cookies, []);
  restarted.setHandler(() => reply({ token: jwt(Math.floor(Date.now() / 1000) + 90), record: employee }));
  const short = await restarted.call('/session', { cookie: authCookie });
  assert.deepEqual(short.body, { user: employee });
  assert.deepEqual(short.cookies, []);
  const shortLogin = await restarted.login();
  const age = Number(shortLogin.cookies[0].match(/Max-Age=(\d+)/)[1]);
  assert.ok(age > 0 && age <= 90);
  assert.equal(shortLogin.cookies[0].includes('Secure'), false);
});

test('invalid ordinary sessions never mutate cookies or escalate to admin', async (t) => {
  const { call, login, calls, setHandler } = await fixture(t, {
    pocketbaseAdminEmail: 'admin@example.invalid', pocketbaseAdminPassword: 'test-admin-password',
  });
  for (const cookie of ['olbrygging_session=demo', 'olbrygging_pb_auth=bad-token', `olbrygging_pb_auth=${'a'.repeat(3801)}`]) {
    const invalid = await call('/session', { cookie });
    assert.deepEqual(invalid.body, { user: null });
    assert.deepEqual(invalid.cookies, []);
  }
  assert.equal(calls.length, 0);
  setHandler((request) => request.path === refreshAuth ? reply({ message: 'private detail' }, 401) : undefined);
  const invalid = await call('/session', { cookie: authCookie });
  assert.deepEqual(invalid.body, { user: null });
  assert.deepEqual(invalid.cookies, []);
  const unauthorized = await call('/workspace', { cookie: authCookie });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(unauthorized.cookies, []);
  setHandler(() => reply({ token, record: { ...user, role: 'superuser' } }));
  assert.equal((await login()).status, 403);
  const invalidRole = await call('/workspace', { cookie: authCookie });
  assert.equal(invalidRole.status, 403);
  assert.deepEqual(invalidRole.cookies, []);
  setHandler(() => reply({ message: 'private detail' }, 403));
  const forbidden = await call('/session', { cookie: authCookie });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(forbidden.cookies, []);
  assert.ok(calls.every((request) => request.path !== adminAuth));
});

test('delayed ordinary responses cannot restore logged-out cookies or overwrite a later account login', async (t) => {
  const { call, login, setHandler } = await fixture(t);
  for (const outcome of ['valid', 'invalid', 'invalid-role', 'outage']) {
    for (const action of ['logout', 'switch-account']) {
      let release;
      let started;
      const waiting = new Promise((resolve) => { started = resolve; });
      setHandler(async (request) => {
        if (request.path === userAuth) return reply({ token: adminToken, record: employee });
        if (request.path !== refreshAuth) return;
        started();
        await new Promise((resolve) => { release = resolve; });
        if (outcome === 'outage') throw new Error('offline');
        if (outcome === 'invalid') return reply({}, 401);
        return reply({ token: refreshedToken, record: outcome === 'invalid-role' ? { ...user, role: 'invalid' } : user });
      });
      const delayed = call('/session', { cookie: authCookie });
      await waiting;
      const later = action === 'logout'
        ? await call('/logout', { method: 'POST', cookie: authCookie })
        : await login();
      assert.equal(later.status, 200);
      assert.equal(later.cookies.length, 1);
      if (action === 'logout') assert.match(later.cookies[0], /Max-Age=0/);
      else assert.deepEqual(later.body, { user: employee });
      release();
      const result = await delayed;
      assert.equal(result.status, outcome === 'outage' ? 503 : outcome === 'invalid-role' ? 403 : 200);
      assert.deepEqual(result.cookies, [], `${outcome} response after ${action} must not modify the browser cookie`);
    }
  }
});

test('malformed provider tokens, records and expiry never become cookies or client data', async (t) => {
  const { login, setHandler } = await fixture(t);
  for (const bad of [null, '', 'not-a-jwt', 'a.b.c', `${token};unsafe`, 'a'.repeat(3801), jwt(0)]) {
    setHandler(() => reply({ token: bad, record: user }));
    const result = await login();
    assert.equal(result.status, 503);
    assert.equal(result.cookies.length, 0);
    assert.equal(JSON.stringify(result.body).includes('record'), false);
  }
  setHandler(() => reply({ token, record: { ...user, id: 'bad' } }));
  assert.equal((await login()).status, 503);
});

test('CRM mutations route directly to portal with refreshed user authorization only', async (t) => {
  const { call, calls, setHandler } = await fixture(t, {
    pocketbaseAdminEmail: 'admin@example.invalid', pocketbaseAdminPassword: 'test-admin-password',
    fetchProductPage: async () => new Response('<html><head><title>Test product</title></head></html>', {
      headers: { 'content-type': 'text/html' },
    }),
  });
  const input = {
    productId: 'malt', productUrl: 'https://www.olbrygging.no/produkt/test',
    subject: 'A request', description: 'An idea', channel: 'Blogg', promotionCount: '3',
  };
  assert.equal((await call('/tickets', { method: 'POST', cookie: authCookie, body: input })).status, 201);
  assert.equal(calls.at(-1).path, ticketsPath);
  assert.deepEqual(calls.at(-1).body, {
    ...input, promotionCount: 3,
    productSnapshot: {
      url: input.productUrl, name: 'Test product', description: '', price: null, currency: null, image: null,
    },
  });
  const urlOnly = {
    productUrl: 'https://www.olbrygging.no/produkt/url-only',
    subject: 'URL-only request', description: 'An idea', channel: 'Blogg',
  };
  assert.equal((await call('/tickets', { method: 'POST', cookie: authCookie, body: urlOnly })).status, 201);
  assert.equal(calls.at(-1).body.productId, undefined);
  assert.deepEqual(calls.at(-1).body.productSnapshot, {
    url: urlOnly.productUrl, name: 'Test product', description: '', price: null, currency: null, image: null,
  });
  const patch = { status: 'in_progress' };
  assert.equal((await call(`/tickets/${ticket.id}`, { method: 'PATCH', cookie: authCookie, body: patch })).status, 200);
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.deepEqual(calls.at(-1).body, patch);
  const message = await call(`/tickets/${ticket.id}/messages`, { method: 'POST', cookie: authCookie, body: { body: 'Hello' } });
  assert.equal(message.status, 201);
  assert.deepEqual(message.cookies, []);
  assert.equal(message.body.message.emailStatus, 'not_requested');
  assert.equal(calls.at(-1).path, messagePath);
  assert.ok(calls.filter((request) => request.path.startsWith('/api/portal/')).every((request) => request.headers.Authorization === refreshedToken));
  assert.equal(calls.some((request) => request.path === adminAuth), false);
  setHandler((request) => request.path === `${ticketsPath}/${ticket.id}` ? reply({ message: 'sensitive SQL detail' }, 403) : undefined);
  const denied = await call(`/tickets/${ticket.id}`, { method: 'PATCH', cookie: authCookie, body: patch });
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(denied.body).includes('sensitive'), false);
});

test('PocketBase product previews validate and fetch metadata without exposing a backend token', async (t) => {
  const { call, calls } = await fixture(t, {
    fetchProductPage: async () => new Response('<html><head><title>Test product</title></head></html>', {
      headers: { 'content-type': 'text/html' },
    }),
  });
  const result = await call('/products/preview', {
    method: 'POST', cookie: authCookie, body: { url: 'https://www.olbrygging.no/produkt/test' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.product.name, 'Test product');
  assert.equal(calls.at(-1).path, refreshAuth);
  assert.equal(calls.at(-1).headers.Authorization, authCookie.slice('olbrygging_pb_auth='.length));
});

test('profile, article and damage-report APIs route through user-scoped PocketBase hooks', async (t) => {
  const { call, calls, setHandler } = await fixture(t);
  setHandler((request) => {
    if (request.path === '/api/portal/profile' || request.path.startsWith('/api/portal/users/')) {
      return reply({ user });
    }
    if (request.path === '/api/portal/articles' && request.method === 'GET') return reply({ articles: [] });
    if (request.path.startsWith('/api/portal/articles')) return reply({ article: { id: 'article00000001' } }, 201);
    if (request.path === '/api/portal/damage-reports' || request.path.startsWith('/api/portal/damage-reports/')) {
      return reply({ report: { id: 'report000000001' } }, 201);
    }
  });
  const profile = await call('/profile', { method: 'PATCH', cookie: authCookie, body: { socialMedia: '@test' } });
  assert.equal(profile.status, 200);
  assert.equal(calls.at(-1).path, '/api/portal/profile');
  assert.equal(calls.at(-1).headers.Authorization, refreshedToken);
  await call(`/users/${employee.id}`, { method: 'PATCH', cookie: authCookie, body: { name: 'Updated' } });
  assert.equal(calls.at(-1).path, `/api/portal/users/${employee.id}`);
  assert.deepEqual((await call('/articles', { cookie: authCookie })).body, { articles: [] });
  await call('/articles', { method: 'POST', cookie: authCookie, body: { title: 'Guide', body: 'Text', category: 'Tips' } });
  assert.equal(calls.at(-1).path, '/api/portal/articles');
  await call('/articles/article00000001', { method: 'PATCH', cookie: authCookie, body: { title: 'Updated' } });
  assert.equal(calls.at(-1).path, '/api/portal/articles/article00000001');
  await call('/damage-reports', { method: 'POST', cookie: authCookie, body: { description: 'Damaged item' } });
  assert.equal(calls.at(-1).path, '/api/portal/damage-reports');
  await call('/damage-reports/report000000001', { method: 'PATCH', cookie: authCookie, body: { status: 'approved' } });
  assert.equal(calls.at(-1).path, '/api/portal/damage-reports/report000000001');
  assert.ok(calls.filter((request) => request.path.startsWith('/api/portal/')).every((request) => request.headers.Authorization === refreshedToken));
  assert.equal((await call('/users', { method: 'POST', cookie: authCookie, body: {} })).status, 403);
});

test('PocketBase retains same-origin, method, field, body size and ticket ID validation', async (t) => {
  const { call, calls } = await fixture(t);
  assert.equal((await call('/login', { method: 'POST', body: {}, headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await call('/login', { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('/workspace', { method: 'POST' })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  assert.equal(calls.length, 0);
  assert.equal((await call('/tickets', { method: 'POST', cookie: authCookie, body: { role: 'employee' } })).status, 400);
  assert.equal((await call('/tickets/not-a-pb-id', { method: 'PATCH', cookie: authCookie, body: { status: 'approved' } })).status, 404);
  assert.equal((await call('/tickets', { method: 'POST', cookie: authCookie, body: { description: 'x'.repeat(25 * 1024) } })).status, 413);
  assert.equal((await call('/login', { method: 'POST', raw: '{' })).status, 400);
  assert.equal((await call('/login', { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(calls.some((request) => request.path.startsWith('/api/portal/')), false);
});

test('sanitized upstream errors never fall back to demo or disclose provider details', async (t) => {
  const { call, login, setHandler, dataFile } = await fixture(t);
  setHandler(() => reply({ message: 'secret backend detail' }, 400));
  assert.deepEqual(await login().then(({ status, body }) => ({ status, body })), {
    status: 401, body: { error: 'Feil e-post eller passord.' },
  });
  for (const status of [429, 500, 302]) {
    setHandler(() => reply({ message: 'secret backend detail' }, status));
    const result = await login();
    assert.equal(result.status, status === 429 ? 429 : 503);
    assert.equal(JSON.stringify(result.body).includes('secret'), false);
  }
  setHandler(() => new Response('private invalid JSON', { status: 200 }));
  assert.equal((await login()).status, 503);
  setHandler(() => { throw new Error('secret backend detail'); });
  const outage = await call('/session', { cookie: authCookie });
  assert.equal(outage.status, 503);
  assert.equal(JSON.stringify(outage.body).includes('secret'), false);
  assert.equal(existsSync(dataFile), false);
});

test('timeouts are bounded and stateless logout clears cookies without contacting an offline provider', async (t) => {
  let requests = 0;
  const { call } = await fixture(t, {
    pocketbaseTimeoutMs: 5,
    fetchPocketbase: async (_url, options) => {
      requests++;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  assert.equal((await call('/session', { cookie: authCookie })).status, 503);
  assert.equal(requests, 1);
  const logout = await call('/logout', { method: 'POST', cookie: authCookie });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.body, { user: null });
  assert.equal(logout.cookies.length, 1);
  assert.match(logout.cookies[0], /^olbrygging_pb_auth=;.*Max-Age=0/);
  assert.equal(requests, 1);
  assert.equal((await call('/logout', { method: 'POST' })).status, 200);
});

const emailOptions = {
  emailApiKey: 'test-email-key', emailFrom: 'portal@example.invalid',
  pocketbaseAdminEmail: 'admin@example.invalid', pocketbaseAdminPassword: 'test-admin-password',
};

test('email persists first, selects opposite participant and isolates admin credentials to email result', async (t) => {
  let fixtureData;
  let delivered;
  fixtureData = await fixture(t, {
    ...emailOptions,
    fetchEmail: async (url, request) => {
      assert.equal(url, 'https://api.resend.com/emails');
      assert.ok(fixtureData.calls.some((call) => call.path === messagePath));
      assert.equal(fixtureData.calls.at(-1).path, workspacePath);
      assert.equal(request.redirect, 'error');
      assert.ok(request.signal instanceof AbortSignal);
      delivered = JSON.parse(request.body);
      return new Response(null, { status: 202 });
    },
  });
  assert.equal((await fixtureData.call('/workspace', { cookie: authCookie })).body.emailConfigured, true);
  assert.equal(fixtureData.calls.some((call) => call.path === adminAuth), false);
  const result = await fixtureData.call(`/tickets/${ticket.id}/messages`, {
    method: 'POST', cookie: authCookie, body: { body: 'Test message', sendEmail: true },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.message.emailStatus, 'sent');
  assert.deepEqual(delivered.to, [employee.email]);
  assert.deepEqual(fixtureData.calls.at(-2).body, { identity: emailOptions.pocketbaseAdminEmail, password: emailOptions.pocketbaseAdminPassword });
  assert.equal(fixtureData.calls.at(-2).headers.Authorization, undefined);
  assert.equal(fixtureData.calls.at(-1).path, resultPath);
  assert.equal(fixtureData.calls.at(-1).headers.Authorization, adminToken);
  assert.deepEqual(fixtureData.calls.at(-1).body, { deliveryStatus: 'sent' });
  assert.equal(fixtureData.calls.filter((call) => call.headers.Authorization === adminToken).length, 1);
  assert.equal(JSON.stringify(result.body).includes('admin'), false);
  fixtureData.setHandler((request) => request.path === refreshAuth ? reply({ token: refreshedToken, record: employee }) : undefined);
  await fixtureData.call(`/tickets/${ticket.id}/messages`, { method: 'POST', cookie: authCookie, body: { body: 'Employee reply', sendEmail: true } });
  assert.deepEqual(delivered.to, [user.email]);
});

test('email or admin failures cannot lose saved messages or falsely report delivery', async (t) => {
  const { call, calls, setHandler } = await fixture(t, {
    ...emailOptions, fetchEmail: async () => { throw new Error('email offline'); },
  });
  const send = () => call(`/tickets/${ticket.id}/messages`, { method: 'POST', cookie: authCookie, body: { body: 'Keep this message', sendEmail: true } });
  const failed = await send();
  assert.equal(failed.status, 201);
  assert.equal(failed.body.message.body, 'Keep this message');
  assert.equal(failed.body.message.emailStatus, 'failed');
  assert.deepEqual(calls.at(-1).body, { deliveryStatus: 'failed' });
  setHandler((request) => request.path === adminAuth ? reply({ message: 'admin private' }, 401) : undefined);
  const adminFailure = await send();
  assert.equal(adminFailure.status, 201);
  assert.equal(adminFailure.body.message.emailStatus, 'failed');
  assert.equal(JSON.stringify(adminFailure.body).includes('private'), false);
});

test('Resend alone is not configured and cannot use administrator access', async (t) => {
  const { call, calls } = await fixture(t, {
    emailApiKey: emailOptions.emailApiKey, emailFrom: emailOptions.emailFrom,
    fetchEmail: async () => { assert.fail('Email is not configured without admin credentials'); },
  });
  assert.equal((await call('/workspace', { cookie: authCookie })).body.emailConfigured, false);
  const result = await call(`/tickets/${ticket.id}/messages`, { method: 'POST', cookie: authCookie, body: { body: 'Saved', sendEmail: true } });
  assert.equal(result.status, 201);
  assert.equal(result.body.message.emailStatus, 'failed');
  assert.equal(calls.some((call) => call.path === adminAuth || call.path === resultPath), false);
});

test('email timeouts and delivery-result outages preserve durable failure markers', async (t) => {
  const { call, calls, setHandler } = await fixture(t, {
    ...emailOptions, emailTimeoutMs: 5,
    fetchEmail: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  const send = () => call(`/tickets/${ticket.id}/messages`, {
    method: 'POST', cookie: authCookie, body: { body: 'Durable despite timeout', sendEmail: true },
  });
  const timeout = await send();
  assert.equal(timeout.status, 201);
  assert.equal(timeout.body.message.emailStatus, 'failed');
  assert.deepEqual(calls.at(-1).body, { deliveryStatus: 'failed' });
  setHandler((request) => request.path === resultPath ? reply({ message: 'private admin detail' }, 503) : undefined);
  const outage = await send();
  assert.equal(outage.status, 201);
  assert.equal(outage.body.message.body, 'Durable despite timeout');
  assert.equal(outage.body.message.emailStatus, 'failed');
  assert.equal(JSON.stringify(outage.body).includes('private'), false);
});

test('PocketBase configuration rejects unsafe origins and partial admin settings', () => {
  for (const pocketbaseUrl of [
    'invalid', 'http://pb.example.invalid', 'https://pb.example.invalid/path',
    'https://pb.example.invalid?query=1', 'https://pb.example.invalid#hash', ['https://', 'user:pass', '@pb.example.invalid'].join(''),
  ]) assert.throws(() => createApp({ pocketbaseUrl }), /HTTPS origin/);
  for (const pocketbaseUrl of ['https://pb.example.invalid', 'http://127.0.0.1:8090', 'http://localhost:8090', 'http://[::1]:8090']) {
    assert.doesNotThrow(() => createApp({ pocketbaseUrl }));
  }
  assert.throws(() => createApp({ pocketbaseUrl: 'https://pb.example.invalid', pocketbaseAdminEmail: 'admin@example.invalid' }), /Set both/);
  assert.throws(() => createApp({ pocketbaseUrl: 'https://pb.example.invalid', pocketbaseAdminPassword: 'test-password' }), /Set both/);
});

test('PocketBase environment wiring and production require provider plus secure cookies', () => {
  const keys = ['NODE_ENV', 'POCKETBASE_URL', 'POCKETBASE_ADMIN_EMAIL', 'POCKETBASE_ADMIN_PASSWORD', 'COOKIE_SECURE'];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.NODE_ENV = 'production';
    assert.throws(() => createApp(), /Production requires PocketBase/);
    process.env.POCKETBASE_URL = 'https://pb.example.invalid';
    assert.throws(() => createApp(), /COOKIE_SECURE=true/);
    process.env.COOKIE_SECURE = 'true';
    assert.doesNotThrow(() => createApp());
    process.env.POCKETBASE_ADMIN_EMAIL = 'admin@example.invalid';
    assert.throws(() => createApp(), /Set both/);
    process.env.POCKETBASE_ADMIN_PASSWORD = 'test-password';
    assert.doesNotThrow(() => createApp());
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
