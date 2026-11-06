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
      querySelectorAll: () => [],
      addEventListener: (event, handler) => { listeners[event] = handler; },
    },
    fetch: async () => ({ ok: true, json: async () => ({ user: null }) }),
    setInterval: (callback) => { poll = callback; },
    setTimeout: () => {},
    clearTimeout: () => {},
    console,
    URL,
    URLSearchParams,
  });
  runInContext(source, context);
  await new Promise(setImmediate);
  runInContext('renderApp = render;', context);
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

test('workspace polling defers a render while a form has unsaved edits', async () => {
  const { context, run, poll } = await frontend();
  const form = {};
  context.form = form;
  context.document.querySelectorAll = () => [form];
  run(`state.user = { id: 'emil', role: 'ambassador' };
    state.tickets = [{ id: 'current-ticket' }]; dirtyForms.add(form);`);
  context.fetch = async () => ({ ok: true, json: async () => ({
    user: { id: 'emil', role: 'ambassador' },
    tickets: [{ id: 'refreshed-ticket' }], articles: [], damageReports: [], users: [], products: [],
  }) });
  await poll();
  assert.equal(run('state.tickets[0].id'), 'current-ticket');
});

test('mobile navigation keeps primary destinations and exposes secondary pages in More', async () => {
  const { run } = await frontend();
  run(`state.user = { id: 'admin', name: 'Test Admin', role: 'admin' };
    state.products = []; state.tickets = []; state.users = []; state.articles = []; state.damageReports = [];
    showModal = html => { capturedModal = html; };`);
  const html = run('renderApp(); app.innerHTML');
  for (const page of ['overview', 'tickets', 'messages']) assert.match(html, new RegExp(`<button data-page="${page}" (?!data-mobile-secondary)`));
  assert.doesNotMatch(html, /data-page="products"/);
  for (const page of ['profiles', 'knowledge', 'damage', 'settings', 'admin']) assert.match(html, new RegExp(`data-page="${page}" data-mobile-secondary`));
  assert.match(html, /data-action="more-menu"/);
  run('showModal = html => { capturedModal = html; }; moreMenu();');
  for (const label of ['Ambassadører', 'Kunnskapsbase', 'Skademeldinger', 'Innstillinger', 'Brukeradministrasjon', 'Hjelp og informasjon']) {
    assert.ok(run(`capturedModal.includes('${label}')`));
  }
});

test('only provisioned portal admins see applicant reviews and setup links render a password form', async () => {
  const { context, run } = await frontend();
  run(`state.user = { id: 'staff', name: 'Trusted staff', role: 'employee', isPortalAdmin: true };
    state.products = []; state.tickets = []; state.users = []; state.articles = []; state.damageReports = [];
    state.applications = [{ id: 'application0001', name: 'New applicant', email: 'new@example.invalid', phone: '+47 12345678',
      addressLine1: 'Testveien 1', postalCode: '0123', city: 'Oslo', country: 'Norge', socialLinks: { instagram: 'https://instagram.com/new' },
      status: 'pending', invitationStatus: 'not_sent', createdAt: '2026-10-30T12:00:00.000Z' }];
    state.page = 'applications';`);
  const html = run('renderApp(); app.innerHTML');
  assert.match(html, /data-page="applications"/);
  assert.match(html, /New applicant/);
  assert.match(html, /new@example\.invalid/);
  assert.match(html, /data-application-decision="approved"/);
  assert.match(html, /data-application-decision="declined"/);
  run('state.user = { id: "staff", name: "Regular staff", role: "employee" };');
  assert.doesNotMatch(run('renderApp(); app.innerHTML'), /data-page="applications"/);
  assert.match(run('applicationsPage()'), /bare tilgjengelig for administrator/);
  let scrubbed;
  context.location = { href: `https://portal.example.invalid/#setup=${'a'.repeat(64)}`, pathname: '/' };
  context.history = { replaceState: (...args) => { scrubbed = args; } };
  await run('start()');
  assert.equal(Object.keys(scrubbed[0]).length, 0);
  assert.equal(scrubbed[1], '');
  assert.equal(scrubbed[2], '/');
  assert.match(context.document.querySelector('#app').innerHTML, /id="ambassador-setup-form"/);
  assert.match(context.document.querySelector('#app').innerHTML, /name="confirmation"/);
});

