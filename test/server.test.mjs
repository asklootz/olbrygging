import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../server.mjs';

const TEST_ROOT = resolve('.test-data');
mkdirSync(TEST_ROOT, { recursive: true });

async function fixture(t, options = {}) {
  const directory = mkdtempSync(resolve(TEST_ROOT, 'workspace-'));
  const dataFile = resolve(directory, 'workspace.json');
  const publicDir = resolve(directory, 'public');
  mkdirSync(publicDir);
  writeFileSync(resolve(publicDir, 'index.html'), '<!doctype html><title>Demo</title>');
  const app = createApp({
    pocketbaseUrl: '',
    dataFile, publicDir,
    fetchProductPage: async () => new Response('<html><head><meta property="og:title" content="Test product"></head></html>', {
      headers: { 'content-type': 'text/html' },
    }),
    ...options,
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise((done) => app.close(done));
    rmSync(directory, { recursive: true, force: true });
  });
  async function call(path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(method !== 'GET' ? { origin: base, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    return { status: response.status, body: payload, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  async function login(email = 'ambassador@olbrygging.example') {
    const result = await call('/api/login', { method: 'POST', body: { email, password: 'BrewTogether!2026' } });
    assert.equal(result.status, 200);
    return result.cookie;
  }
  return { app, base, call, login, dataFile, publicDir, directory };
}

test('PWA assets are publicly served with correct types and revalidation headers', async (t) => {
  const { base } = await fixture(t, { publicDir: resolve('public') });
  for (const [path, type] of [['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'text/javascript'], ['/pwa.js', 'text/javascript'], ['/mobile.css', 'text/css'], ['/icons/icon-192.png', 'image/png'], ['/icons/icon-512.png', 'image/png'], ['/icons/apple-touch-icon.png', 'image/png']]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
});

test('JSON demo explicitly refuses real ambassador applications', async (t) => {
  const { call, dataFile } = await fixture(t);
  const before = readFileSync(dataFile, 'utf8');
  const response = await call('/api/ambassador-applications', { method: 'POST', body: {} });
  assert.equal(response.status, 503);
  assert.match(response.body.error, /PocketBase/);
  assert.equal(readFileSync(dataFile, 'utf8'), before);
});

test('authentication, safe workspace data, strict cookies and logout', async (t) => {
  const { call, login, dataFile } = await fixture(t);
  assert.deepEqual((await call('/api/config')).body, { demoMode: true });
  assert.deepEqual((await call('/api/session')).body, { user: null });
  assert.equal((await call('/api/workspace')).status, 401);
  const rejected = await call('/api/login', { method: 'POST', body: { email: 'ambassador@olbrygging.example', password: 'wrong' } });
  assert.equal(rejected.status, 401);
  const loggedIn = await call('/api/login', { method: 'POST', body: { email: 'ambassador@olbrygging.example', password: 'BrewTogether!2026' } });
  assert.match(loggedIn.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(loggedIn.cookie, /^olbrygging_session=[a-f0-9]{64}$/);
  const cookie = loggedIn.cookie;
  assert.equal((await call('/api/session', { cookie })).body.user.role, 'ambassador');
  const workspace = (await call('/api/workspace', { cookie })).body;
  assert.equal(workspace.products.length, 8);
  assert.equal(workspace.tickets.length, 4);
  assert.ok(workspace.tickets.every((ticket) => ticket.ambassadorId === 'emil'));
  assert.equal(workspace.users.some((user) => user.id === 'sara'), false);
  assert.equal(workspace.users.find((user) => user.id === 'marius')?.role, 'employee');
  assert.equal(JSON.stringify(workspace).includes('passwordHash'), false);
  assert.equal(JSON.stringify(workspace).includes('BrewTogether'), false);
  const stored = readFileSync(dataFile, 'utf8');
  assert.equal(stored.includes('BrewTogether'), false);
  assert.match(JSON.parse(stored).users[0].passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const staff = await login('employee@olbrygging.example');
  assert.equal((await call('/api/workspace', { cookie: staff })).body.tickets.length, 5);
  assert.equal((await call('/api/logout', { method: 'POST', cookie })).status, 200);
  assert.deepEqual((await call('/api/session', { cookie })).body, { user: null });
});

test('ticket content versions, review decisions and publication links gate closure and persist across restart', async (t) => {
  const { call, login, dataFile, publicDir, base } = await fixture(t);
  const cookie = await login();
  const staff = await login('employee@olbrygging.example');
  const created = await call('/api/tickets', {
    method: 'POST', cookie,
    body: { productId: 'fjord-pale', productUrl: 'https://www.olbrygging.no/produkt/demo', subject: 'Mitt neste brygg', description: 'En ny bildeserie om bryggedagen.', channel: 'Instagram', dueDate: '2026-11-03' },
  });
  assert.equal(created.status, 201);
  const { ticket } = created.body;
  assert.equal(ticket.number, 1006);
  assert.equal(ticket.displayNumber, '1006-1');
  assert.equal(ticket.status, 'requested');
  assert.equal(ticket.assigneeId, 'nora');
  const path = `/api/tickets/${ticket.id}`;
  assert.equal((await call(path, { method: 'PATCH', cookie, body: { status: 'approved' } })).status, 403);
  assert.equal((await call(path, { method: 'PATCH', cookie: staff, body: { status: 'approved', assigneeId: 'emil' } })).status, 400);
  const approved = await call(path, { method: 'PATCH', cookie: staff, body: { status: 'approved', assigneeId: 'marius', dueDate: '2026-11-04' } });
  assert.equal(approved.body.ticket.status, 'approved');
  assert.equal(approved.body.ticket.assigneeId, 'marius');
  assert.equal(approved.body.ticket.dueDate, '2026-11-04');
  assert.equal((await call(path, { method: 'PATCH', cookie, body: { status: 'in_progress' } })).status, 200);
  assert.equal((await call(path, { method: 'PATCH', cookie, body: { status: 'review' } })).status, 403);
  assert.equal((await call(path, { method: 'PATCH', cookie: staff, body: { status: 'completed' } })).status, 400);
  assert.equal((await call(path, { method: 'PATCH', cookie, body: { status: 'completed' } })).status, 403);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const send = async (who, caption) => {
    const form = new FormData();
    form.append('caption', caption);
    form.append('link', 'https://example.invalid/draft');
    form.append('files', new Blob([png], { type: 'image/png' }), 'post draft.png');
    const response = await fetch(`${base}${path}/submissions`, { method: 'POST', headers: { origin: base, cookie: who }, body: form });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await send(cookie, 'first version')).status, 201);
  const first = (await call('/api/workspace', { cookie: staff })).body.tickets.find((item) => item.id === ticket.id).submissions[0];
  assert.equal(first.version, 1);
  assert.equal(first.status, 'submitted');
  assert.equal(JSON.stringify(first).includes('storageKey'), false);
  assert.equal((await send(cookie, 'duplicate')).status, 409);
  assert.equal((await call(path, { method: 'PATCH', cookie: staff, body: { status: 'in_progress' } })).status, 409);
  const fileUrl = `${base}/api/submissions/${first.id}/files/${encodeURIComponent(first.files[0].name)}`;
  assert.equal((await fetch(fileUrl)).status, 401);
  const unauthorizedFile = await fetch(fileUrl, { headers: { cookie: await login('sara@olbrygging.example') } });
  assert.equal(unauthorizedFile.status, 404);
  const preview = await fetch(fileUrl, { headers: { cookie: staff } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /image\/png/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  assert.equal((await call(`/api/submissions/${first.id}/decision`, { method: 'POST', cookie: staff, body: { decision: 'changes_requested' } })).status, 400);
  const returned = await call(`/api/submissions/${first.id}/decision`, { method: 'POST', cookie: staff, body: { decision: 'changes_requested', feedback: 'Flytt teksten bort fra produktet.' } });
  assert.equal(returned.status, 200);
  assert.equal(returned.body.submission.reviewerId, 'nora');
  assert.equal((await call(`/api/submissions/${first.id}/decision`, { method: 'POST', cookie: staff, body: { decision: 'approved' } })).status, 409);
  const secondSubmission = await send(cookie, 'revised version');
  assert.equal(secondSubmission.status, 201);
  assert.equal(secondSubmission.body.submission.version, 2);
  assert.equal((await call(`/api/submissions/${first.id}/decision`, { method: 'POST', cookie: staff, body: { decision: 'approved' } })).status, 409);
  const reviews = await Promise.all([1, 2].map(() => call(`/api/submissions/${secondSubmission.body.submission.id}/decision`, {
    method: 'POST', cookie: staff, body: { decision: 'approved', feedback: 'Godkjent.' },
  })));
  assert.deepEqual(reviews.map((review) => review.status).sort(), [200, 409]);
  assert.equal((await call(path, { method: 'PATCH', cookie: staff, body: { status: 'completed' } })).status, 400);
  assert.equal((await call(`/api/tickets/${ticket.id}/publication`, { method: 'PATCH', cookie, body: { url: 'http://example.invalid/post' } })).status, 400);
  assert.equal((await call(`/api/tickets/${ticket.id}/publication`, { method: 'PATCH', cookie, body: { url: 'https://example.invalid/post/123' } })).status, 200);
  assert.equal((await call(path, { method: 'PATCH', cookie: staff, body: { status: 'completed' } })).status, 200);
  const secondApp = createApp({ dataFile, publicDir, pocketbaseUrl: '' });
  secondApp.listen(0, '127.0.0.1');
  await once(secondApp, 'listening');
  t.after(() => new Promise((done) => secondApp.close(done)));
  const origin = `http://127.0.0.1:${secondApp.address().port}`;
  const session = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ambassador@olbrygging.example', password: 'BrewTogether!2026' }),
  });
  await session.json();
  const result = await fetch(`${origin}/api/workspace`, { headers: { cookie: session.headers.get('set-cookie').split(';')[0] } });
  const persistedTicket = (await result.json()).tickets.find((item) => item.id === ticket.id);
  assert.equal(persistedTicket.status, 'completed');
  assert.equal(persistedTicket.assigneeId, 'marius');
  assert.equal(persistedTicket.publicationUrl, 'https://example.invalid/post/123');
  assert.deepEqual(persistedTicket.submissions.map((item) => item.version), [1, 2]);
});

test('content uploads enforce ownership, media types, counts, limits and safe file names', async (t) => {
  const { base, login } = await fixture(t);
  const ambassador = await login();
  const other = await login('sara@olbrygging.example');
  const staff = await login('employee@olbrygging.example');
  const png = readFileSync(new URL('../public/icons/icon-192.png', import.meta.url));
  const image = () => new Blob([png], { type: 'image/png' });
  const submit = async (cookie, files, link = '') => {
    const form = new FormData();
    form.append('link', link);
    for (const [blob, name] of files) form.append('files', blob, name);
    const response = await fetch(`${base}/api/tickets/ticket-1001/submissions`, {
      method: 'POST', headers: { origin: base, ...(cookie ? { cookie } : {}) }, body: form,
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await submit(null, [[image(), 'test.png']])).status, 401);
  assert.equal((await submit(other, [[image(), 'test.png']])).status, 404);
  assert.equal((await submit(staff, [[image(), 'test.png']])).status, 403);
  assert.equal((await submit(ambassador, [])).status, 400);
  assert.equal((await submit(ambassador, [[new Blob(['not an image'], { type: 'image/png' }), 'fake.png']])).status, 400);
  assert.equal((await submit(ambassador, Array.from({ length: 6 }, () => [image(), 'test.png']))).status, 400);
  assert.equal((await submit(ambassador, [[new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png']])).status, 413);
  assert.equal((await submit(ambassador, [[image(), 'test.png']], 'javascript:alert(1)')).status, 400);
  const video = new Blob([Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])], { type: 'video/mp4' });
  const accepted = await submit(ambassador, [[image(), 'same.png'], [image(), 'same.png'], [image(), 'wrong.mp4'], [video, 'video.mp4']]);
  assert.equal(accepted.status, 201);
  assert.equal(new Set(accepted.body.submission.files.map((file) => file.name)).size, 4);
  assert.deepEqual(accepted.body.submission.files.map((file) => file.type), ['image/png', 'image/png', 'image/png', 'video/mp4']);
  assert.equal(accepted.body.submission.files[2].displayName, 'wrong.png');
  const preview = await fetch(`${base}/api/submissions/${accepted.body.submission.id}/files/${accepted.body.submission.files[3].name}`, { headers: { cookie: ambassador } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'video/mp4');
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  const videoUrl = `${base}/api/submissions/${accepted.body.submission.id}/files/${accepted.body.submission.files[3].name}`;
  const partial = await fetch(videoUrl, { headers: { cookie: ambassador, range: 'bytes=4-7' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 4-7/16');
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), 'ftyp');
  const suffix = await fetch(videoUrl, { headers: { cookie: ambassador, range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), 'bytes 12-15/16');
  assert.equal((await suffix.arrayBuffer()).byteLength, 4);
  const invalidRange = await fetch(videoUrl, { headers: { cookie: ambassador, range: 'bytes=100-' } });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), 'bytes */16');
});

test('ambassador promotion quantity defaults to one and creates separately numbered ticket instances', async (t) => {
  const { call, login } = await fixture(t);
  const cookie = await login();
  const input = {
    productId: 'fjord-pale', productUrl: 'https://www.olbrygging.no/produkt/demo',
    subject: 'Promote this product', description: 'Separate promotion drafts.', channel: 'Instagram',
    promotionCount: '3',
  };
  const response = await call('/api/tickets', { method: 'POST', cookie, body: input });
  assert.equal(response.status, 201);
  assert.equal(response.body.promotionCount, 3);
  assert.equal(response.body.tickets.length, 3);
  const { ticket, tickets } = response.body;
  assert.deepEqual(tickets.map((item) => item.displayNumber), ['1006-1', '1006-2', '1006-3']);
  assert.deepEqual(tickets.map((item) => item.number), [1006, 1007, 1008]);
  assert.equal(new Set(tickets.map((item) => item.id)).size, 3);
  assert.ok(tickets.every((item) => item.promotionBase === 1006 && item.promotionCount === 3));
  assert.ok(tickets.every((item) => item.ambassadorId === 'emil' && item.status === 'requested'));
  assert.equal(ticket.id, tickets[0].id);
  for (const promotionCount of [0, -1, 1.5, 51, '51', '', 'many', null, true, [], [3], {}]) {
    assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: { ...input, promotionCount } })).status, 400);
  }
  const staff = await login('employee@olbrygging.example');
  assert.equal((await call(`/api/tickets/${tickets[0].id}`, { method: 'PATCH', cookie: staff, body: { status: 'approved' } })).status, 200);
  await call(`/api/tickets/${tickets[0].id}/messages`, { method: 'POST', cookie, body: { body: 'Only instance 1' } });
  const workspace = (await call('/api/workspace', { cookie })).body;
  assert.equal(workspace.tickets.find((item) => item.id === tickets[0].id).status, 'approved');
  assert.equal(workspace.tickets.find((item) => item.id === tickets[0].id).messages.length, 1);
  assert.equal(workspace.tickets.find((item) => item.id === tickets[1].id).status, 'requested');
  assert.deepEqual(workspace.tickets.find((item) => item.id === tickets[1].id).messages, []);
  assert.equal(workspace.tickets.find((item) => item.number === 1001).displayNumber, undefined);
  const next = await call('/api/tickets', { method: 'POST', cookie, body: { ...input, promotionCount: undefined } });
  assert.equal(next.body.ticket.displayNumber, '1009-1');
  assert.equal(next.body.tickets.length, 1);
});

test('ambassadors can submit URL-only promotion requests without a catalogue product ID', async (t) => {
  const { call, login } = await fixture(t, {
    fetchProductPage: async () => new Response('<html><head><meta property="og:title" content="URL-only product"></head></html>', {
      headers: { 'content-type': 'text/html' },
    }),
  });
  const cookie = await login();
  const response = await call('/api/tickets', {
    method: 'POST', cookie,
    body: {
      productUrl: 'https://www.olbrygging.no/produkt/url-only', subject: 'URL-only request',
      description: 'A new idea', channel: 'Instagram', promotionCount: 2,
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.ticket.productId, null);
  assert.equal(response.body.ticket.productSnapshot.name, 'URL-only product');
  assert.deepEqual(response.body.tickets.map((ticket) => ticket.displayNumber), ['1006-1', '1006-2']);
});

test('employees create URL-based open tasks with separate deadlines and ambassadors claim once', async (t) => {
  const { call, login } = await fixture(t, {
    fetchProductPage: async () => new Response(`<html><head><meta property="og:image" content="/images/produkt.jpg"><script type="application/ld+json">{"@type":"Product","name":"Test product","description":"Friske råvarer","offers":{"price":"129.50","priceCurrency":"NOK"}}</script></head></html>`, {
      headers: { 'content-type': 'text/html' },
    }),
  });
  const staff = await login('employee@olbrygging.example');
  const ambassador = await login();
  const otherAmbassador = await login('sara@olbrygging.example');
  const later = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const body = {
    productUrl: 'https://www.olbrygging.no/produkt/seasonal',
    subject: 'Sesongens brygg', description: 'Del din egen idé og erfaring.',
    acceptBy: later(5), dueDate: later(15), promotionCount: 3,
  };
  const created = await call('/api/tasks', { method: 'POST', cookie: staff, body });
  assert.equal(created.status, 201);
  assert.equal(created.body.promotionCount, 3);
  assert.deepEqual(created.body.tickets.map((ticket) => ticket.displayNumber), ['1006-1', '1006-2', '1006-3']);
  assert.ok(created.body.tickets.every((ticket) => ticket.promotionOpen));
  assert.equal(created.body.ticket.status, 'available');
  assert.equal(created.body.ticket.productSnapshot.name, 'Test product');
  assert.equal(created.body.ticket.productSnapshot.image, 'https://www.olbrygging.no/images/produkt.jpg');
  assert.equal(created.body.ticket.productSnapshot.price, 129.5);
  assert.equal(created.body.ticket.productSnapshot.description, 'Friske råvarer');
  assert.equal(created.body.ticket.productId, null);
  assert.equal(created.body.ticket.ambassadorId, '');
  assert.equal(created.body.ticket.channel, '');
  assert.equal(created.body.ticket.acceptBy, body.acceptBy);
  assert.equal(created.body.ticket.dueDate, body.dueDate);
  assert.equal((await call('/api/tasks', { method: 'POST', cookie: ambassador, body })).status, 403);
  for (const changes of [{ acceptBy: later(20) }, { dueDate: later(4) }, { channel: 'Instagram' }, { ambassadorId: 'sara' }]) {
    assert.equal((await call('/api/tasks', { method: 'POST', cookie: staff, body: { ...body, ...changes } })).status, 400);
  }
  const [first, second] = created.body.tickets;
  const id = first.id;
  const offered = (await call('/api/workspace', { cookie: ambassador })).body.tickets.find((ticket) => ticket.id === id);
  assert.ok(offered);
  assert.equal((await call(`/api/tickets/${id}/messages`, { method: 'POST', cookie: ambassador, body: { body: 'claim?' } })).status, 404);
  assert.equal((await call(`/api/tickets/${id}/accept`, { method: 'POST', cookie: staff, body: {} })).status, 403);
  const accepted = await call(`/api/tickets/${id}/accept`, { method: 'POST', cookie: ambassador, body: {} });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.ticket.ambassadorId, 'emil');
  assert.equal(accepted.body.ticket.status, 'approved');
  assert.equal((await call(`/api/tickets/${id}/accept`, { method: 'POST', cookie: otherAmbassador, body: {} })).status, 409);
  assert.equal((await call(`/api/tickets/${second.id}/accept`, { method: 'POST', cookie: ambassador, body: {} })).status, 409);
  const secondAccepted = await call(`/api/tickets/${second.id}/accept`, { method: 'POST', cookie: otherAmbassador, body: {} });
  assert.equal(secondAccepted.status, 200);
  assert.equal(secondAccepted.body.ticket.ambassadorId, 'sara');
  assert.equal((await call(`/api/tickets/${id}`, { method: 'PATCH', cookie: ambassador, body: { channel: 'TikTok' } })).body.ticket.channel, 'TikTok');
  assert.equal((await call(`/api/tickets/${id}`, { method: 'PATCH', cookie: ambassador, body: { status: 'in_progress' } })).status, 200);
});

test('product page links are restricted and fetched product details are attached to tickets', async (t) => {
  let html = `<!doctype html><html><head>
    <meta property="og:image" content="/images/produkt.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Humle &amp; malt","description":"Friske råvarer","image":"/images/humle.jpg","offers":{"price":"129.50","priceCurrency":"NOK"}}</script>
    </head><body></body></html>`;
  const productHtml = html;
  let fetched;
  const { call, login } = await fixture(t, {
    fetchProductPage: async (url, options) => {
      fetched = { url, options };
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  const cookie = await login();
  for (const url of ['http://www.olbrygging.no/produkt/a', 'https://evil.example/produkt/a', 'https://www.olbrygging.no/']) {
    assert.equal((await call('/api/products/preview', { method: 'POST', cookie, body: { url } })).status, 400);
  }
  assert.equal(fetched, undefined);
  const preview = await call('/api/products/preview', {
    method: 'POST', cookie, body: { url: 'https://www.olbrygging.no/produkt/a#detaljer' },
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.product, {
    url: 'https://www.olbrygging.no/produkt/a',
    name: 'Humle & malt',
    description: 'Friske råvarer',
    price: 129.5,
    currency: 'NOK',
    image: 'https://www.olbrygging.no/images/produkt.jpg',
  });
  assert.equal(fetched.options.redirect, 'manual');
  assert.equal(fetched.options.headers.Accept, 'text/html');
  html = '<!doctype html><html><head><meta property="og:title" content="Produkt uten detaljer"></head></html>';
  const missingDetails = await call('/api/products/preview', {
    method: 'POST', cookie, body: { url: 'https://www.olbrygging.no/produkt/uten-detaljer' },
  });
  assert.equal(missingDetails.body.product.price, null);
  assert.equal(missingDetails.body.product.image, null);
  html = '<!doctype html><html><head><script type="application/ld+json">{"@type":"Product","name":"Gratis produkt","offers":{"price":0}}</script></head></html>';
  const freeProduct = await call('/api/products/preview', {
    method: 'POST', cookie, body: { url: 'https://www.olbrygging.no/produkt/gratis' },
  });
  assert.equal(freeProduct.body.product.price, 0);
  html = productHtml;
  const created = await call('/api/tickets', {
    method: 'POST', cookie,
    body: {
      productId: 'hop-citra', productUrl: 'https://www.olbrygging.no/produkt/a',
      subject: 'En råvareguide', description: 'Presentere produktet.', channel: 'Instagram',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.ticket.productUrl, 'https://www.olbrygging.no/produkt/a');
  assert.equal(created.body.ticket.productSnapshot.name, 'Humle & malt');
  assert.equal(created.body.ticket.productSnapshot.price, 129.5);
});

test('cross-ambassador access, protected fields, and explicit staff creation', async (t) => {
  const { call, login } = await fixture(t);
  const cookie = await login();
  for (const [path, method, body] of [
    ['/api/tickets/ticket-1005', 'PATCH', { status: 'in_progress' }],
    ['/api/tickets/ticket-1005/messages', 'POST', { body: 'Ikke min forespørsel' }],
    ['/api/tickets/does-not-exist/messages', 'POST', { body: 'Hallo' }],
  ]) assert.equal((await call(path, { method, cookie, body })).status, 404);
  assert.equal((await call('/api/tickets/ticket-1002', { method: 'PATCH', cookie, body: { assigneeId: 'nora' } })).status, 403);
  const body = { productId: 'malt', productUrl: 'https://www.olbrygging.no/produkt/demo', subject: 'En maltguide', description: 'Dette er en ny guide.', channel: 'Blogg' };
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: { ...body, ambassadorId: 'sara' } })).status, 403);
  const staff = await login('employee@olbrygging.example');
  assert.equal((await call('/api/tickets', { method: 'POST', cookie: staff, body })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie: staff, body: { ...body, ambassadorId: 'nora' } })).status, 400);
  const created = await call('/api/tickets', { method: 'POST', cookie: staff, body: { ...body, ambassadorId: 'sara' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.ticket.ambassadorId, 'sara');
});

test('messages remain saved when email is unavailable or fails', async (t) => {
  let outgoing;
  const { call, login, dataFile } = await fixture(t, {
    emailApiKey: 'local-test-key', emailFrom: 'demo@example.test',
    fetchEmail: async (url, options) => {
      outgoing = { url, ...JSON.parse(options.body) };
      return new Response('provider failure with private details', { status: 503 });
    },
  });
  const cookie = await login();
  assert.equal((await call('/api/workspace', { cookie })).body.emailConfigured, true);
  const message = await call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Her er en liten oppdatering!', sendEmail: true } });
  assert.equal(message.status, 201);
  assert.equal(message.body.message.emailStatus, 'failed');
  assert.equal(message.body.message.authorId, 'emil');
  assert.deepEqual(outgoing.to, ['employee@olbrygging.example']);
  assert.equal(outgoing.url, 'https://api.resend.com/emails');
  assert.equal(JSON.stringify(message.body).includes('private'), false);
  const saved = JSON.parse(readFileSync(dataFile, 'utf8')).tickets.find((item) => item.id === 'ticket-1001').messages.at(-1);
  assert.equal(saved.id, message.body.message.id);
  assert.equal(saved.emailStatus, 'failed');
  const noMail = await call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Bare i portalen.' } });
  assert.equal(noMail.body.message.emailStatus, 'not_requested');
  const other = await fixture(t, { emailApiKey: '', emailFrom: '' });
  const otherCookie = await other.login();
  const unavailable = await other.call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie: otherCookie, body: { body: 'Lagre likevel.', sendEmail: true } });
  assert.equal(unavailable.body.message.emailStatus, 'failed');
});

test('email success targets opposite participant, timeout preserves message', async (t) => {
  let recipient;
  const fixtureSent = await fixture(t, {
    emailApiKey: 'local-test-key', emailFrom: 'demo@example.test',
    fetchEmail: async (_url, options) => {
      recipient = JSON.parse(options.body).to;
      return new Response('{}', { status: 200 });
    },
  });
  const staff = await fixtureSent.login('employee@olbrygging.example');
  const sent = await fixtureSent.call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie: staff, body: { body: 'Takk for oppdateringen!', sendEmail: true } });
  assert.equal(sent.body.message.emailStatus, 'sent');
  assert.deepEqual(recipient, ['ambassador@olbrygging.example']);
  const fixtureTimeout = await fixture(t, {
    emailApiKey: 'local-test-key', emailFrom: 'demo@example.test', emailTimeoutMs: 10,
    fetchEmail: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
  });
  const cookie = await fixtureTimeout.login();
  const timedOut = await fixtureTimeout.call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Denne skal ikke forsvinne.', sendEmail: true } });
  assert.equal(timedOut.status, 201);
  assert.equal(timedOut.body.message.emailStatus, 'failed');
});

test('JSON, dates, lengths, enums, methods, body limits and same-origin validation', async (t) => {
  const { call, login } = await fixture(t);
  const cookie = await login();
  const base = { productId: 'malt', productUrl: 'https://www.olbrygging.no/produkt/demo', subject: 'Ny forespørsel', description: 'En liten beskrivelse.', channel: 'Instagram' };
  for (const change of [
    { subject: '' }, { subject: 'x'.repeat(161) }, { description: 'x'.repeat(5001) },
    { productId: 'missing' }, { channel: 'Facebook' }, { dueDate: '2026-02-30' },
    { dueDate: 'not-a-date' }, { dueDate: '2026-10-20T12:00:00Z' }, { status: 'approved' },
  ]) assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: { ...base, ...change } })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: { ...base, productUrl: undefined } })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, raw: '{' })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: [] })).status, 400);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: base, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: base, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: base, headers: { origin: '' } })).status, 403);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: base, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('/api/tickets', { method: 'POST', cookie, body: { ...base, description: 'x'.repeat(30000) } })).status, 413);
  assert.equal((await call('/api/unknown')).status, 404);
  assert.equal((await call('/api/session', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Hallo', sendEmail: 'yes' } })).status, 400);
  assert.equal((await call('/api/tickets/ticket-1001/messages', { method: 'POST', cookie, body: { body: 'Hallo', to: 'arbitrary@example.test' } })).status, 400);
  const staff = await login('employee@olbrygging.example');
  assert.equal((await call('/api/tickets/ticket-1001', { method: 'PATCH', cookie: staff, body: { status: 'invalid' } })).status, 400);
});

test('static files do not expose directories, workspace, symlinks or traversals', async (t) => {
  const { base, publicDir, dataFile } = await fixture(t);
  const root = await fetch(base);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.match(await root.text(), /Demo/);
  mkdirSync(resolve(publicDir, 'assets'));
  symlinkSync(dataFile, resolve(publicDir, 'secret.json'));
  for (const path of ['/assets', '/workspace.json', '/secret.json']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404);
    await response.text();
  }
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const path of ['/%ZZ', '/..%2fworkspace.json', '/%5cworkspace.json', '//evil.example', '/%00']) {
    const response = await new Promise((done, reject) => {
      const req = request(base, { path }, (res) => {
        res.resume();
        res.on('end', () => done(res));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.statusCode, 400);
  }
});

test('concurrent creation preserves all writes with unique ticket numbers', async (t) => {
  const { call, login, dataFile } = await fixture(t);
  const cookie = await login();
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => call('/api/tickets', {
    method: 'POST', cookie,
    body: { productId: 'malt', productUrl: 'https://www.olbrygging.no/produkt/demo', subject: `Forespørsel ${index}`, description: 'Test av samtidige forespørsler.', channel: 'Blogg' },
  })));
  assert.ok(responses.every((response) => response.status === 201));
  assert.equal(new Set(responses.map((response) => response.body.ticket.number)).size, 6);
  assert.equal(JSON.parse(readFileSync(dataFile, 'utf8')).tickets.length, 11);
});

