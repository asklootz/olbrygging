import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url));

function worker() {
  const listeners = {};
  const entries = new Map();
  const removed = [];
  const requests = [];
  const cache = {
    addAll: async (paths) => { paths.forEach((path) => entries.set(path, { path })); },
    match: async (path) => entries.get(path),
  };
  const context = createContext({
    URL,
    self: {
      location: { origin: 'https://portal.example' },
      addEventListener: (name, listener) => { listeners[name] = listener; },
    },
    caches: {
      open: async () => cache,
      keys: async () => ['olbrygging-shell-v0', 'olbrygging-shell-v1', 'unrelated-cache'],
      delete: async (name) => { removed.push(name); },
    },
    fetch: async (request) => { requests.push(request); return { network: true }; },
  });
  runInContext(read('sw.js').toString(), context);
  const dispatch = async (name, event = {}) => {
    let result;
    listeners[name]({ ...event, waitUntil: (promise) => { result = promise; }, respondWith: (promise) => { result = promise; } });
    return result;
  };
  return { dispatch, entries, removed, requests };
}

test('manifest and shell provide installable icons and never precache private data', async () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.id, '/');
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const png = read(icon.src.slice(1));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
  const { dispatch, entries, removed } = worker();
  await dispatch('install');
  for (const path of entries.keys()) {
    assert.ok(!path.startsWith('/api'));
    assert.ok(read(path === '/' ? 'index.html' : path.slice(1)).length);
  }
  await dispatch('activate');
  assert.deepEqual(removed, ['olbrygging-shell-v0']);
  const html = read('index.html').toString();
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /viewport-fit=cover/);
});

test('worker serves the matching shell offline but leaves API, writes and external requests alone', async () => {
  const { dispatch, requests } = worker();
  await dispatch('install');
  const request = (path, method = 'GET') => ({ url: new URL(path, 'https://portal.example').href, method });
  assert.deepEqual(await dispatch('fetch', { request: request('/?installed=1') }), { path: '/' });
  assert.deepEqual(await dispatch('fetch', { request: request('/app.js') }), { path: '/app.js' });
  for (const req of [request('/api/workspace'), request('/api/session'), request('/api/login', 'POST'), request('/app.js', 'POST'), request('/private'), request('https://other.example/app.js')]) {
    assert.equal(await dispatch('fetch', { request: req }), undefined);
  }
  assert.equal(requests.length, 0);
});

test('shell cache misses fall back to the network without caching responses', async () => {
  const { dispatch, entries, requests } = worker();
  const response = await dispatch('fetch', { request: { url: 'https://portal.example/styles.css', method: 'GET' } });
  assert.equal(response.network, true);
  assert.equal(requests.length, 1);
  assert.equal(entries.size, 0);
});

test('connection feedback follows offline/online events even without service worker support', async () => {
  const status = { hidden: true };
  const listeners = {};
  const navigator = { onLine: false };
  const context = createContext({
    document: { querySelector: () => status },
    navigator,
    window: { addEventListener: (name, listener) => { listeners[name] = listener; } },
    console,
  });
  runInContext(read('pwa.js').toString(), context);
  assert.equal(status.hidden, false);
  navigator.onLine = true;
  listeners.online();
  assert.equal(status.hidden, true);
  navigator.onLine = false;
  listeners.offline();
  assert.equal(status.hidden, false);
});

test('worker registration failures do not break the app', async () => {
  const errors = [];
  let registered;
  runInContext(read('pwa.js').toString(), createContext({
    document: { querySelector: () => ({}) },
    navigator: { serviceWorker: { register: async (path) => { registered = path; throw new Error('Unavailable'); } } },
    window: { addEventListener: () => {} },
    console: { warn: (...args) => errors.push(args) },
  }));
  await new Promise(setImmediate);
  assert.equal(registered, '/sw.js');
  assert.equal(errors.length, 1);
});
