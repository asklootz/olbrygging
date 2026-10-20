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
