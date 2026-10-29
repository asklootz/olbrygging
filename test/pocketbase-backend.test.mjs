import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.env.POCKETBASE_BINARY || resolve(root, 'pocketbase'));
const skip = !existsSync(binary) && 'Native PocketBase binary missing; install PocketBase 0.40.6 or set POCKETBASE_BINARY to run integration tests.';
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('PocketBase 0.40.6 migrations, authorization and transactional portal endpoints', { skip, timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(resolve(root, '.pb-integration-'));
  const flags = [
    `--dir=${directory}`, `--hooksDir=${resolve(root, 'pb_hooks')}`,
    `--migrationsDir=${resolve(root, 'pb_migrations')}`,
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
  function cli(args, input) {
    const result = spawnSync(binary, [...args, ...flags], { cwd: root, encoding: 'utf8', input, timeout: 30_000 });
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
    const data = await response.json();
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
      for (const collection of ['products', 'tickets', 'messages', 'portal_counters']) {
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
      id: users.ambassador.id, name: 'ambassador', email: 'ambassador@example.invalid', role: 'ambassador',
    });
    assert.deepEqual(workspace.tickets, []);
    assert.equal(workspace.products.length, 8);
    assert.ok(workspace.products.some((item) => item.id === 'fjord-pale' && item.price === 449));
    assert.deepEqual(new Set(workspace.users.map((user) => user.id)), new Set([users.ambassador.id, users.employee.id]));
    for (const user of workspace.users) assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'name', 'role']);
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

  await t.test('workflow permits only approved → in_progress → review for ambassadors; employee changes are atomic', async () => {
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
    for (const status of ['in_progress', 'review']) {
      const changed = (await expect(200, path, { token: tokens.ambassador, method: 'PATCH', body: { status } })).ticket;
      assert.equal(changed.status, status);
      assert.equal(changed.dueDate, null);
      assert.ok(Date.parse(changed.updatedAt) >= Date.parse(ticket.updatedAt));
      assert.match(changed.updatedAt, isoTimestamp);
    }
    await expect(403, path, { token: tokens.ambassador, method: 'PATCH', body: { status: 'completed' } });
    for (const status of ['completed', 'declined', 'requested', 'approved', 'in_progress', 'review']) {
      assert.equal((await expect(200, path, { token: tokens.employee, method: 'PATCH', body: { status } })).ticket.status, status);
    }
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
    assert.deepEqual(created.map((item) => item.ticket.number).sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1003));
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
    async function portal(path, { method = 'GET', body, role = 'ambassador', status = 200, origin = nodeBase } = {}) {
      const response = await fetch(`${nodeBase}/api${path}`, {
        method, signal: AbortSignal.timeout(15_000),
        headers: {
          ...(cookies[role] ? { cookie: cookies[role] } : {}),
          ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
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
      await portal('/tickets', { method: 'POST', body: draft, origin: 'https://unrelated.example.invalid', status: 403 });
      nodeTicket = (await portal('/tickets', { method: 'POST', body: draft, status: 201 })).ticket;
      assert.match(nodeTicket.id, /^[a-z0-9]{15}$/);
      assert.equal(nodeTicket.productId, 'fjord-pale');
      assert.equal(nodeTicket.number, 1015);
      const updated = (await portal(`/tickets/${nodeTicket.id}`, {
        role: 'employee', method: 'PATCH', body: { status: 'approved', assigneeId: users.employee.id, dueDate: null },
      })).ticket;
      assert.equal(updated.status, 'approved');
      assert.equal(updated.dueDate, null);
      for (const status of ['in_progress', 'review']) {
        assert.equal((await portal(`/tickets/${nodeTicket.id}`, { method: 'PATCH', body: { status } })).ticket.status, status);
      }
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
      const saved = (await portal('/workspace')).tickets.find((item) => item.id === nodeTicket.id);
      assert.equal(saved.productId, 'fjord-pale');
      assert.equal(saved.status, 'review');
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
});
