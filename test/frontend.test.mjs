import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

async function frontend() {
  const app = {};
  const listeners = {};
  const elements = {};
  const modal = { querySelector: (selector) => elements[selector] };
  let poll;
  const context = createContext({
    document: {
      hidden: false,
      activeElement: null,
      querySelector: (selector) => selector === '#app' ? app : selector === '#modal-root' ? modal : null,
      addEventListener: (event, handler) => { listeners[event] = handler; },
    },
    fetch: async () => ({ ok: true, json: async () => ({ user: null }) }),
    setInterval: (callback) => { poll = callback; },
    setTimeout: () => {},
    clearTimeout: () => {},
    console,
    URL,
  });
  runInContext(source, context);
  await new Promise(setImmediate);
  runInContext('render = () => {}; toast = () => {};', context);
  return { context, listeners, elements, poll, run: (script) => runInContext(script, context) };
}

test('a delayed workspace poll cannot restore a previous account after logout or account switch', async () => {
  for (const nextUser of [null, { id: 'emil', role: 'ambassador' }]) {
    const { context, run, poll } = await frontend();
    run("state.user = { id: 'nora', role: 'employee' }; state.tickets = [];");
    let resolve;
    context.fetch = () => new Promise((done) => { resolve = done; });
    const pending = poll();
    context.nextUser = nextUser;
    run('authVersion++; state.user = nextUser;');
    resolve({ ok: true, json: async () => ({ user: { id: 'nora', role: 'employee' }, tickets: [{ id: 'private-ticket' }] }) });
    await pending;
    assert.equal(run('state.user?.id ?? null'), nextUser?.id ?? null);
    assert.equal(run('state.tickets.length'), 0);
  }
});

test('demo login shortcuts appear only when the server enables demo mode', async () => {
  const { context, run } = await frontend();
  run('state.demoMode = false; renderLogin();');
  assert.equal(context.document.querySelector('#app').innerHTML.includes('data-demo='), false);
  assert.match(context.document.querySelector('#app').innerHTML, /Kontakt administrator/);
  run('state.demoMode = true; renderLogin();');
  assert.match(context.document.querySelector('#app').innerHTML, /data-demo="ambassador"/);
  assert.match(context.document.querySelector('#app').innerHTML, /Lokal demonstrasjon/);
});

test('sign-in offers a password-free ambassador application with full address and explicit consent', async () => {
  const { context, run } = await frontend();
  run('renderLogin();');
  assert.match(context.document.querySelector('#app').innerHTML, /data-action="apply-ambassador"/);
  context.capture = (html) => { context.applicationHtml = html; };
  run('showModal = capture; applyAmbassador();');
  const html = context.applicationHtml;
  for (const name of ['name', 'phone', 'email', 'addressLine1', 'addressLine2', 'postalCode', 'city', 'region', 'country', 'social_instagram', 'social_facebook', 'social_tiktok', 'social_twitter', 'social_bluesky', 'social_youtube']) {
    assert.ok(html.includes(`name="${name}"`));
  }
  for (const label of ['Instagram', 'Facebook', 'TikTok', 'X/Twitter', 'Bluesky', 'YouTube']) assert.ok(html.includes(`>${label}</label>`));
  assert.match(html, /type="tel"/);
  assert.match(html, /name="termsAccepted" type="checkbox" required/);
  assert.ok(!html.includes('checked'));
  assert.ok(!html.includes('type="password"'));
  assert.match(html, /href="\/ambassador-terms.html"/);
  assert.match(html, /minst én profil er påkrevd/i);
  assert.match(html, /Send søknad/);
  run('state.demoMode = true; applyAmbassador();');
  assert.match(context.applicationHtml, /type="submit" disabled/);
});

test('application submits all separate social inputs without login/workspace calls and retains drafts on failure', async () => {
  const { context, run } = await frontend();
  const entries = {
    name: ' Test Applicant ', phone: '+47 12345678', email: 'test@example.invalid',
    addressLine1: 'Testveien 12', addressLine2: '', postalCode: '0123', city: 'Oslo', region: '', country: 'Norge',
  };
  const error = { textContent: '', focus() {} };
  const form = {
    isConnected: true, reportValidity: () => true,
    querySelector: () => error, setAttribute() {}, removeAttribute() {},
  };
  const fields = {
    get: (name) => name === 'social_instagram' ? ' https://www.instagram.com/test '
      : name === 'social_youtube' ? 'https://www.youtube.com/@test' : entries[name],
    has: (name) => name === 'termsAccepted',
  };
  context.form = form;
  context.fields = fields;
  context.button = { disabled: false };
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    throw new TypeError('Network down');
  };
  context.fields = { ...fields, get: (name) => name.startsWith('social_') ? '' : fields.get(name) };
  await run('submitAmbassadorApplication(form, fields, button)');
  assert.match(error.textContent, /minst én sosial medieprofil/i);
  assert.equal(calls.length, 0);
  context.fields = fields;
  await run('submitAmbassadorApplication(form, fields, button)');
  assert.match(error.textContent, /Kontroller nettforbindelsen/);
  assert.equal(entries.name, ' Test Applicant ');
  assert.equal(context.button.disabled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/ambassador-applications');
  assert.deepEqual(calls[0].body.socialLinks, {
    instagram: 'https://www.instagram.com/test', facebook: '', tiktok: '', twitter: '', bluesky: '', youtube: 'https://www.youtube.com/@test',
  });
  assert.equal(calls[0].body.name, 'Test Applicant');
  assert.equal(calls[0].body.termsAccepted, true);
  context.capture = (html) => { context.successHtml = html; };
  run('showModal = capture;');
  context.fetch = async (url) => {
    assert.equal(url, '/api/ambassador-applications');
    return { ok: true, json: async () => ({ submitted: true }) };
  };
  await run('submitAmbassadorApplication(form, fields, button)');
  assert.match(context.successHtml, /Takk for søknaden/);
  assert.equal(run('state.user'), null);
});

