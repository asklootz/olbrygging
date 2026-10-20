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