test('a delayed application list cannot restore private data after an account switch', async () => {
  for (const nextUser of [null, { id: 'other-admin', role: 'employee', isPortalAdmin: true }]) {
    const { context, run } = await frontend();
    context.window = { scrollTo() {} };
    run("state.user = { id: 'admin', role: 'employee', isPortalAdmin: true }; state.applications = [];");
    let resolve;
    context.fetch = () => new Promise((done) => { resolve = done; });
    const pending = run("navigate('applications')");
    context.nextUser = nextUser;
    run('authVersion++; state.user = nextUser; clearApplications();');
    resolve({ ok: true, json: async () => ({ applications: [{ id: 'private-application' }] }) });
    await pending;
    assert.equal(run('state.applications.length'), 0);
  }
});

test('phone layout stylesheet is linked and precached without expanding the private cache boundary', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(html, /href="\/mobile\.css"/);
  assert.match(worker, /'\/mobile\.css'/);
  assert.match(worker, /olbrygging-shell-v13/);
  assert.doesNotMatch(worker, /\/api\//);
});

test('employee task creation is URL-first with separate deadlines and no ambassador or channel picker', async () => {
  const { context, run } = await frontend();
  context.capture = (html) => { context.taskHtml = html; };
  run(`state.user = { id: 'staff', name: 'Staff User', role: 'employee' };
    showModal = capture; createTask();`);
  const html = context.taskHtml;
  assert.match(html, /id="task-form"/);
  for (const name of ['productUrl', 'promotionCount', 'subject', 'description', 'acceptBy', 'dueDate']) assert.ok(html.includes(`name="${name}"`));
  for (const name of ['productId', 'ambassadorId', 'channel']) assert.ok(!html.includes(`name="${name}"`));
  assert.match(html, /Hent produktinfo/);
  assert.match(html, /Idé eller instruksjoner/);
  assert.match(html, /Hvor mange ambassadører kan promotere dette produktet\?/);
  assert.match(html, /name="promotionCount" type="number"[^>]*value="1"/);
  assert.match(run('ticketsPage()'), /data-action="create-task"/);
  run('state.user.role = "ambassador";');
  assert.ok(!run('ticketsPage()').includes('data-action="create-task"'));
});

test('ambassador URL-based promotion requests default to one instance and cap quantity without a catalogue', async () => {
  const { context, run } = await frontend();
  context.capture = (html) => { context.requestHtml = html; };
  run(`state.user = { id: 'emil', role: 'ambassador' };
    state.products = [];
    showModal = capture; requestPromotion();`);
  const quantityPosition = context.requestHtml.indexOf('class="field promotion-quantity"');
  const productUrlPosition = context.requestHtml.indexOf('name="productUrl"');
  assert.ok(productUrlPosition >= 0 && productUrlPosition < quantityPosition);
  assert.doesNotMatch(context.requestHtml, /name="productId"|data-product=/);
  assert.match(context.requestHtml, /data-action="preview-product"/);
  assert.match(context.requestHtml, /name="promotionCount" type="number"[^>]*min="1" max="50" step="1" value="1"/);
  assert.match(context.requestHtml, /Hvor mange promoteringer ønsker du\?/);
  assert.match(context.requestHtml, /Standard er 1/);
  assert.match(run('ticketsPage()'), /data-action="new-promotion"/);
});