test('a late application response cannot replace a closed or switched dialog', async () => {
  const { context, run } = await frontend();
  context.form = {
    isConnected: false, reportValidity: () => true,
    querySelector: () => ({ textContent: '' }), setAttribute() {}, removeAttribute() {},
  };
  context.fields = { get: (name) => name === 'social_instagram' ? 'https://www.instagram.com/test' : '', getAll: () => [], has: () => true };
  context.button = { disabled: false };
  context.capture = () => { throw new Error('Must not replace the dialog'); };
  run('showModal = capture;');
  await run('submitAmbassadorApplication(form, fields, button)');
});

test('metadata saves preserve the latest draft, cursor and email selection', async () => {
  const { context, run, elements, listeners } = await frontend();
  const composer = { value: 'Initial draft', selectionStart: 0, selectionEnd: 0 };
  elements['#message-body'] = composer;
  elements['[name=sendEmail]'] = { checked: true };
  context.document.activeElement = composer;
  run("state.user = {id:'nora'}; modalTicketId = 'ticket-1001';");
  context.rebuild = (_id, draft) => {
    elements['#message-body'] = {
      value: draft,
      focus() { context.document.activeElement = this; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    };
    elements['[name=sendEmail]'] = { checked: false };
  };
  run('ticketDetail = rebuild;');
  let resolve;
  context.fetch = async (_url, options) => {
    if (options.method === 'PATCH') return new Promise((done) => { resolve = done; });
    return { ok: true, json: async () => ({ user: { id: 'nora' }, tickets: [] }) };
  };
  const pending = listeners.change({ target: { dataset: { update: 'status' }, value: 'approved' } });
  composer.value = 'New text typed while saving';
  composer.selectionStart = 9;
  composer.selectionEnd = 14;
  resolve({ ok: true, json: async () => ({ ticket: {} }) });
  await pending;
  assert.equal(elements['#message-body'].value, 'New text typed while saving');
  assert.equal(elements['[name=sendEmail]'].checked, true);
  assert.equal(elements['#message-body'].selectionStart, 9);
  assert.equal(elements['#message-body'].selectionEnd, 14);
});

test('network failures give actionable feedback without clearing the workspace or draft', async () => {
  const { context, run, elements } = await frontend();
  run("state.user = { id: 'emil' }; state.tickets = [{ id: 'ticket-1001' }];");
  elements['#message-body'] = { value: 'Unsent draft' };
  context.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(run("api('/tickets/ticket-1001/messages', { method: 'POST', body: { body: 'Unsent draft' } })"), /Kontroller nettforbindelsen/);
  assert.equal(run('state.user.id'), 'emil');
  assert.equal(run('state.tickets.length'), 1);
  assert.equal(elements['#message-body'].value, 'Unsent draft');
});

test('ticket rows show the validated product link and fetched product image', async () => {
  const { run } = await frontend();
  run(`state.user = { id: 'nora', name: 'Nora Berg', role: 'employee' };
    state.users = [{ id: 'emil', name: 'Emil Hansen', role: 'ambassador' }];
    state.tickets = [{
      id: 'ticket-1', number: 1001, subject: 'Produktguide', status: 'approved',
      channel: 'Instagram', dueDate: null, ambassadorId: 'emil', productId: 'demo',
      productUrl: 'https://www.olbrygging.no/produkt/ekte-produkt',
      productSnapshot: { name: 'Ekte produkt', image: 'https://cdn.example/produkt.jpg', price: 129.5, currency: 'NOK', description: 'Frisk <b>råvare</b>' },
    }];`);
  const row = run('ticketTable(state.tickets)');
  assert.match(row, /href="https:\/\/www\.olbrygging\.no\/produkt\/ekte-produkt"/);
  assert.match(row, /src="https:\/\/cdn\.example\/produkt\.jpg"/);
  assert.match(row, /129,5 NOK/);
  assert.match(row, /Frisk &lt;b&gt;råvare&lt;\/b&gt;/);
  assert.equal(run("productLink('https://evil.example/product')"), '');
});

test('a delayed product preview does not update a replacement request form', async () => {
  const { context, run, listeners } = await frontend();
  run('let previewCalls = 0; productPreview = () => { previewCalls++; };');
  const field = { value: 'https://www.olbrygging.no/produkt/eksempel' };
  const preview = { textContent: '' };
  const form = {
    isConnected: false,
    querySelector: (selector) => selector === '[name=productUrl]' ? field : preview,
  };
  const button = {
    dataset: { action: 'preview-product' },
    closest: () => form,
    matches: () => false,
  };
  context.fetch = async () => ({ ok: true, json: async () => ({ product: { name: 'Produkt' } }) });
  await listeners.click({ target: { closest: () => button, classList: { contains: () => false } } });
  assert.equal(run('previewCalls'), 0);
  assert.equal(preview.textContent, '');
});