test('profiles, articles, damage reports, and admin-only account management', async (t) => {
  const { call, login } = await fixture(t);
  const ambassador = await login();
  const employee = await login('employee@olbrygging.example');
  const admin = await login('admin@olbrygging.example');

  const workspace = (await call('/api/workspace', { cookie: ambassador })).body;
  assert.equal(workspace.articles.length, 2);
  assert.deepEqual(workspace.damageReports, []);
  assert.equal(workspace.users.some((item) => item.role === 'admin'), false);

  assert.equal((await call('/api/articles', { method: 'POST', cookie: ambassador, body: { title: 'Nei', body: 'Nei', category: 'Test' } })).status, 403);
  assert.equal((await call('/api/users', { cookie: employee })).status, 403);
  assert.equal((await call('/api/users', { method: 'POST', cookie: employee, body: { name: 'Test', email: 'test@example.test', password: 'long-test-password', role: 'employee' } })).status, 403);

  const article = await call('/api/articles', { method: 'POST', cookie: employee, body: { title: 'Ny bryggeguide', body: 'Oppbevar råvarene kjølig.', category: 'Bryggetips' } });
  assert.equal(article.status, 201);
  assert.equal(article.body.article.authorId, 'nora');
  assert.equal(article.body.article.updatedBy, 'nora');
  const editedArticle = await call(`/api/articles/${article.body.article.id}`, { method: 'PATCH', cookie: employee, body: { title: 'Oppdatert bryggeguide' } });
  assert.equal(editedArticle.body.article.title, 'Oppdatert bryggeguide');
  assert.equal(editedArticle.body.article.authorId, 'nora');

  const report = await call('/api/damage-reports', { method: 'POST', cookie: ambassador, body: { productId: 'fjord-pale', description: 'Esken var skadet ved levering.' } });
  assert.equal(report.status, 201);
  assert.equal((await call(`/api/damage-reports/${report.body.report.id}`, { method: 'PATCH', cookie: ambassador, body: { status: 'approved' } })).status, 403);
  const approved = await call(`/api/damage-reports/${report.body.report.id}`, { method: 'PATCH', cookie: employee, body: { status: 'approved', reviewNote: 'Erstattes.' } });
  assert.equal(approved.body.report.status, 'approved');
  assert.equal((await call('/api/workspace', { cookie: ambassador })).body.damageReports[0].reviewNote, 'Erstattes.');

  const created = await call('/api/users', { method: 'POST', cookie: admin, body: { name: 'Ny ambassadør', email: 'new@example.test', password: 'temporary-password', role: 'ambassador' } });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes('passwordHash'), false);
  const disabled = await call(`/api/users/${created.body.user.id}`, { method: 'PATCH', cookie: admin, body: { active: false } });
  assert.equal(disabled.body.user.active, false);
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'new@example.test', password: 'temporary-password' } })).status, 401);
  const profile = await call('/api/users/emil', { method: 'PATCH', cookie: employee, body: { socialMedia: '@emilbrygger' } });
  assert.equal(profile.body.user.socialMedia, '@emilbrygger');
});