test('open tasks show fetched products and both deadlines without a conversation or platform requirement', async () => {
  const { context, run } = await frontend();
  context.capture = (html) => { context.detailHtml = html; };
  run(`state.user = { id: 'emil', role: 'ambassador' };
    state.users = [{ id: 'staff', name: 'Staff Contact', role: 'employee' }];
    state.tickets = [{ id: 'task-1', number: 1001, subject: 'Creative idea', description: 'Our input',
      productId: null, productUrl: 'https://www.olbrygging.no/produkt/test',
      productSnapshot: { name: 'Fetched product', description: 'Product description', image: 'https://cdn.example/product.jpg', price: 250, currency: 'NOK' },
      ambassadorId: '', assigneeId: 'staff', status: 'available', channel: '', acceptBy: '2028-01-01', dueDate: '2028-01-14', messages: [] }];
    showModal = capture; ticketDetail('task-1');`);
  assert.match(context.detailHtml, /Fetched product/);
  assert.match(context.detailHtml, /Product description/);
  assert.match(context.detailHtml, /cdn\.example\/product\.jpg/);
  assert.match(context.detailHtml, /250 NOK/);
  assert.match(context.detailHtml, /Frist for å melde interesse/);
  assert.match(context.detailHtml, /Publiseringsfrist/);
  assert.match(context.detailHtml, /Aksepter oppgaven/);
  assert.ok(!context.detailHtml.includes('id="message-form"'));
  run('state.user.role = "employee"; ticketDetail("task-1");');
  assert.ok(!context.detailHtml.includes('data-action="accept-task"'));
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
  for (const label of ['Instagram', 'Facebook', 'TikTok', 'X (Twitter)', 'Bluesky', 'YouTube']) assert.ok(html.includes(`>${label}</label>`));
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

test('a completed content upload preserves the conversation draft and cursor', async () => {
  const { context, run, elements, listeners } = await frontend();
  context.FormData = class {};
  const button = { disabled: false };
  const error = { textContent: '' };
  const form = {
    id: 'content-form', dataset: { ticketId: 'ticket-1' }, isConnected: true,
    querySelector: (selector) => selector === '[type=submit]' ? button : selector === '.error' ? error : null,
  };
  const composer = { value: 'Original draft', selectionStart: 0, selectionEnd: 0 };
  elements['#message-body'] = composer;
  elements['[name=sendEmail]'] = { checked: true };
  context.document.activeElement = composer;
  run("state.user = {id:'emil', role:'ambassador'}; modalTicketId = 'ticket-1';");
  context.rebuild = (_id, draft) => {
    elements['#message-body'] = {
      value: draft, focus() { context.document.activeElement = this; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    };
    elements['[name=sendEmail]'] = { checked: false };
  };
  run('ticketDetail = rebuild;');
  let resolve;
  context.fetch = async (url) => url.endsWith('/submissions')
    ? new Promise((done) => { resolve = done; })
    : { ok: true, json: async () => ({ user: { id: 'emil', role: 'ambassador' }, tickets: [] }) };
  const pending = listeners.submit({ target: form, preventDefault() {} });
  composer.value = 'A newer conversation draft';
  composer.selectionStart = 3;
  composer.selectionEnd = 8;
  resolve({ ok: true, json: async () => ({ submission: {} }) });
  await pending;
  assert.equal(elements['#message-body'].value, 'A newer conversation draft');
  assert.equal(elements['#message-body'].selectionStart, 3);
  assert.equal(elements['#message-body'].selectionEnd, 8);
  assert.equal(elements['[name=sendEmail]'].checked, true);
  assert.equal(button.disabled, false);
});

test('a late content upload cannot reopen a closed dialog or refresh a different account', async () => {
  for (const switched of [false, true]) {
    const { context, run, listeners } = await frontend();
    context.FormData = class {};
    const button = { disabled: false };
    const form = {
      id: 'content-form', dataset: { ticketId: 'ticket-1' }, isConnected: true,
      querySelector: (selector) => selector === '[type=submit]' ? button : { textContent: '' },
    };
    run("state.user = {id:'emil', role:'ambassador'}; modalTicketId = 'ticket-1';");
    context.rebuild = () => { throw new Error('A closed dialog must not reopen'); };
    run('ticketDetail = rebuild;');
    let resolve;
    let requests = 0;
    context.fetch = async (url) => {
      requests++;
      if (url.endsWith('/submissions')) return new Promise((done) => { resolve = done; });
      return { ok: true, json: async () => ({ user: { id: 'emil', role: 'ambassador' }, tickets: [] }) };
    };
    const pending = listeners.submit({ target: form, preventDefault() {} });
    form.isConnected = false;
    run(switched ? "authVersion++; state.user = {id:'nora', role:'employee'}; modalTicketId = null;" : 'modalTicketId = null;');
    resolve({ ok: true, json: async () => ({ submission: {} }) });
    await pending;
    assert.equal(requests, switched ? 1 : 2);
    if (switched) assert.equal(run('state.user.id'), 'nora');
    assert.equal(button.disabled, false);
  }
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
      id: 'ticket-1', number: 1001, displayNumber: '1001-2', subject: 'Produktguide', status: 'approved',
      channel: 'Instagram', dueDate: null, ambassadorId: 'emil', productId: 'demo',
      productUrl: 'https://www.olbrygging.no/produkt/ekte-produkt',
      productSnapshot: { name: 'Ekte produkt', image: 'https://cdn.example/produkt.jpg', price: 129.5, currency: 'NOK', description: 'Frisk <b>råvare</b>' },
    }];`);
  const row = run('ticketTable(state.tickets)');
  assert.match(row, /href="https:\/\/www\.olbrygging\.no\/produkt\/ekte-produkt"/);
  assert.match(row, /src="https:\/\/cdn\.example\/produkt\.jpg"/);
  assert.match(row, /129,5 NOK/);
  assert.match(row, /#1001-2/);
  assert.match(row, /Frisk &lt;b&gt;råvare&lt;\/b&gt;/);
  assert.match(row, /mobile-ticket-card/);
  assert.match(row, /Åpne samarbeid/);
  assert.equal(run("productLink('https://evil.example/product')"), '');
});

test('task content panel presents upload, review history, previews and publication controls by role', async () => {
  const { context, run } = await frontend();
  context.capture = (html) => { context.dialog = html; };
  run(`state.user = { id: 'emil', name: 'Emil', role: 'ambassador' };
    state.users = [{ id: 'emil', name: 'Emil', role: 'ambassador' }, { id: 'nora', name: 'Nora', role: 'employee' }];
    state.tickets = [{ id: 'ticket-1', number: 1, subject: 'Innhold', status: 'in_progress',
      ambassadorId: 'emil', assigneeId: 'nora', channel: 'Instagram', dueDate: null, messages: [], submissions: [] }];
    showModal = capture;`);
  let html = run('contentPanel(state.tickets[0])');
  assert.match(html, /id="content-form"/);
  assert.match(html, /name="files" type="file"[^>]*multiple required/);
  assert.match(html, /name="caption"/);
  assert.match(html, /name="link"/);
  assert.doesNotMatch(html, /id="publication-form"/);

  run(`state.user.role = 'employee';
    state.tickets[0].status = 'review';
    state.tickets[0].submissions = [{ id: 'submission-1', version: 1, status: 'submitted', caption: '<b>Trygt</b>',
      link: 'https://example.invalid/draft', createdAt: '2026-11-02T12:00:00.000Z',
      files: [{ name: 'draft.mp4', type: 'video/mp4' }] }];
    ticketDetail('ticket-1');`);
  html = context.dialog;
  assert.match(html, /<video controls[^>]+\/api\/submissions\/submission-1\/files\/draft\.mp4/);
  assert.match(html, /&lt;b&gt;Trygt&lt;\/b&gt;/);
  assert.match(html, /data-content-decision="approved"/);
  assert.match(html, /data-content-decision="changes_requested"/);
  assert.match(html, /id="ticket-status" data-update="status" disabled/);
  assert.match(run('ticketsPage()'), /Innhold til vurdering/);

  run(`state.user.role = 'ambassador'; state.tickets[0].status = 'in_progress';
    state.tickets[0].submissions[0].status = 'changes_requested';
    state.tickets[0].submissions[0].feedback = 'Vis produktet tydeligere';
    state.tickets[0].submissions[0].reviewerId = 'nora';`);
  html = run('contentPanel(state.tickets[0])');
  assert.match(html, /Send inn ny versjon/);
  assert.match(html, /Vis produktet tydeligere/);
  assert.doesNotMatch(html, /data-content-decision/);
  run("state.tickets[0].submissions[0].status = 'approved';");
  html = run('contentPanel(state.tickets[0])');
  assert.match(html, /id="publication-form"/);
  assert.doesNotMatch(html, /id="content-form"/);

  run("state.user.role = 'employee'; ticketDetail('ticket-1');");
  assert.doesNotMatch(context.dialog, /<option value="completed"/);
  run("state.tickets[0].publicationUrl = 'https://example.invalid/post'; ticketDetail('ticket-1');");
  assert.match(context.dialog, /<option value="completed"/);
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
