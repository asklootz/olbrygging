import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.env.POCKETBASE_BINARY || resolve(root, process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'));
const skip = !existsSync(binary) && 'Native PocketBase binary missing; install PocketBase 0.40.6 or set POCKETBASE_BINARY to run integration tests.';
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('PocketBase 0.40.6 migrations, authorization and transactional portal endpoints', { skip, timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(resolve(root, '.pb-integration-'));
  const flags = [
    `--dir=${directory}`, `--hooksDir=${resolve(root, 'pb_hooks')}`,
    `--migrationsDir=${resolve(root, 'pb_migrations')}`, '--automigrate=false',
  ];
  let processHandle;
  let logs = '';
  async function stop() {
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      const exited = once(processHandle, 'exit');
      processHandle.kill('SIGTERM');
      await exited;
    }
    processHandle = null;
  }
  t.after(async () => {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  });
  function cli(args, input, env = {}) {
    const result = spawnSync(binary, [...args, ...flags], { cwd: root, encoding: 'utf8', input, timeout: 30_000, env: { ...process.env, ...env } });
    assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}\n${result.error || ''}`);
    return result.stdout;
  }
  assert.match(cli(['--version']), /0\.40\.6/);
  cli(['migrate', 'up']);
  assert.match(cli(['migrate', 'up']), /No new migrations/);
  cli(['migrate', 'down', '1'], 'y\n');
  cli(['migrate', 'up']);
  const password = randomBytes(24).toString('hex');
  const adminEmail = 'integration-admin@example.invalid';
  cli(['superuser', 'create', adminEmail, password]);
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  const base = `http://127.0.0.1:${port}`;
  async function start() {
    logs = '';
    processHandle = spawn(binary, ['serve', ...flags, `--http=127.0.0.1:${port}`, '--hooksWatch=false'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    processHandle.stdout.on('data', (data) => { logs += data; });
    processHandle.stderr.on('data', (data) => { logs += data; });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (processHandle.exitCode !== null) assert.fail(`PocketBase exited during startup:\n${logs}`);
      try {
        if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch {}
      await delay(50);
    }
    assert.fail(`PocketBase did not start:\n${logs}`);
  }
  await start();

  async function request(path, { token, method = 'GET', body, raw, contentType = 'application/json' } = {}) {
    const response = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { ...(token ? { Authorization: token } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': contentType } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data };
  }
  async function expect(status, path, options) {
    const result = await request(path, options);
    assert.equal(result.status, status, `${options?.method || 'GET'} ${path}: ${JSON.stringify(result.data)}\n${logs.slice(-2500)}`);
    return result.data;
  }
  const admin = (await expect(200, '/api/collections/_superusers/auth-with-password', {
    method: 'POST', body: { identity: adminEmail, password },
  })).token;
  const users = {};
  const tokens = {};
  const draft = { productId: 'fjord-pale', subject: '  Bryggereise  ', description: '  En beskrivelse  ', channel: 'Instagram', dueDate: '2028-02-29' };
  let ticket;
  let otherTicket;
  let message;

  await t.test('fresh migrations seed eight fictional products and no portal accounts', async () => {
    const collection = await expect(200, '/api/collections/users/records', { token: admin });
    assert.equal(collection.totalItems, 0);
    const catalogue = await expect(200, '/api/collections/products/records', { token: admin });
    assert.equal(catalogue.totalItems, 8);
    assert.equal(new Set(catalogue.items.map((item) => item.slug)).size, 8);
    assert.ok(catalogue.items.every((item) => item.available && item.id !== item.slug));
    const schema = await expect(200, '/api/collections', { token: admin });
    for (const name of ['users', 'products', 'tickets', 'messages', 'portal_counters']) {
      const collection = schema.items.find((item) => item.name === name);
      for (const rule of ['createRule', 'updateRule', 'deleteRule']) assert.equal(collection[rule], null, `${name}.${rule} must be locked`);
    }
    for (const role of ['employee', 'ambassador', 'other']) {
      const actualRole = role === 'other' ? 'ambassador' : role;
      users[role] = await expect(200, '/api/collections/users/records', {
        token: admin, method: 'POST',
        body: { email: `${role}@example.invalid`, password, passwordConfirm: password, name: role, role: actualRole, emailVisibility: false },
      });
      tokens[role] = (await expect(200, '/api/collections/users/auth-with-password', {
        method: 'POST', body: { identity: `${role}@example.invalid`, password },
      })).token;
    }
  });

  await t.test('authentication is required and signup, role spoofing and direct writes are locked', async () => {
    await expect(401, '/api/portal/workspace');
    await expect(401, '/api/portal/workspace', { token: 'invalid' });
    await expect(403, '/api/portal/workspace', { token: admin });
    await expect(401, '/api/portal/tickets', { method: 'POST', body: draft });
    await expect(403, '/api/collections/users/records', {
      method: 'POST', body: { email: 'spoof@example.invalid', password, passwordConfirm: password, name: 'spoof', role: 'employee' },
    });
    for (const token of [tokens.ambassador, tokens.employee]) {
      await expect(403, '/api/collections/users/records', { token });
      await expect(403, `/api/collections/users/records/${users.ambassador.id}`, { token });
      await expect(403, `/api/collections/users/records/${users.ambassador.id}`, {
        token, method: 'PATCH', body: { role: 'employee', raw_user_meta_data: { role: 'employee' } },
      });
      await expect(403, `/api/collections/users/records/${users.ambassador.id}`, { token, method: 'DELETE' });
      for (const collection of ['products', 'tickets', 'messages', 'portal_counters', 'articles', 'damage_reports']) {
        await expect(403, `/api/collections/${collection}/records`, { token, method: 'POST', body: {} });
      }
    }
    const refreshed = await expect(200, '/api/collections/users/auth-refresh', { token: tokens.ambassador, method: 'POST' });
    assert.equal(refreshed.record.role, 'ambassador');
    assert.equal(refreshed.record.id, users.ambassador.id);
    assert.ok(!JSON.stringify(refreshed.record).includes('tokenKey'));
    const spoofed = await expect(200, '/api/collections/users/auth-with-password', {
      method: 'POST', body: {
        identity: 'ambassador@example.invalid', password, role: 'employee',
        metadata: { role: 'employee' }, raw_user_meta_data: { role: 'employee' },
      },
    });
    assert.equal(spoofed.record.role, 'ambassador');
    assert.equal((await expect(200, '/api/portal/workspace', { token: spoofed.token })).user.role, 'ambassador');
  });

  await t.test('workspace projects only safe relevant users with email, and catalogue slug ids', async () => {
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    assert.deepEqual(workspace.user, {
      id: users.ambassador.id, name: 'ambassador', email: 'ambassador@example.invalid',
      role: 'ambassador', active: true, socialMedia: '',
    });
    assert.deepEqual(workspace.tickets, []);
    assert.deepEqual(workspace.articles, []);
    assert.deepEqual(workspace.damageReports, []);
    assert.equal(workspace.products.length, 8);
    assert.ok(workspace.products.some((item) => item.id === 'fjord-pale' && item.price === 449));
    assert.deepEqual(new Set(workspace.users.map((user) => user.id)), new Set([users.ambassador.id, users.employee.id]));
    for (const user of workspace.users) {
      assert.deepEqual(Object.keys(user).sort(), ['active', 'email', 'id', 'name', 'role', 'socialMedia']);
    }
    const employeeWorkspace = await expect(200, '/api/portal/workspace', { token: tokens.employee });
    assert.equal(employeeWorkspace.users.length, 3);
    const products = await expect(200, '/api/collections/products/records', { token: tokens.ambassador });
    assert.equal(products.totalItems, 8);
    const publicProducts = await expect(200, '/api/collections/products/records');
    assert.equal(publicProducts.totalItems, 0);
  });

  await t.test('create validates types, limits, dates, unknown fields and ownership without consuming numbers', async () => {
    for (const changes of [
      { subject: ' ' }, { subject: 123 }, { subject: 'x'.repeat(161) }, { description: 'x'.repeat(5001) },
      { productId: ['fjord-pale'] }, { productId: 'does-not-exist' }, { channel: 'invalid' },
      { dueDate: '2027-02-29' }, { dueDate: '2028-04-31' }, { dueDate: '0000-01-01' },
      { dueDate: 123 }, { dueDate: '2028-2-29' }, { status: 'approved' }, { number: 12 },
      { role: 'employee' }, { authorId: users.employee.id },
    ]) await expect(400, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', body: { ...draft, ...changes } });
    for (const raw of ['null', '[]', '"text"', '{']) {
      await expect(400, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', raw });
    }
    await expect(415, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', body: draft, contentType: 'text/plain' });
    await expect(413, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', body: { ...draft, description: 'x'.repeat(25 * 1024) } });
    await expect(403, '/api/portal/tickets', {
      token: tokens.ambassador, method: 'POST', body: { ...draft, ambassadorId: users.other.id },
    });
    await expect(400, '/api/portal/tickets', { token: tokens.employee, method: 'POST', body: draft });
    await expect(400, '/api/portal/tickets', {
      token: tokens.employee, method: 'POST', body: { ...draft, ambassadorId: users.employee.id },
    });
    const product = (await expect(200, '/api/collections/products/records?filter=slug%3D%27fjord-pale%27', { token: admin })).items[0];
    await expect(200, `/api/collections/products/records/${product.id}`, { token: admin, method: 'PATCH', body: { available: false } });
    await expect(400, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', body: draft });
    await expect(200, `/api/collections/products/records/${product.id}`, { token: admin, method: 'PATCH', body: { available: true } });
    ticket = (await expect(201, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', body: draft })).ticket;
    assert.equal(ticket.number, 1001);
    assert.equal(ticket.displayNumber, '1001-1');
    assert.equal(ticket.promotionCount, 1);
    assert.equal(ticket.subject, 'Bryggereise');
    assert.equal(ticket.description, 'En beskrivelse');
    assert.equal(ticket.status, 'requested');
    assert.equal(ticket.productId, 'fjord-pale');
    assert.equal(ticket.ambassadorId, users.ambassador.id);
    assert.equal(ticket.assigneeId, users.employee.id);
    assert.equal(ticket.dueDate, '2028-02-29');
    assert.ok(Number.isFinite(Date.parse(ticket.createdAt)));
    assert.ok(Date.parse(ticket.updatedAt) >= Date.parse(ticket.createdAt));
    assert.match(ticket.createdAt, isoTimestamp);
    assert.match(ticket.updatedAt, isoTimestamp);
    assert.deepEqual(ticket.messages, []);
    otherTicket = (await expect(201, '/api/portal/tickets', {
      token: tokens.employee, method: 'POST', body: { ...draft, ambassadorId: users.other.id, dueDate: null },
    })).ticket;
    assert.equal(otherTicket.number, 1002);
    assert.equal(otherTicket.dueDate, null);
  });

  await t.test('employees publish unassigned URL tasks with two deadlines; ambassadors claim exactly once', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const later = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const input = {
      productUrl: 'https://www.olbrygging.no/produkt/seasonal',
      subject: 'En ny måte å brygge på', description: 'Vis fram produktet og fortell din egen historie.',
      acceptBy: later(5), dueDate: later(12),
      productSnapshot: {
        url: 'https://www.olbrygging.no/produkt/seasonal', name: 'Sesongprodukt',
        description: 'Produktinfo fra URL', price: 789, currency: 'NOK', image: 'https://cdn.example/seasonal.jpg',
      },
    };
    await expect(403, '/api/portal/tasks', { token: tokens.ambassador, method: 'POST', body: input });
    for (const changes of [{ acceptBy: later(-1) }, { dueDate: later(2) }, { channel: 'Instagram' }, { ambassadorId: users.ambassador.id }, { productId: 'fjord-pale' }]) {
      await expect(400, '/api/portal/tasks', { token: tokens.employee, method: 'POST', body: { ...input, ...changes } });
    }
    const created = (await expect(201, '/api/portal/tasks', { token: tokens.employee, method: 'POST', body: input })).ticket;
    assert.equal(created.productId, null);
    assert.equal(created.productUrl, input.productUrl);
    assert.deepEqual(created.productSnapshot, input.productSnapshot);
    assert.equal(created.subject, input.subject);
    assert.equal(created.description, input.description);
    assert.equal(created.status, 'available');
    assert.equal(created.ambassadorId, '');
    assert.equal(created.channel, '');
    assert.equal(created.acceptBy, input.acceptBy);
    assert.equal(created.dueDate, input.dueDate);
    const openWorkspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    assert.ok(openWorkspace.tickets.some((ticket) => ticket.id === created.id));
    await expect(403, `/api/portal/tickets/${created.id}/accept`, { token: tokens.employee, method: 'POST', body: {} });
    const accepted = (await expect(200, `/api/portal/tickets/${created.id}/accept`, { token: tokens.ambassador, method: 'POST', body: {} })).ticket;
    assert.equal(accepted.ambassadorId, users.ambassador.id);
    assert.equal(accepted.status, 'approved');
    await expect(409, `/api/portal/tickets/${created.id}/accept`, { token: tokens.other, method: 'POST', body: {} });
    const otherWorkspace = await expect(200, '/api/portal/workspace', { token: tokens.other });
    assert.ok(!otherWorkspace.tickets.some((ticket) => ticket.id === created.id));
    const selectedChannel = (await expect(200, `/api/portal/tickets/${created.id}`, {
      token: tokens.ambassador, method: 'PATCH', body: { channel: 'Instagram' },
    })).ticket;
    assert.equal(selectedChannel.channel, 'Instagram');
    const message = (await expect(201, `/api/portal/tickets/${created.id}/messages`, {
      token: tokens.ambassador, method: 'POST', body: { body: 'Jeg tar gjerne denne oppgaven.' },
    })).message;
    assert.equal(message.authorId, users.ambassador.id);
    assert.equal(Date.parse(created.acceptBy) < Date.parse(created.dueDate), true);
    assert.ok(Date.parse(created.acceptBy) >= Date.parse(today));
    await expect(204, `/api/collections/tickets/records/${created.id}`, { token: admin, method: 'DELETE' });
  });

  await t.test('profiles, articles and damage reports use authenticated transactional routes', async () => {
    for (const token of [tokens.ambassador, tokens.employee]) {
      for (const collection of ['articles', 'damage_reports']) {
        await expect(403, `/api/collections/${collection}/records`, { token });
        await expect(403, `/api/collections/${collection}/records`, { token, method: 'POST', body: {} });
      }
    }
    const self = await expect(200, '/api/portal/profile', {
      token: tokens.ambassador, method: 'PATCH', body: { socialMedia: '@bryggeren' },
    });
    assert.equal(self.user.socialMedia, '@bryggeren');
    assert.equal((await expect(200, '/api/portal/workspace', { token: tokens.ambassador })).user.socialMedia, '@bryggeren');
    await expect(400, '/api/portal/profile', { token: tokens.ambassador, method: 'PATCH', body: { role: 'employee' } });

    const profile = await expect(200, `/api/portal/users/${users.ambassador.id}`, {
      token: tokens.employee, method: 'PATCH', body: { socialMedia: '@oppdatert' },
    });
    assert.equal(profile.user.socialMedia, '@oppdatert');
    await expect(403, `/api/portal/users/${users.other.id}`, {
      token: tokens.ambassador, method: 'PATCH', body: { name: 'Ikke tillatt' },
    });

    await expect(403, '/api/portal/articles', {
      token: tokens.ambassador, method: 'POST', body: { title: 'Nei', body: 'Nei', category: 'Test' },
    });
    const article = await expect(201, '/api/portal/articles', {
      token: tokens.employee, method: 'POST',
      body: { title: 'Bryggeguide', body: 'Oppbevar råvarene tørt.', category: 'Bryggetips' },
    });
    assert.equal(article.article.authorId, users.employee.id);
    assert.match(article.article.createdAt, isoTimestamp);
    assert.equal((await expect(200, '/api/portal/articles', { token: tokens.ambassador })).articles.length, 1);
    const updatedArticle = await expect(200, `/api/portal/articles/${article.article.id}`, {
      token: tokens.employee, method: 'PATCH', body: { title: 'Oppdatert guide' },
    });
    assert.equal(updatedArticle.article.title, 'Oppdatert guide');

    const report = await expect(201, '/api/portal/damage-reports', {
      token: tokens.ambassador, method: 'POST',
      body: { productId: 'fjord-pale', ticketId: ticket.id, description: 'Esken var skadet.' },
    });
    assert.equal(report.report.ambassadorId, users.ambassador.id);
    assert.equal(report.report.productId, 'fjord-pale');
    assert.equal(report.report.ticketId, ticket.id);
    await expect(403, `/api/portal/damage-reports/${report.report.id}`, {
      token: tokens.ambassador, method: 'PATCH', body: { status: 'approved' },
    });
    const reviewed = await expect(200, `/api/portal/damage-reports/${report.report.id}`, {
      token: tokens.employee, method: 'PATCH', body: { status: 'approved', reviewNote: 'Erstattes.' },
    });
    assert.equal(reviewed.report.reviewNote, 'Erstattes.');
    assert.equal((await expect(200, '/api/portal/workspace', { token: tokens.ambassador })).damageReports.length, 1);
    assert.deepEqual((await expect(200, '/api/portal/workspace', { token: tokens.other })).damageReports, []);
  });

  await t.test('owners and employees read tickets; unrelated accounts cannot read, update or message them', async () => {
    for (const token of [tokens.ambassador, tokens.employee]) {
      await expect(200, `/api/collections/tickets/records/${ticket.id}`, { token });
    }
    await expect(404, `/api/collections/tickets/records/${ticket.id}`, { token: tokens.other });
    const list = await expect(200, '/api/collections/tickets/records', { token: tokens.ambassador });
    assert.deepEqual(list.items.map((item) => item.id), [ticket.id]);
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    assert.deepEqual(workspace.tickets.map((item) => item.id), [ticket.id]);
    assert.ok(!workspace.users.some((user) => user.id === users.other.id));
    const employeeWorkspace = await expect(200, '/api/portal/workspace', { token: tokens.employee });
    assert.equal(employeeWorkspace.tickets.length, 2);
    for (const collection of ['tickets', 'messages']) {
      assert.equal((await expect(200, `/api/collections/${collection}/records`)).totalItems, 0);
    }
    for (const id of [otherTicket.id, 'doesnotexist123']) {
      await expect(404, `/api/portal/tickets/${id}`, { token: tokens.ambassador, method: 'PATCH', body: { status: 'in_progress' } });
      await expect(404, `/api/portal/tickets/${id}/messages`, { token: tokens.ambassador, method: 'POST', body: { body: 'No' } });
    }
    for (const token of [tokens.employee, tokens.ambassador]) {
      await expect(403, `/api/collections/tickets/records/${ticket.id}`, { token, method: 'PATCH', body: { status: 'completed' } });
      await expect(403, `/api/collections/tickets/records/${ticket.id}`, { token, method: 'DELETE' });
    }
  });

  await t.test('workflow routes content review through submissions and prevents unqualified closure', async () => {
    const path = `/api/portal/tickets/${ticket.id}`;
    await expect(403, path, { token: tokens.ambassador, method: 'PATCH', body: { status: 'in_progress' } });
    for (const body of [
      {}, { status: 'invalid' }, { status: 1 }, { assigneeId: users.ambassador.id },
      { assigneeId: null }, { dueDate: '2027-02-29' }, { subject: 'changed' },
    ]) await expect(400, path, { token: tokens.employee, method: 'PATCH', body });
    await expect(400, path, { token: tokens.employee, method: 'PATCH', body: { status: 'approved', dueDate: 'invalid' } });
    assert.equal((await expect(200, `/api/collections/tickets/records/${ticket.id}`, { token: tokens.employee })).status, 'requested');
    await expect(200, path, { token: tokens.employee, method: 'PATCH', body: { status: 'approved', dueDate: '' } });
    for (const body of [{ status: 'completed' }, { dueDate: null }, { assigneeId: users.employee.id }, { status: 'in_progress', dueDate: null }]) {
      await expect(403, path, { token: tokens.ambassador, method: 'PATCH', body });
    }
    assert.equal((await expect(200, path, { token: tokens.ambassador, method: 'PATCH', body: { status: 'in_progress' } })).ticket.status, 'in_progress');
    await expect(403, path, { token: tokens.ambassador, method: 'PATCH', body: { status: 'review' } });
    await expect(403, path, { token: tokens.ambassador, method: 'PATCH', body: { status: 'completed' } });
    await expect(400, path, { token: tokens.employee, method: 'PATCH', body: { status: 'review' } });
    await expect(400, path, { token: tokens.employee, method: 'PATCH', body: { status: 'completed' } });
    for (const status of ['declined', 'requested', 'approved', 'in_progress']) {
      assert.equal((await expect(200, path, { token: tokens.employee, method: 'PATCH', body: { status } })).ticket.status, status);
    }
  });

  await t.test('content submissions preserve versions, authorize files, audit review, and require publication before completion', async () => {
    const path = `/api/portal/tickets/${ticket.id}/submissions`;
    const png = readFileSync(resolve(root, 'public/icons/icon-192.png'));
    const mp4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 109, 112, 52, 49, 0, 0, 0, 0]);
    const invalidFile = new FormData();
    invalidFile.append('files', new Blob([png], { type: 'image/png' }), 'unsafe.html');
    assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: tokens.ambassador }, body: invalidFile })).status, 400);
    const spoofedFile = new FormData();
    spoofedFile.append('files', new Blob(['not a PNG'], { type: 'image/png' }), 'fake.png');
    const spoofedResponse = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: tokens.ambassador }, body: spoofedFile });
    assert.ok([400, 422].includes(spoofedResponse.status), `Spoofed media returned ${spoofedResponse.status}`);
    const mismatchedFile = new FormData();
    mismatchedFile.append('files', new Blob([png], { type: 'image/png' }), 'image.mp4');
    assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: tokens.ambassador }, body: mismatchedFile })).status, 400);
    const wrongOwner = new FormData();
    wrongOwner.append('files', new Blob([png], { type: 'image/png' }), 'draft.png');
    assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: tokens.other }, body: wrongOwner })).status, 404);
    const upload = async (caption) => {
      const form = new FormData();
      form.append('caption', caption);
      form.append('link', 'https://example.invalid/draft');
      form.append('files', new Blob([png], { type: 'image/png' }), 'draft.png');
      form.append('files', new Blob([mp4], { type: 'video/mp4' }), 'clip.mp4');
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: tokens.ambassador }, body: form });
      const data = await response.json();
      assert.equal(response.status, 201, `${JSON.stringify(data)}\n${logs.slice(-2500)}`);
      return data.submission;
    };
    const first = await upload('Første versjon');
    assert.equal(first.version, 1);
    assert.equal(first.status, 'submitted');
    assert.deepEqual(first.files.map((file) => file.type), ['image/png', 'video/mp4']);
    await expect(409, `/api/portal/tickets/${ticket.id}`, { token: tokens.employee, method: 'PATCH', body: { status: 'in_progress' } });
    await expect(403, `/api/portal/submissions/${first.id}/decision`, { token: tokens.ambassador, method: 'POST', body: { decision: 'approved' } });
    await expect(403, `/api/collections/content_submissions/records/${first.id}`, { token: tokens.other, method: 'PATCH', body: { status: 'approved' } });
    await expect(403, '/api/collections/content_submissions/records', { token: tokens.ambassador, method: 'POST', body: {} });
    await expect(404, `/api/collections/content_submissions/records/${first.id}`, { token: tokens.other });
    const filePath = `/api/files/content_submissions/${first.id}/${encodeURIComponent(first.files[0].name)}`;
    assert.ok([401, 403, 404].includes((await fetch(`${base}${filePath}`)).status));
    const otherFileToken = (await expect(200, '/api/files/token', { token: tokens.other, method: 'POST', body: {} })).token;
    assert.ok([403, 404].includes((await fetch(`${base}${filePath}?token=${encodeURIComponent(otherFileToken)}`)).status));
    const ownerFileToken = (await expect(200, '/api/files/token', { token: tokens.ambassador, method: 'POST', body: {} })).token;
    const ownerFile = await fetch(`${base}${filePath}?token=${encodeURIComponent(ownerFileToken)}`);
    assert.equal(ownerFile.status, 200);
    assert.deepEqual(Buffer.from(await ownerFile.arrayBuffer()), png);
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.employee });
    const projected = workspace.tickets.find((item) => item.id === ticket.id).submissions[0];
    assert.equal(projected.id, first.id);
    assert.equal(JSON.stringify(projected).includes('storageKey'), false);
    await expect(400, `/api/portal/submissions/${first.id}/decision`, { token: tokens.employee, method: 'POST', body: { decision: 'changes_requested' } });
    const returned = await expect(200, `/api/portal/submissions/${first.id}/decision`, {
      token: tokens.employee, method: 'POST', body: { decision: 'changes_requested', feedback: 'Juster produktmerkingen.' },
    });
    assert.equal(returned.submission.reviewerId, users.employee.id);
    assert.equal(returned.submission.status, 'changes_requested');
    await expect(409, `/api/portal/submissions/${first.id}/decision`, { token: tokens.employee, method: 'POST', body: { decision: 'approved' } });
    const second = await upload('Revidert versjon');
    assert.equal(second.version, 2);
    const decisions = await Promise.all([
      request(`/api/portal/submissions/${second.id}/decision`, { token: tokens.employee, method: 'POST', body: { decision: 'approved' } }),
      request(`/api/portal/submissions/${second.id}/decision`, { token: tokens.employee, method: 'POST', body: { decision: 'changes_requested', feedback: 'Endre bildet.' } }),
    ]);
    assert.deepEqual(decisions.map((item) => item.status).sort(), [200, 409]);
    const winner = decisions.find((item) => item.status === 200).data.submission;
    if (winner.status === 'changes_requested') {
      const third = await upload('Siste versjon');
      assert.equal(third.version, 3);
      await expect(200, `/api/portal/submissions/${third.id}/decision`, { token: tokens.employee, method: 'POST', body: { decision: 'approved' } });
    }
    await expect(400, `/api/portal/tickets/${ticket.id}/publication`, { token: tokens.ambassador, method: 'PATCH', body: { url: 'http://example.invalid/post' } });
    await expect(200, `/api/portal/tickets/${ticket.id}/publication`, { token: tokens.ambassador, method: 'PATCH', body: { url: 'https://example.invalid/post' } });
    assert.equal((await expect(200, `/api/portal/tickets/${ticket.id}`, { token: tokens.employee, method: 'PATCH', body: { status: 'completed' } })).ticket.status, 'completed');
  });

  await t.test('messages persist before email; actor, timestamps and delivery status cannot be forged', async () => {
    const path = `/api/portal/tickets/${ticket.id}/messages`;
    for (const body of [
      { body: '' }, { body: false }, { body: 'x'.repeat(5001) }, { body: 'Hi', sendEmail: 'true' },
      { body: 'Hi', authorId: users.employee.id }, { body: 'Hi', emailStatus: 'sent' },
      { body: 'Hi', createdAt: '2020-01-01' }, { body: 'Hi', role: 'employee' },
    ]) await expect(400, path, { token: tokens.ambassador, method: 'POST', body });
    message = (await expect(201, path, { token: tokens.ambassador, method: 'POST', body: { body: '  Lagret først  ', sendEmail: true } })).message;
    assert.equal(message.body, 'Lagret først');
    assert.equal(message.authorId, users.ambassador.id);
    assert.equal(message.emailStatus, 'failed');
    assert.ok(Number.isFinite(Date.parse(message.createdAt)));
    assert.ok(Date.parse(message.updatedAt) >= Date.parse(message.createdAt));
    assert.match(message.createdAt, isoTimestamp);
    assert.match(message.updatedAt, isoTimestamp);
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.employee });
    const saved = workspace.tickets.find((item) => item.id === ticket.id);
    assert.deepEqual(saved.messages, [message]);
    assert.ok(Date.parse(saved.updatedAt) >= Date.parse(message.createdAt));
    assert.equal(workspace.users.find((user) => user.id === message.authorId).role, 'ambassador');
    const reply = (await expect(201, path, { token: tokens.employee, method: 'POST', body: { body: 'Et svar' } })).message;
    assert.equal(reply.authorId, users.employee.id);
    assert.equal(reply.emailStatus, 'not_requested');
    for (const token of [tokens.ambassador, tokens.employee]) {
      await expect(200, `/api/collections/messages/records/${message.id}`, { token });
      await expect(403, `/api/collections/messages/records/${message.id}`, { token, method: 'PATCH', body: { emailStatus: 'sent', authorId: users.employee.id } });
      await expect(403, `/api/collections/messages/records/${message.id}`, { token, method: 'DELETE' });
      await expect(403, `/api/portal/messages/${message.id}/email-result`, { token, method: 'POST', body: { deliveryStatus: 'sent' } });
    }
    await expect(404, `/api/collections/messages/records/${message.id}`, { token: tokens.other });
    assert.equal((await expect(200, '/api/collections/messages/records', { token: tokens.other })).totalItems, 0);
    const deliveryPath = `/api/portal/messages/${message.id}/email-result`;
    await expect(401, deliveryPath, { method: 'POST', body: { deliveryStatus: 'sent' } });
    await expect(400, deliveryPath, { token: admin, method: 'POST', body: { deliveryStatus: 'pending' } });
    await expect(400, deliveryPath, { token: admin, method: 'POST', body: { deliveryStatus: 'sent', authorId: users.employee.id } });
    await expect(400, `/api/portal/messages/${reply.id}/email-result`, { token: admin, method: 'POST', body: { deliveryStatus: 'sent' } });
    assert.deepEqual(await expect(200, deliveryPath, { token: admin, method: 'POST', body: { deliveryStatus: 'sent' } }), {});
    assert.equal((await expect(200, `/api/collections/messages/records/${message.id}`, { token: admin })).emailStatus, 'sent');
    await expect(200, `/api/collections/users/records/${users.other.id}`, { token: admin, method: 'PATCH', body: { role: 'employee' } });
    const assigned = (await expect(200, `/api/portal/tickets/${ticket.id}`, {
      token: tokens.employee, method: 'PATCH', body: { assigneeId: users.other.id, dueDate: '2028-03-01' },
    })).ticket;
    assert.equal(assigned.assigneeId, users.other.id);
    assert.equal(assigned.dueDate, '2028-03-01');
    await expect(201, path, { token: tokens.other, method: 'POST', body: { body: 'Et svar fra tidligere medarbeider' } });
    await expect(200, `/api/portal/tickets/${ticket.id}`, { token: tokens.employee, method: 'PATCH', body: { assigneeId: users.employee.id } });
    await expect(200, `/api/collections/users/records/${users.other.id}`, { token: admin, method: 'PATCH', body: { role: 'ambassador' } });
    const ownerWorkspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    assert.equal(ownerWorkspace.users.find((user) => user.id === users.other.id).email, 'other@example.invalid');
    await expect(404, `/api/collections/tickets/records/${ticket.id}`, { token: tokens.other });
    await expect(404, path, { token: tokens.other, method: 'POST', body: { body: 'Cannot continue after demotion' } });
  });

  await t.test('concurrent creates allocate unique gapless sequential numbers and messages are never lost', async () => {
    const count = 12;
    const created = await Promise.all(Array.from({ length: count }, (_, i) => expect(201, '/api/portal/tickets', {
      token: tokens.ambassador, method: 'POST', body: { ...draft, subject: `Concurrent ${i}`, dueDate: undefined },
    })));
    assert.deepEqual(created.map((item) => item.ticket.number).sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1004));
    assert.equal(new Set(created.map((item) => item.ticket.id)).size, count);
    assert.ok(created.every((item) => item.ticket.dueDate === null));
    await Promise.all(Array.from({ length: count }, (_, i) => expect(201, `/api/portal/tickets/${ticket.id}/messages`, {
      token: tokens.ambassador, method: 'POST', body: { body: `Concurrent message ${i}` },
    })));
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    assert.equal(workspace.tickets.find((item) => item.id === ticket.id).messages.length, count + 3);
  });

  await t.test('Node createApp authenticates and runs the full ticket/email workflow against native PocketBase', async () => {
    const { createApp } = await import('../server.mjs');
    const dataFile = resolve(directory, 'must-not-create-demo-data.json');
    const deliveries = [];
    let nodeTicket;
    const app = createApp({
      pocketbaseUrl: base, secureCookies: false, dataFile,
      pocketbaseAdminEmail: adminEmail, pocketbaseAdminPassword: password,
      emailApiKey: randomBytes(24).toString('hex'), emailFrom: 'portal@example.invalid',
      fetchProductPage: async () => new Response('<html><head><title>Fetched product</title></head></html>', {
        headers: { 'content-type': 'text/html' },
      }),
      fetchEmail: async (url, options) => {
        assert.equal(url, 'https://api.resend.com/emails');
        const delivery = JSON.parse(options.body);
        const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
        const durable = workspace.tickets.find((item) => item.id === nodeTicket.id).messages.at(-1);
        assert.equal(durable.emailStatus, 'failed', 'Message must be committed before contacting the email provider');
        assert.ok(delivery.text.includes(durable.body));
        deliveries.push(delivery);
        return new Response('{}', { status: 200 });
      },
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const nodeBase = `http://127.0.0.1:${app.address().port}`;
    const cookies = {};
    async function portal(path, { method = 'GET', body, form, role = 'ambassador', status = 200, origin = nodeBase } = {}) {
      const response = await fetch(`${nodeBase}/api${path}`, {
        method, signal: AbortSignal.timeout(15_000),
        headers: {
          ...(cookies[role] ? { cookie: cookies[role] } : {}),
          ...(method === 'GET' ? {} : { Origin: origin, ...(form ? {} : { 'Content-Type': 'application/json' }) }),
        },
        ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, status, `Node ${method} ${path}: ${JSON.stringify(data)}`);
      if (path !== '/login' && path !== '/logout') assert.deepEqual(response.headers.getSetCookie(), []);
      const cookie = response.headers.getSetCookie().find((item) => item.startsWith('olbrygging_pb_auth='));
      if (cookie) cookies[role] = cookie.split(';')[0];
      return data;
    }
    try {
      assert.deepEqual(await portal('/config'), { demoMode: false });
      await portal('/workspace', { status: 401 });
      for (const role of ['ambassador', 'employee']) {
        const login = await portal('/login', {
          role, method: 'POST', body: { email: `${role}@example.invalid`, password },
        });
        assert.equal(login.user.id, users[role].id);
        assert.match(cookies[role], /^olbrygging_pb_auth=[A-Za-z0-9_.-]+$/);
        assert.deepEqual(Object.keys(login.user).sort(), ['email', 'id', 'name', 'role']);
        assert.deepEqual((await portal('/session', { role })).user, login.user);
      }
      const workspace = await portal('/workspace');
      assert.equal(workspace.emailConfigured, true);
      assert.equal(workspace.user.email, 'ambassador@example.invalid');
      assert.ok(workspace.products.some((product) => product.id === 'fjord-pale'));
      const preview = await portal('/products/preview', {
        method: 'POST', body: { url: 'https://www.olbrygging.no/produkt/test' },
      });
      assert.equal(preview.product.name, 'Fetched product');
      await portal('/tickets', { method: 'POST', body: draft, origin: 'https://unrelated.example.invalid', status: 403 });
      nodeTicket = (await portal('/tickets', {
        method: 'POST', body: { ...draft, productUrl: 'https://www.olbrygging.no/produkt/test' }, status: 201,
      })).ticket;
      assert.match(nodeTicket.id, /^[a-z0-9]{15}$/);
      assert.equal(nodeTicket.productId, 'fjord-pale');
      assert.equal(nodeTicket.productSnapshot.name, 'Fetched product');
      assert.equal(nodeTicket.productUrl, 'https://www.olbrygging.no/produkt/test');
      assert.equal(nodeTicket.number, 1016);
      const updated = (await portal(`/tickets/${nodeTicket.id}`, {
        role: 'employee', method: 'PATCH', body: { status: 'approved', assigneeId: users.employee.id, dueDate: null },
      })).ticket;
      assert.equal(updated.status, 'approved');
      assert.equal(updated.dueDate, null);
      assert.equal((await portal(`/tickets/${nodeTicket.id}`, { method: 'PATCH', body: { status: 'in_progress' } })).ticket.status, 'in_progress');
      await portal(`/tickets/${nodeTicket.id}`, { method: 'PATCH', body: { status: 'review' }, status: 403 });
      const sent = (await portal(`/tickets/${nodeTicket.id}/messages`, {
        method: 'POST', body: { body: '  Native end-to-end message  ', sendEmail: true }, status: 201,
      })).message;
      assert.match(sent.id, /^[a-z0-9]{15}$/);
      assert.equal(sent.authorId, users.ambassador.id);
      assert.equal(sent.body, 'Native end-to-end message');
      assert.equal(sent.emailStatus, 'sent');
      assert.ok(Number.isFinite(Date.parse(sent.createdAt)));
      assert.ok(Number.isFinite(Date.parse(sent.updatedAt)));
      assert.match(sent.createdAt, isoTimestamp);
      assert.match(sent.updatedAt, isoTimestamp);
      assert.deepEqual(deliveries[0].to, ['employee@example.invalid']);
      const reply = (await portal(`/tickets/${nodeTicket.id}/messages`, {
        role: 'employee', method: 'POST', body: { body: 'Native employee reply', sendEmail: true }, status: 201,
      })).message;
      assert.equal(reply.authorId, users.employee.id);
      assert.equal(reply.emailStatus, 'sent');
      assert.deepEqual(deliveries[1].to, ['ambassador@example.invalid']);
      const png = readFileSync(resolve(root, 'public/icons/icon-192.png'));
      const mp4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 109, 112, 52, 49, 0, 0, 0, 0]);
      const upload = async (caption) => {
        const form = new FormData();
        form.append('caption', caption);
        form.append('link', 'https://example.invalid/draft');
        form.append('files', new Blob([png], { type: 'image/png' }), 'node-draft.png');
        form.append('files', new Blob([mp4], { type: 'video/mp4' }), 'node-clip.mp4');
        return portal(`/tickets/${nodeTicket.id}/submissions`, { method: 'POST', form, status: 201 });
      };
      const first = (await upload('Node submission version one')).submission;
      assert.equal(first.version, 1);
      assert.equal(first.status, 'submitted');
      assert.deepEqual(first.files.map((file) => file.type), ['image/png', 'video/mp4']);
      await portal(`/submissions/${first.id}/decision`, { role: 'employee', method: 'POST', body: { decision: 'changes_requested', feedback: 'Legg til mer kontekst.' } });
      const second = (await upload('Node submission version two')).submission;
      assert.equal(second.version, 2);
      await portal(`/submissions/${first.id}/decision`, { role: 'employee', method: 'POST', body: { decision: 'approved' }, status: 409 });
      await portal(`/submissions/${second.id}/decision`, { role: 'employee', method: 'POST', body: { decision: 'approved' } });
      await portal(`/tickets/${nodeTicket.id}`, { role: 'employee', method: 'PATCH', body: { status: 'completed' }, status: 400 });
      await portal(`/tickets/${nodeTicket.id}/publication`, { method: 'PATCH', body: { url: 'https://example.invalid/published-post' } });
      await portal(`/tickets/${nodeTicket.id}`, { role: 'employee', method: 'PATCH', body: { status: 'completed' } });
      const mediaResponse = await fetch(`${nodeBase}/api/submissions/${first.id}/files/${encodeURIComponent(first.files[0].name)}`, {
        headers: { cookie: cookies.ambassador },
      });
      assert.equal(mediaResponse.status, 200);
      assert.match(mediaResponse.headers.get('content-type'), /image\/png/);
      assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), png);
      const videoResponse = await fetch(`${nodeBase}/api/submissions/${first.id}/files/${encodeURIComponent(first.files[1].name)}`, {
        headers: { cookie: cookies.ambassador },
      });
      assert.equal(videoResponse.status, 200);
      assert.equal(videoResponse.headers.get('content-type'), 'video/mp4');
      assert.deepEqual(Buffer.from(await videoResponse.arrayBuffer()), mp4);
      const videoRange = await fetch(`${nodeBase}/api/submissions/${first.id}/files/${encodeURIComponent(first.files[1].name)}`, {
        headers: { cookie: cookies.ambassador, range: 'bytes=4-7' },
      });
      assert.equal(videoRange.status, 206);
      assert.equal(videoRange.headers.get('content-range'), 'bytes 4-7/16');
      assert.equal(Buffer.from(await videoRange.arrayBuffer()).toString(), 'ftyp');
      const fileUrl = `${nodeBase}/api/submissions/${first.id}/files/${encodeURIComponent(first.files[0].name)}`;
      assert.equal((await fetch(fileUrl)).status, 401);
      await portal('/login', { role: 'other', method: 'POST', body: { email: 'other@example.invalid', password } });
      assert.equal((await fetch(fileUrl, { headers: { cookie: cookies.other } })).status, 404);
      const saved = (await portal('/workspace')).tickets.find((item) => item.id === nodeTicket.id);
      assert.equal(saved.productId, 'fjord-pale');
      assert.equal(saved.status, 'completed');
      assert.equal(saved.publicationUrl, 'https://example.invalid/published-post');
      assert.deepEqual(saved.submissions.map((item) => item.version), [1, 2]);
      assert.match(saved.createdAt, isoTimestamp);
      assert.match(saved.updatedAt, isoTimestamp);
      assert.deepEqual(saved.messages.map((item) => item.id), [sent.id, reply.id]);
      assert.ok(saved.messages.every((item) => item.emailStatus === 'sent'));
      assert.ok(saved.messages.every((item) => isoTimestamp.test(item.createdAt) && isoTimestamp.test(item.updatedAt)));
      assert.equal(existsSync(dataFile), false, 'PocketBase mode must never create demo storage');
      const previousToken = cookies.ambassador.slice('olbrygging_pb_auth='.length);
      assert.deepEqual(await portal('/logout', { method: 'POST', body: {} }), { user: null });
      assert.deepEqual(await portal('/session'), { user: null });
      assert.equal((await expect(200, '/api/collections/users/auth-refresh', {
        token: previousToken, method: 'POST',
      })).record.id, users.ambassador.id, 'Logout clears the browser cookie; PocketBase tokens remain stateless');
    } finally {
      await new Promise((done, reject) => app.close((error) => error ? reject(error) : done()));
    }
  });

  await t.test('data and auth tokens survive restart; authorization re-reads current account role', async () => {
    await stop();
    await start();
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    const persisted = workspace.tickets.find((item) => item.id === ticket.id);
    assert.equal(persisted.messages.find((item) => item.id === message.id).emailStatus, 'sent');
    assert.equal(persisted.messages.length, 15);
    const refreshed = await expect(200, '/api/collections/users/auth-refresh', { token: tokens.ambassador, method: 'POST' });
    assert.equal(refreshed.record.id, users.ambassador.id);
    await expect(200, `/api/collections/users/records/${users.employee.id}`, { token: admin, method: 'PATCH', body: { role: 'ambassador' } });
    const demoted = await expect(200, '/api/portal/workspace', { token: tokens.employee });
    assert.equal(demoted.user.role, 'ambassador');
    assert.equal(demoted.tickets.length, 0);
    await expect(404, `/api/portal/tickets/${ticket.id}`, { token: tokens.employee, method: 'PATCH', body: { status: 'completed' } });
    await expect(409, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', body: draft });
  });

  await t.test('offline user import is atomic, repeatable and signs into the Node portal using PocketBase', async () => {
    await stop();
    const imported = {
      email: 'imported@example.invalid', name: 'Imported ambassador', role: 'ambassador', socialMedia: '@imported', password,
    };
    const command = ['portal-import-users'];
    assert.match(cli(command, undefined, { OLBRYGGING_IMPORT_USERS: JSON.stringify([imported]) }), /1 created, 0 existing/);
    // Reruns must not reset passwords, names or roles of existing accounts.
    assert.match(cli(command, undefined, {
      OLBRYGGING_IMPORT_USERS: JSON.stringify([{ ...imported, role: 'employee', password: 'Replacement password' }]),
    }), /0 created, 1 existing/);
    const failed = spawnSync(binary, [...command, ...flags], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OLBRYGGING_IMPORT_USERS: JSON.stringify([
        { ...imported, email: 'rollback@example.invalid' }, { ...imported, email: 'invalid@example.invalid', name: '' },
      ]) },
    });
    assert.notEqual(failed.status, 0);
    await start();
    const rollback = await expect(200, '/api/collections/users/records?filter=email%3D%22rollback%40example.invalid%22', { token: admin });
    assert.equal(rollback.totalItems, 0);
    const { createApp } = await import('../server.mjs');
    const app = createApp({ pocketbaseUrl: base });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const origin = `http://127.0.0.1:${app.address().port}`;
    try {
      const login = await fetch(`${origin}/api/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: imported.email, password }),
      });
      assert.equal(login.status, 200);
      const profile = (await login.json()).user;
      assert.equal(profile.role, 'ambassador');
      assert.equal(profile.name, imported.name);
      assert.match(profile.id, /^[a-z0-9]{15}$/);
      const cookie = login.headers.getSetCookie()[0].split(';')[0];
      assert.match(cookie, /^olbrygging_pb_auth=/);
      const workspace = await fetch(`${origin}/api/workspace`, { headers: { cookie } });
      assert.equal(workspace.status, 200);
      assert.equal((await workspace.json()).user.socialMedia, imported.socialMedia);
    } finally {
      await new Promise((done) => app.close(done));
    }
  });

  await t.test('forward migration repairs an older installed schema without resetting accounts or tickets', async () => {
    const schema = await expect(200, '/api/collections', { token: admin });
    for (const name of ['damage_reports', 'articles']) {
      const collection = schema.items.find((item) => item.name === name);
      await expect(204, `/api/collections/${collection.id}`, { token: admin, method: 'DELETE' });
    }
    for (const [name, missing] of [['users', ['socialMedia']], ['tickets', ['productUrl', 'productSnapshot']]]) {
      const collection = schema.items.find((item) => item.name === name);
      await expect(200, `/api/collections/${collection.id}`, {
        token: admin, method: 'PATCH', body: { fields: collection.fields.filter((field) => !missing.includes(field.name)) },
      });
    }
    const before = await expect(200, '/api/collections/users/records', { token: admin });
    await stop();
    cli(['migrate', 'down', '9'], 'y\n');
    cli(['migrate', 'up']);
    await start();
    const migratedCollections = await expect(200, '/api/collections', { token: admin });
    for (const name of ['users', 'products', 'tickets', 'messages', 'articles', 'damage_reports', 'content_submissions']) {
      assert.ok(migratedCollections.items.some((collection) => collection.name === name), `missing migrated collection ${name}`);
    }
    const migratedUsers = await expect(200, '/api/collections/users', { token: admin });
    assert.ok(migratedUsers.fields.some((field) => field.name === 'isPortalAdmin'));
    const migratedSubmissions = await expect(200, '/api/collections/content_submissions', { token: admin });
    assert.ok(migratedSubmissions.fields.some((field) => field.name === 'ticketId'));
    const after = await expect(200, '/api/collections/users/records', { token: admin });
    assert.deepEqual(after.items.map((item) => item.id).sort(), before.items.map((item) => item.id).sort());
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    assert.ok(workspace.tickets.some((item) => item.id === ticket.id));
    assert.ok(workspace.tickets.find((item) => item.id === ticket.id).submissions.length >= 2);
    assert.deepEqual(workspace.articles, []);
    assert.deepEqual(workspace.damageReports, []);
    assert.equal(workspace.user.socialMedia, '');
    assert.match(cli(['migrate', 'up']), /No new migrations/);
  });

  await t.test('public ambassador applications are private, pending, validated, and linkable only to ambassadors', async () => {
    const body = {
      name: ' New Applicant ', phone: '+47 123 45 678', email: 'APPLICANT@example.invalid',
      addressLine1: 'Testveien 12', addressLine2: 'Leilighet 2', postalCode: '0123', city: 'Oslo',
      region: 'Oslo', country: 'Norge',
      socialLinks: { instagram: 'https://www.instagram.com/test', facebook: '', tiktok: '', twitter: '', bluesky: '', youtube: 'https://www.youtube.com/@test' }, termsAccepted: true,
    };
    const path = '/api/portal/ambassador-applications';
    const recordsPath = '/api/collections/ambassador_applications/records';
    const before = await expect(200, '/api/collections/users/records', { token: admin });
    for (const changes of [{ termsAccepted: false }, { termsAccepted: 'true' }, { termsAccepted: undefined },
      { socialLinks: {} }, { socialLinks: { instagram: 'javascript:alert(1)' } }, { socialLinks: { instagram: 'http://instagram.com/test' } },
      { socialLinks: { instagram: 'https://facebook.com/test' } }, { socialLinks: { unknown: 'https://instagram.com/test' } },
      { userId: users.ambassador.id }, { status: 'approved' }, { name: '' }, { phone: 'bad' },
      { email: 'invalid' }, { termsVersion: 'forged' }, { addressLine1: '' }, { postalCode: '' }, { city: '' }, { country: '' },
    ]) await expect(400, path, { method: 'POST', body: { ...body, ...changes } });
    await expect(415, path, { method: 'POST', raw: JSON.stringify(body), contentType: 'text/plain' });
    await expect(413, path, { method: 'POST', body: { ...body, name: 'x'.repeat(25000) } });
    assert.deepEqual(await expect(201, path, { method: 'POST', body }), { submitted: true });
    const result = await expect(200, recordsPath, { token: admin });
    assert.equal(result.totalItems, 1);
    const record = result.items[0];
    assert.equal(record.name, 'New Applicant');
    assert.equal(record.email, 'applicant@example.invalid');
    assert.equal(record.phone, body.phone);
    assert.equal(record.addressLine1, body.addressLine1);
    assert.equal(record.addressLine2, body.addressLine2);
    assert.equal(record.postalCode, '0123');
    assert.equal(record.city, body.city);
    assert.equal(record.country, body.country);
    assert.equal(record.region, body.region);
    assert.deepEqual(record.socialLinks, body.socialLinks);
    assert.equal(record.status, 'pending');
    assert.equal(record.userId, '');
    assert.equal(record.termsAccepted, true);
    assert.equal(record.termsVersion, '2026-10-30');
    assert.ok(Math.abs(Date.parse(record.termsAcceptedAt) - Date.now()) < 10000);
    assert.equal((await expect(200, '/api/collections/users/records', { token: admin })).totalItems, before.totalItems);
    // A repeat is acknowledged but cannot overwrite personal data or reveal it.
    assert.deepEqual(await expect(201, path, { method: 'POST', body: { ...body, name: 'Changed' } }), { submitted: true });
    const repeated = await expect(200, recordsPath, { token: admin });
    assert.equal(repeated.totalItems, 1);
    assert.equal(repeated.items[0].name, 'New Applicant');
    for (const token of [undefined, tokens.ambassador, tokens.employee]) {
      await expect(403, recordsPath, { token });
      await expect(403, `${recordsPath}/${record.id}`, { token });
      await expect(403, recordsPath, { token, method: 'POST', body });
      await expect(403, `${recordsPath}/${record.id}`, { token, method: 'PATCH', body: { status: 'approved' } });
      await expect(403, `${recordsPath}/${record.id}`, { token, method: 'DELETE' });
    }
    const schema = await expect(200, '/api/collections/ambassador_applications', { token: admin });
    for (const rule of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) assert.equal(schema[rule], null);
    // In a previous test both original employees were demoted; restore one and explicitly grant review access.
    await expect(200, `/api/collections/users/records/${users.employee.id}`, {
      token: admin, method: 'PATCH', body: { role: 'employee', isPortalAdmin: true },
    });
    const reviewer = await expect(200, '/api/collections/users/records', {
      token: admin, method: 'POST', body: {
        email: 'regular-reviewer@example.invalid', password, passwordConfirm: password,
        name: 'Regular reviewer', role: 'employee', emailVisibility: false,
      },
    });
    const reviewerToken = (await expect(200, '/api/collections/users/auth-with-password', {
      method: 'POST', body: { identity: reviewer.email, password },
    })).token;
    await expect(401, '/api/portal/ambassador-applications');
    await expect(403, '/api/portal/ambassador-applications', { token: tokens.ambassador });
    await expect(403, '/api/portal/ambassador-applications', { token: reviewerToken });
    const privateList = await expect(200, '/api/portal/ambassador-applications', { token: tokens.employee });
    assert.equal(privateList.applications.length, 1);
    assert.match(privateList.applications[0].createdAt, isoTimestamp);
    assert.equal(privateList.applications[0].addressLine1, body.addressLine1);
    assert.deepEqual(privateList.applications[0].socialLinks, body.socialLinks);
    await expect(400, `${recordsPath}/${record.id}`, { token: admin, method: 'PATCH', body: { userId: users.employee.id } });

    const setupToken = randomBytes(32).toString('hex');
    const setupTokenHash = createHash('sha256').update(setupToken).digest('hex');
    const ambassadorPassword = randomBytes(24).toString('hex');
    const setupTokenExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const decisionPath = `/api/portal/ambassador-applications/${record.id}/decision`;
    await expect(400, decisionPath, {
      token: tokens.employee, method: 'POST', body: {
        decision: 'approved', setupTokenHash, setupTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
        temporaryPassword: randomBytes(32).toString('base64url'),
      },
    });
    await expect(403, decisionPath, {
      token: tokens.ambassador, method: 'POST', body: {
        decision: 'declined',
      },
    });
    const approved = await expect(200, decisionPath, {
      token: tokens.employee, method: 'POST', body: {
        decision: 'approved', setupTokenHash, setupTokenExpiresAt,
        temporaryPassword: randomBytes(32).toString('base64url'),
      },
    });
    assert.equal(approved.application.status, 'approved');
    assert.equal(approved.application.invitationStatus, 'pending');
    assert.ok(approved.application.userId);
    assert.ok(approved.application.reviewerId);
    await expect(409, decisionPath, {
      token: tokens.employee, method: 'POST', body: {
        decision: 'approved', setupTokenHash, setupTokenExpiresAt,
        temporaryPassword: randomBytes(32).toString('base64url'),
      },
    });
    const createdAmbassador = await expect(200, `/api/collections/users/records/${approved.application.userId}`, { token: admin });
    assert.equal(createdAmbassador.email, body.email.toLowerCase());
    assert.equal(createdAmbassador.role, 'ambassador');
    assert.equal(createdAmbassador.isPortalAdmin, false);
    assert.equal((await expect(200, '/api/collections/users/records', { token: admin })).totalItems, before.totalItems + 2);
    await expect(200, `${recordsPath}/${record.id}`, {
      token: admin, method: 'PATCH', body: { setupTokenExpiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    await expect(400, '/api/portal/ambassador-account/setup', {
      method: 'POST', body: { setupTokenHash, password: ambassadorPassword },
    });
    await expect(200, `${recordsPath}/${record.id}`, {
      token: admin, method: 'PATCH', body: { setupTokenExpiresAt },
    });
    await expect(200, `/api/portal/ambassador-applications/${record.id}/invitation-status`, {
      token: tokens.employee, method: 'POST', body: { status: 'failed', setupTokenHash },
    });
    const retryToken = randomBytes(32).toString('hex');
    const retryTokenHash = createHash('sha256').update(retryToken).digest('hex');
    const retried = await expect(200, decisionPath, {
      token: tokens.employee, method: 'POST', body: {
        decision: 'retry_invitation', setupTokenHash: retryTokenHash,
        setupTokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        temporaryPassword: randomBytes(32).toString('base64url'),
      },
    });
    assert.equal(retried.application.userId, approved.application.userId);
    assert.equal(retried.application.invitationStatus, 'pending');
    await expect(400, '/api/portal/ambassador-account/setup', {
      method: 'POST', body: { setupTokenHash, password: ambassadorPassword },
    });
    await expect(200, '/api/portal/ambassador-account/setup', {
      method: 'POST', body: { setupTokenHash: retryTokenHash, password: ambassadorPassword },
    });
    await expect(400, '/api/portal/ambassador-account/setup', {
      method: 'POST', body: { setupTokenHash: retryTokenHash, password: ambassadorPassword },
    });
    assert.equal((await expect(200, '/api/collections/users/auth-with-password', {
      method: 'POST', body: { identity: body.email.toLowerCase(), password: ambassadorPassword },
    })).record.role, 'ambassador');
    const acceptedApplication = await expect(200, `${recordsPath}/${record.id}`, { token: admin });
    assert.equal(acceptedApplication.invitationStatus, 'accepted');
    assert.equal(acceptedApplication.setupTokenHash, '');
    await expect(400, `/api/collections/users/records/${approved.application.userId}`, {
      token: admin, method: 'PATCH', body: { isPortalAdmin: true },
    });
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    assert.equal(workspace.ambassadorApplications, undefined);
    assert.ok(!JSON.stringify(workspace).includes('Testveien 12'));

    // Exercise the real anonymous Node route as used by the sign-in form.
    const { createApp } = await import('../server.mjs');
    const sentInvitations = [];
    const app = createApp({
      pocketbaseUrl: base, publicUrl: 'https://portal.example.invalid', emailApiKey: 'integration-key', emailFrom: 'portal@example.invalid',
      fetchEmail: async (_url, options) => {
        sentInvitations.push(JSON.parse(options.body));
        return new Response(null, { status: 202 });
      },
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const origin = `http://127.0.0.1:${app.address().port}`;
    try {
      const response = await fetch(`${origin}/api/ambassador-applications`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, email: 'second-applicant@example.invalid',
          socialLinks: { instagram: `https://instagram.com/0/${'ø'.repeat(700)}`, facebook: `https://facebook.com/1/${'ø'.repeat(700)}`,
            tiktok: `https://tiktok.com/2/${'ø'.repeat(700)}`, twitter: `https://x.com/3/${'ø'.repeat(700)}`,
            bluesky: `https://bsky.app/4/${'ø'.repeat(700)}`, youtube: `https://youtube.com/5/${'ø'.repeat(700)}`,
          },
        }),
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { submitted: true });
      assert.deepEqual(response.headers.getSetCookie(), []);
      const newApplicant = await fetch(`${origin}/api/ambassador-applications`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, email: 'node-applicant@example.invalid' }),
      });
      assert.equal(newApplicant.status, 201);
      const nodeRecord = (await expect(200, recordsPath, { token: admin })).items.find((item) => item.email === 'node-applicant@example.invalid');
      const adminLogin = await fetch(`${origin}/api/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'employee@example.invalid', password }),
      });
      assert.equal(adminLogin.status, 200);
      assert.equal((await adminLogin.json()).user.isPortalAdmin, true);
      const adminCookie = adminLogin.headers.getSetCookie()[0].split(';')[0];
      const adminWorkspace = await fetch(`${origin}/api/workspace`, { headers: { cookie: adminCookie } });
      assert.equal((await adminWorkspace.json()).user.isPortalAdmin, true);
      const decision = await fetch(`${origin}/api/ambassador-applications/${nodeRecord.id}/decision`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ decision: 'approved' }),
      });
      assert.equal(decision.status, 200);
      assert.equal((await decision.json()).application.invitationStatus, 'sent');
      assert.equal(sentInvitations.length, 1);
      assert.deepEqual(sentInvitations[0].to, ['node-applicant@example.invalid']);
      const invitationLink = sentInvitations[0].text.match(/https:\/\/portal\.example\.invalid\/#setup=[a-f0-9]{64}/)[0];
      const setupToken = new URLSearchParams(new URL(invitationLink).hash.slice(1)).get('setup');
      const newPassword = randomBytes(24).toString('hex');
      const setup = await fetch(`${origin}/api/ambassador-account/setup`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: setupToken, password: newPassword }),
      });
      assert.equal(setup.status, 200);
      const newLogin = await fetch(`${origin}/api/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'node-applicant@example.invalid', password: newPassword }),
      });
      assert.equal(newLogin.status, 200);
      assert.equal((await newLogin.json()).user.role, 'ambassador');
    } finally { await new Promise((done) => app.close(done)); }
    const saved = await expect(200, recordsPath, { token: admin });
    assert.equal(saved.totalItems, 3);
    const raceApplication = saved.items.find((item) => item.email === 'second-applicant@example.invalid');
    const racePath = `/api/portal/ambassador-applications/${raceApplication.id}/decision`;
    const racingDecision = () => ({
      decision: 'approved', setupTokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      setupTokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      temporaryPassword: randomBytes(32).toString('base64url'),
    });
    const raceResults = await Promise.all([0, 1].map(() => request(racePath, {
      token: tokens.employee, method: 'POST', body: racingDecision(),
    })));
    assert.deepEqual(raceResults.map((result) => result.status).sort(), [200, 409]);
    assert.ok(raceResults.find((result) => result.status === 200).data.application.userId);
    await expect(201, path, { method: 'POST', body: { ...body, email: 'declined@example.invalid' } });
    const declinedRecord = (await expect(200, recordsPath, { token: admin })).items.find((item) => item.email === 'declined@example.invalid');
    const declined = await expect(200, `/api/portal/ambassador-applications/${declinedRecord.id}/decision`, {
      token: tokens.employee, method: 'POST', body: { decision: 'declined' },
    });
    assert.equal(declined.application.status, 'declined');
    assert.equal(declined.application.userId, null);
    await expect(201, path, { method: 'POST', body: { ...body, email: 'EMPLOYEE@example.invalid' } });
    const duplicateRecord = (await expect(200, recordsPath, { token: admin })).items.find((item) => item.email === 'employee@example.invalid');
    await expect(409, `/api/portal/ambassador-applications/${duplicateRecord.id}/decision`, {
      token: tokens.employee, method: 'POST', body: racingDecision(),
    });
    assert.equal((await expect(200, '/api/collections/users/records', { token: admin })).totalItems, before.totalItems + 4);
    await stop();
    await start();
    assert.equal((await expect(200, recordsPath, { token: admin })).totalItems, 5);
  });

  await t.test('portal URL tasks survive restart, acceptance races have one winner, and expired tasks cannot be claimed', async () => {
    const thirdAmbassador = await expect(200, '/api/collections/users/records', {
      token: admin, method: 'POST',
      body: { email: 'third-ambassador@example.invalid', password, passwordConfirm: password, name: 'Third ambassador', role: 'ambassador', emailVisibility: false },
    });
    const thirdAmbassadorToken = (await expect(200, '/api/collections/users/auth-with-password', {
      method: 'POST', body: { identity: thirdAmbassador.email, password },
    })).token;
    const { createApp } = await import('../server.mjs');
    const app = createApp({
      pocketbaseUrl: base,
      fetchProductPage: async () => new Response(`<html><head><meta property="og:image" content="/url-product.jpg"><script type="application/ld+json">{"@type":"Product","name":"URL-only native product","description":"Native product details","offers":{"price":"950.50","priceCurrency":"NOK"}}</script></head></html>`, { headers: { 'content-type': 'text/html' } }),
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const origin = `http://127.0.0.1:${app.address().port}`;
    const later = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const input = {
      productUrl: 'https://www.olbrygging.no/produkt/url-task', subject: 'Creative task idea',
      description: 'Our instructions for ambassadors', acceptBy: later(3), dueDate: later(10), promotionCount: 3,
    };
    const path = '/api/collections/tickets/records';
    try {
      const login = await fetch(`${origin}/api/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'employee@example.invalid', password }),
      });
      assert.equal(login.status, 200);
      await login.json();
      const cookie = login.headers.getSetCookie()[0].split(';')[0];
      async function create() {
        const response = await fetch(`${origin}/api/tasks`, {
          method: 'POST', headers: { cookie, Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const data = await response.json();
        assert.equal(response.status, 201, JSON.stringify(data));
        return data.ticket;
      }
      const task = await create();
      assert.equal(task.promotionCount, 3);
      const staffWorkspace = await expect(200, '/api/portal/workspace', { token: tokens.employee });
      const instances = staffWorkspace.tickets.filter((item) => item.promotionBase === task.promotionBase)
        .sort((a, b) => a.promotionIndex - b.promotionIndex);
      assert.equal(instances.length, 3);
      assert.deepEqual(instances.map((item) => item.displayNumber), [`${task.promotionBase}-1`, `${task.promotionBase}-2`, `${task.promotionBase}-3`]);
      assert.equal(task.productSnapshot.name, 'URL-only native product');
      assert.equal(task.productSnapshot.description, 'Native product details');
      assert.equal(task.productSnapshot.price, 950.5);
      assert.equal(task.productSnapshot.image, 'https://www.olbrygging.no/url-product.jpg');
      assert.equal(task.ambassadorId, '');
      assert.equal(task.channel, '');
      assert.equal(task.promotionOpen, true);
      assert.ok(instances.every((item) => item.promotionOpen && item.promotionCount === 3));
      for (const token of [tokens.employee, tokens.ambassador]) {
        await expect(400, `/api/portal/tickets/${task.id}/messages`, { token, method: 'POST', body: { body: 'Private?' } });
      }
      const claims = await Promise.all([tokens.ambassador, tokens.other].map((token) => request(`/api/portal/tickets/${task.id}/accept`, {
        token, method: 'POST', body: {},
      })));
      assert.deepEqual(claims.map((claim) => claim.status).sort(), [200, 409]);
      const winner = claims.find((claim) => claim.status === 200).data.ticket.ambassadorId;
      const saved = await expect(200, `${path}/${task.id}`, { token: admin });
      assert.equal(saved.ambassadorId, winner);
      const duplicateSlot = instances.find((item) => item.id !== task.id);
      await expect(409, `/api/portal/tickets/${duplicateSlot.id}/accept`, {
        token: winner === users.ambassador.id ? tokens.ambassador : tokens.other, method: 'POST', body: {},
      });
      const otherToken = winner === users.ambassador.id ? tokens.other : tokens.ambassador;
      const otherClaim = await expect(200, `/api/portal/tickets/${duplicateSlot.id}/accept`, { token: otherToken, method: 'POST', body: {} });
      assert.notEqual(otherClaim.ticket.ambassadorId, winner);
      await expect(409, `/api/portal/tickets/${instances[2].id}/accept`, {
        token: winner === users.ambassador.id ? tokens.ambassador : tokens.other, method: 'POST', body: {},
      });
      await expect(409, `/api/portal/tickets/${instances[2].id}/accept`, { token: otherToken, method: 'POST', body: {} });
      await expect(403, `/api/portal/tickets/${instances[2].id}/accept`, { token: tokens.employee, method: 'POST', body: {} });
      const thirdClaim = await expect(200, `/api/portal/tickets/${instances[2].id}/accept`, { token: thirdAmbassadorToken, method: 'POST', body: {} });
      assert.notEqual(thirdClaim.ticket.ambassadorId, winner);
      assert.notEqual(thirdClaim.ticket.ambassadorId, otherClaim.ticket.ambassadorId);
      const raceCampaign = await create();
      const raceSlots = (await expect(200, '/api/portal/workspace', { token: tokens.employee })).tickets
        .filter((item) => item.promotionBase === raceCampaign.promotionBase)
        .sort((a, b) => a.promotionIndex - b.promotionIndex);
      const sameAmbassadorRace = await Promise.all(raceSlots.slice(0, 2).map((slot) =>
        request(`/api/portal/tickets/${slot.id}/accept`, { token: tokens.ambassador, method: 'POST', body: {} })));
      assert.deepEqual(sameAmbassadorRace.map((result) => result.status).sort(), [200, 409]);
      const expired = await create();
      await expect(200, `${path}/${expired.id}`, { token: admin, method: 'PATCH', body: { acceptBy: later(-1) } });
      await expect(409, `/api/portal/tickets/${expired.id}/accept`, { token: tokens.ambassador, method: 'POST', body: {} });
      const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
      assert.ok(!workspace.tickets.some((ticket) => ticket.id === expired.id));
      assert.ok((await expect(200, '/api/portal/workspace', { token: tokens.employee })).tickets.some((ticket) => ticket.id === expired.id));
      await stop();
      await start();
      const persisted = await expect(200, `${path}/${task.id}`, { token: admin });
      assert.equal(persisted.ambassadorId, winner);
      assert.equal(persisted.acceptBy, input.acceptBy);
      assert.equal(persisted.dueDate, input.dueDate);
      assert.deepEqual(persisted.productSnapshot, saved.productSnapshot);
    } finally { await new Promise((done) => app.close(done)); }
  });

  await t.test('ambassador promotion quantity creates independently numbered instances with one shared base', async () => {
    const body = {
      productId: 'fjord-pale', productUrl: 'https://www.olbrygging.no/produkt/multi-promotion',
      subject: 'Promote the seasonal brew', description: 'One separate post per promotion instance.',
      channel: 'Instagram', dueDate: '2028-04-20', promotionCount: 3,
      productSnapshot: {
        url: 'https://www.olbrygging.no/produkt/multi-promotion', name: 'Seasonal brew',
        description: 'Fetched campaign product', price: 520, currency: 'NOK', image: 'https://cdn.example/seasonal.jpg',
      },
    };
    const result = await expect(201, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', body });
    assert.equal(result.promotionCount, 3);
    assert.equal(result.tickets.length, 3);
    assert.equal(result.ticket.id, result.tickets[0].id);
    const base = result.ticket.number;
    assert.deepEqual(result.tickets.map((item) => item.displayNumber), [`${base}-1`, `${base}-2`, `${base}-3`]);
    assert.deepEqual(result.tickets.map((item) => item.number), [base, base + 1, base + 2]);
    assert.equal(new Set(result.tickets.map((item) => item.id)).size, 3);
    assert.ok(result.tickets.every((item) => item.promotionBase === base && item.promotionCount === 3));
    assert.ok(result.tickets.every((item, index) => item.promotionIndex === index + 1));
    assert.ok(result.tickets.every((item) => item.ambassadorId === users.ambassador.id && item.status === 'requested'));
    for (const changes of [{ promotionCount: 0 }, { promotionCount: 51 }, { promotionCount: 1.5 }, { promotionCount: 'many' }]) {
      await expect(400, '/api/portal/tickets', { token: tokens.ambassador, method: 'POST', body: { ...body, ...changes } });
    }
    await expect(200, `/api/portal/tickets/${result.tickets[0].id}`, {
      token: tokens.employee, method: 'PATCH', body: { status: 'approved' },
    });
    await expect(201, `/api/portal/tickets/${result.tickets[0].id}/messages`, {
      token: tokens.ambassador, method: 'POST', body: { body: 'Message for the first instance only' },
    });
    const workspace = await expect(200, '/api/portal/workspace', { token: tokens.ambassador });
    assert.equal(workspace.tickets.find((item) => item.id === result.tickets[0].id).messages.length, 1);
    assert.equal(workspace.tickets.find((item) => item.id === result.tickets[1].id).status, 'requested');
    assert.deepEqual(workspace.tickets.find((item) => item.id === result.tickets[1].id).messages, []);
    await expect(404, `/api/portal/tickets/${result.tickets[0].id}/messages`, {
      token: tokens.other, method: 'POST', body: { body: 'Not my promotion' },
    });
    const defaultCount = await expect(201, '/api/portal/tickets', {
      token: tokens.ambassador, method: 'POST', body: { ...body, promotionCount: undefined },
    });
    assert.equal(defaultCount.ticket.displayNumber, `${base + 3}-1`);
    assert.equal(defaultCount.tickets.length, 1);
    await expect(204, `/api/collections/tickets/records/${defaultCount.ticket.id}`, { token: admin, method: 'DELETE' });
    for (const item of result.tickets) await expect(204, `/api/collections/tickets/records/${item.id}`, { token: admin, method: 'DELETE' });
    const urlOnly = await expect(201, '/api/portal/tickets', {
      token: tokens.ambassador, method: 'POST', body: {
        productUrl: 'https://www.olbrygging.no/produkt/url-only',
        productSnapshot: {
          url: 'https://www.olbrygging.no/produkt/url-only', name: 'URL-only product',
          description: 'Fetched directly from the product page.', price: 250, currency: 'NOK', image: null,
        },
        subject: 'URL-only promotion', description: 'No catalogue relation required.',
        channel: 'Instagram', promotionCount: 2,
      },
    });
    assert.equal(urlOnly.ticket.productId, null);
    assert.equal(urlOnly.ticket.productSnapshot.name, 'URL-only product');
    assert.deepEqual(urlOnly.tickets.map((item) => item.displayNumber), [
      `${defaultCount.ticket.number + 1}-1`, `${defaultCount.ticket.number + 1}-2`,
    ]);
    for (const item of urlOnly.tickets) await expect(204, `/api/collections/tickets/records/${item.id}`, { token: admin, method: 'DELETE' });
  });
});
