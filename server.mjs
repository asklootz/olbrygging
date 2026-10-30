import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, text, dateValue, checkFields, readBody } from './api.mjs';
import { createPocketbaseApi } from './pocketbase.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATUSES = ['available', 'requested', 'approved', 'in_progress', 'review', 'completed', 'declined'];
const CHANNELS = ['Instagram', 'TikTok', 'YouTube', 'Blogg', 'Annet'];
const COOKIE = 'olbrygging_session';
const SESSION_MS = 1000 * 60 * 60 * 12;
const safeUser = ({ id, name, email, role, active, socialMedia }) => ({
  id, name, email, role, active: active !== false, socialMedia: socialMedia || '',
});
const digest = (value) => createHash('sha256').update(value).digest('hex');

function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function validPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function seed() {
  const now = new Date();
  const at = (days) => new Date(now.getTime() + days * 86400000).toISOString();
  const user = (id, name, email, role) => ({
    id, name, email, role, active: true, socialMedia: '', passwordHash: passwordHash('BrewTogether!2026'),
  });
  const users = [
    user('carsten', 'Carsten', 'admin@olbrygging.example', 'admin'),
    user('nora', 'Nora Berg', 'employee@olbrygging.example', 'employee'),
    user('marius', 'Marius Dahl', 'marius@olbrygging.example', 'employee'),
    user('emil', 'Emil Hansen', 'ambassador@olbrygging.example', 'ambassador'),
    user('sara', 'Sara Lund', 'sara@olbrygging.example', 'ambassador'),
  ];
  const products = [
    { id: 'fjord-pale', name: 'Fjordglød Pale Ale', category: 'Ølsett', description: 'Friskt allgrain-sett med sitrus, norsk bryggeglede og en gyllen avslutning. 20 liter.', price: 449 },
    { id: 'skog-ipa', name: 'Skogbris IPA', category: 'Ølsett', description: 'Et aromatisk ølsett med tropiske toner og en tydelig, balansert bitterhet. 20 liter.', price: 529 },
    { id: 'kveld-pils', name: 'Lys kveld Pilsner', category: 'Ølsett', description: 'Ren og lettdrikkelig pilsner til lange sommerkvelder. 20 liter.', price: 399 },
    { id: 'brew-kettle', name: 'Bryggekjele 30 L', category: 'Bryggeutstyr', description: 'Solid rustfri bryggekjele med tappekran og tydelig literskala.', price: 1890 },
    { id: 'fermenter', name: 'Gjæringskar 30 L', category: 'Bryggeutstyr', description: 'Praktisk gjæringskar med gjærlås, lokk og tappekran.', price: 349 },
    { id: 'hop-citra', name: 'Citra humle 100 g', category: 'Råvarer', description: 'Pelletshumle med frisk sitrus, pasjonsfrukt og et tropisk løft.', price: 109 },
    { id: 'malt', name: 'Pale Ale malt 5 kg', category: 'Råvarer', description: 'En allsidig basemalt med lett brødpreg til ditt neste hjemmebrygg.', price: 189 },
    { id: 'glass', name: 'Smaksglass, 2-pakning', category: 'Tilbehør', description: 'Tulipanformede glass som gir plass til både aroma og skumkrone.', price: 249 },
  ].map((product) => ({ ...product, available: true }));
  const ticket = (id, number, subject, description, productId, status, channel, messages, ambassadorId = 'emil') => ({
    id, number, subject, description, productId, ambassadorId, assigneeId: 'nora',
    status, channel, dueDate: at(14 + number - 1000).slice(0, 10),
    createdAt: at(-8), updatedAt: at(-1),
    messages: messages.map(([authorId, body], index) => ({
      id: `${id}-message-${index}`, authorId, body, createdAt: at(-7 + index), emailStatus: 'not_requested',
    })),
  });
  return {
    version: 2, users, products,
    articles: [
      { id: 'article-1', title: 'Slik merker du reklameinnhold', category: 'Innhold', body: 'Merk samarbeid tydelig som reklame eller annonse. Plasser merkingen slik at den er synlig før følgeren åpner eller leser innholdet.', authorId: 'nora', createdAt: at(-20), updatedAt: at(-2) },
      { id: 'article-2', title: 'Ta vare på humle og malt', category: 'Bryggetips', body: 'Oppbevar råvarer tørt, kjølig og lufttett. Humle holder best på aromaen når den skjermes fra lys og oksygen.', authorId: 'marius', createdAt: at(-12), updatedAt: at(-3) },
    ],
    damageReports: [],
    tickets: [
      ticket('ticket-1001', 1001, 'Fra korn til glass – en liten bryggereise', 'Jeg vil lage en varm og ærlig bildeserie om mitt første brygg med Fjordglød. Demoforespørsel.', 'fjord-pale', 'in_progress', 'Instagram', [
        ['emil', 'Hei Nora! Jeg tenker tre innlegg: bryggedagen, gjæringen og den første smaken. Hva tror du?'],
        ['nora', 'Det høres veldig fint ut! Vis gjerne frem råvarene og fortell hva du lærer underveis. Settet er godkjent.'],
        ['emil', 'Supert, bryggedagen er i boks. Jeg sender et utkast før publisering.'],
      ]),
      ticket('ticket-1002', 1002, 'En enklere bryggedag med riktig utstyr', 'En kort demonstrasjon av kjelen og mine beste tips for en ryddig bryggedag. Demoinnhold.', 'brew-kettle', 'approved', 'YouTube', [
        ['emil', 'Kan vi vise hvordan tappekranen gjør overføringen enklere?'],
        ['nora', 'Ja! Forespørselen er godkjent. Husk å merke innholdet tydelig som reklame.'],
      ]),
      ticket('ticket-1003', 1003, 'Humleskolen: bli kjent med Citra', 'En kort video med fokus på aroma, oppbevaring og tørrhumling. Demoforespørsel.', 'hop-citra', 'review', 'TikTok', [
        ['emil', 'Første utkast er klart! Jeg forklarer forskjellen på bitterhumle og aromahumle.'],
        ['nora', 'Fin og tydelig forklaring. Jeg ser gjennom teksten og kommer tilbake til deg.'],
      ]),
      ticket('ticket-1004', 1004, 'Sommerkveld med en lys pilsner', 'Jeg ønsker å dele en rolig bryggedag og en enkel oppskriftspresentasjon. Demoforespørsel.', 'kveld-pils', 'requested', 'Instagram', [
        ['emil', 'Hei! Passer dette settet til et innlegg om temperaturkontroll under gjæring?'],
      ]),
      ticket('ticket-1005', 1005, 'Smaksglass til bryggeklubben', 'Bilder av glassene og en guide til aroma. Dette er en separat demokonto.', 'glass', 'requested', 'Blogg', [
        ['sara', 'Jeg vil gjerne fotografere glassene til en enkel aromaguide.'],
      ], 'sara'),
    ],
  };
}

function productPageUrl(value) {
  const raw = text(value, 'Produktlenke', 2000);
  let url;
  try { url = new URL(raw); } catch { throw new ApiError(400, 'Oppgi en gyldig produktlenke fra olbrygging.no.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.olbrygging.no' || url.port || url.username || url.password || url.pathname === '/') {
    throw new ApiError(400, 'Produktlenken må være en HTTPS-side på www.olbrygging.no.');
  }
  url.hash = '';
  return url;
}

function htmlValue(value = '') {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|quot|apos|lt|gt);/gi, (entity, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[code.toLowerCase()] ?? entity;
  }).trim();
}

function tagAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes[match[1].toLowerCase()] = htmlValue(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function productFromHtml(html, url) {
  const metadata = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0]);
    const key = (attributes.property || attributes.name || attributes.itemprop || '').toLowerCase();
    if (key && attributes.content) metadata.set(key, attributes.content);
  }
  const structured = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    if (!/application\/ld\+json/i.test(tagAttributes(`<script ${match[1]}>`).type || '')) continue;
    try {
      const parsed = JSON.parse(match[2]);
      const visit = (value) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== 'object') return;
        const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
        if (types.some((type) => type === 'Product')) structured.push(value);
        Object.values(value).forEach(visit);
      };
      visit(parsed);
    } catch { /* Ignore invalid structured data and use page metadata instead. */ }
  }
  const product = structured[0] || {};
  const offer = Array.isArray(product.offers) ? product.offers[0] || {} : product.offers || {};
  const imageValue = Array.isArray(product.image) ? product.image[0] : product.image;
  const image = metadata.get('og:image') || metadata.get('twitter:image') || (typeof imageValue === 'string' ? imageValue : imageValue?.url);
  let imageUrl = null;
  if (typeof image === 'string' && image.trim()) {
    try {
      const parsedImage = new URL(image, url);
      if (parsedImage.protocol === 'https:' && !parsedImage.username && !parsedImage.password) imageUrl = parsedImage.href;
    } catch { /* An invalid or absent image is optional. */ }
  }
  const priceValue = [metadata.get('product:price:amount'), offer.price, offer.lowPrice]
    .find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  const normalizedPrice = String(priceValue ?? '').trim().replace(',', '.');
  const numericPrice = normalizedPrice ? Number(normalizedPrice) : NaN;
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const name = product.name || metadata.get('og:title') || metadata.get('twitter:title') || titleTag;
  if (!name) throw new ApiError(422, 'Fant ikke produktinformasjon på siden. Kontroller at lenken peker til et produkt.');
  return {
    url: url.href,
    name: htmlValue(String(name)).slice(0, 300),
    description: htmlValue(String(product.description || metadata.get('og:description') || metadata.get('description') || '')).slice(0, 2000),
    price: Number.isFinite(numericPrice) && numericPrice >= 0 ? numericPrice : null,
    currency: metadata.get('product:price:currency') || offer.priceCurrency || null,
    image: imageUrl,
  };
}

async function readLimited(response, limit) {
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body) > limit) throw new ApiError(422, 'Produktsiden er for stor til å lese.');
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(422, 'Produktsiden er for stor til å lese.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function readProductPage(value, fetchProductPage) {
  const url = productPageUrl(value);
  try {
    const response = await fetchProductPage(url.href, {
      redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { Accept: 'text/html' },
    });
    if (!response.ok || response.status >= 300) throw new ApiError(422, 'Kunne ikke hente produktsiden. Kontroller lenken og prøv igjen.');
    if (!/^text\/html\b/i.test(response.headers.get('content-type') || '')) {
      throw new ApiError(422, 'Lenken peker ikke til en produktside.');
    }
    const html = await readLimited(response, 1024 * 1024);
    return productFromHtml(html, url);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, 'Kunne ikke hente produktinformasjonen. Kontroller lenken og prøv igjen.');
  }
}

export function createApp(options = {}) {
  const dataFile = resolve(options.dataFile ?? process.env.DATA_FILE ?? resolve(ROOT, 'data/workspace.json'));
  const publicDir = resolve(options.publicDir ?? resolve(ROOT, 'public'));
  const emailApiKey = options.emailApiKey ?? process.env.RESEND_API_KEY;
  const emailFrom = options.emailFrom ?? process.env.EMAIL_FROM;
  const emailConfigured = Boolean(emailApiKey && emailFrom);
  const emailTimeoutMs = options.emailTimeoutMs ?? 8000;
  const fetchEmail = options.fetchEmail ?? globalThis.fetch;
  const fetchProductPage = options.fetchProductPage ?? globalThis.fetch;
  const fetchProductDetails = (value) => readProductPage(value, fetchProductPage);
  const secureCookies = options.secureCookies ?? process.env.COOKIE_SECURE === 'true';
  const pocketbase = createPocketbaseApi({
    url: options.pocketbaseUrl ?? process.env.POCKETBASE_URL ?? 'http://127.0.0.1:8090',
    adminEmail: options.pocketbaseAdminEmail ?? process.env.POCKETBASE_ADMIN_EMAIL,
    adminPassword: options.pocketbaseAdminPassword ?? process.env.POCKETBASE_ADMIN_PASSWORD,
    fetch: options.fetchPocketbase ?? globalThis.fetch,
    timeoutMs: options.pocketbaseTimeoutMs ?? 8000,
    secureCookies, emailApiKey, emailFrom, emailTimeoutMs, fetchEmail,
    readProductPage: fetchProductDetails,
  });
  if (process.env.NODE_ENV === 'production' && (!pocketbase || !secureCookies)) {
    throw new Error('Production requires PocketBase and COOKIE_SECURE=true.');
  }
  const sessions = new Map();
  const attempts = new Map();
  const applicationAttempts = new Map();
  let mutationQueue = Promise.resolve();

  const persist = (next) => {
    mkdirSync(dirname(dataFile), { recursive: true });
    const pending = `${dataFile}.${randomBytes(8).toString('hex')}.pending`;
    writeFileSync(pending, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(pending, dataFile);
  };
  let state;
  if (pocketbase) {
    state = null;
  } else if (existsSync(dataFile)) {
    state = JSON.parse(readFileSync(dataFile, 'utf8'));
    if (![1, 2].includes(state.version) || !['users', 'products', 'tickets'].every((key) => Array.isArray(state[key]))) {
      throw new Error('Unsupported workspace data format.');
    }
    state.articles ??= [];
    state.damageReports ??= [];
    state.users = state.users.map((user) => ({ active: true, socialMedia: '', ...user }));
    state.version = 2;
    persist(state);
  } else {
    state = seed();
    persist(state);
  }
  const commit = (next) => {
    persist(next);
    state = next;
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const currentUser = (req) => {
    const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    if (!cookie) return null;
    const token = cookie.slice(COOKIE.length + 1);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const key = digest(token);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    const user = state.users.find((item) => item.id === session.userId);
    return user?.active === false ? null : user ?? null;
  };
  const cookieValue = (token, age) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookies ? '; Secure' : ''}`;
  const authorizedTicket = (id, user) => {
    const ticket = state.tickets.find((item) => item.id === id);
    const availableTask = ticket?.status === 'available' && !ticket.ambassadorId
      && ticket.acceptBy >= new Date().toISOString().slice(0, 10);
    if (!ticket || (user.role === 'ambassador' && ticket.ambassadorId !== user.id && !availableTask)) {
      throw new ApiError(404, 'Fant ikke forespørselen.');
    }
    return ticket;
  };
  const updateProfile = (user, body, allowed = ['name', 'email', 'socialMedia']) => {
    checkFields(body, allowed);
    if (!Object.keys(body).length) throw new ApiError(400, 'Ingen endringer er oppgitt.');
    const updated = { ...user };
    if (body.name !== undefined) updated.name = text(body.name, 'Navn', 100);
    if (body.email !== undefined) {
      updated.email = text(body.email, 'E-post', 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updated.email)) throw new ApiError(400, 'Oppgi en gyldig e-postadresse.');
      if (state.users.some((item) => item.id !== user.id && item.email.toLowerCase() === updated.email)) throw new ApiError(409, 'E-postadressen er allerede i bruk.');
    }
    if (body.socialMedia !== undefined) updated.socialMedia = text(body.socialMedia, 'Sosiale medier', 200, { optional: true, min: 0 }) || '';
    return updated;
  };

  async function api(req, res, pathname) {
    const method = req.method;
    const known = ['/api/config', '/api/session', '/api/login', '/api/logout', '/api/workspace', '/api/tickets', '/api/articles', '/api/damage-reports', '/api/profile', '/api/users'].includes(pathname)
      || pathname === '/api/products/preview' || pathname === '/api/ambassador-applications' || pathname === '/api/tasks'
      || /^\/api\/tickets\/[a-zA-Z0-9_-]{1,100}(?:\/messages|\/accept)?$/.test(pathname)
      || /^\/api\/(articles|damage-reports|users)\/[a-zA-Z0-9_-]{1,100}$/.test(pathname);
    if (!known) throw new ApiError(404, 'Ukjent API-endepunkt.');
    const allowed = ['/api/config', '/api/session', '/api/workspace'].includes(pathname) ? ['GET']
      : pathname === '/api/articles' || pathname === '/api/users' ? ['GET', 'POST']
        : pathname === '/api/damage-reports' || pathname === '/api/login' || pathname === '/api/logout' || pathname === '/api/tasks' || /\/accept$/.test(pathname) ? ['POST']
          : pathname === '/api/profile' || /^\/api\/tickets\/[^/]+$/.test(pathname) || /^\/api\/(articles|damage-reports|users)\/[^/]+$/.test(pathname) ? ['PATCH'] : ['POST'];
    if (!allowed.includes(method)) {
      res.setHeader('Allow', allowed.join(', '));
      throw new ApiError(405, 'Metoden er ikke tillatt.');
    }
    if (method !== 'GET') {
      const protocol = secureCookies ? 'https' : 'http';
      if (!req.headers.origin || req.headers.origin !== `${protocol}://${req.headers.host}`
        || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new ApiError(403, 'Forespørselen må komme fra samme nettsted.');
      }
    }
    if (pathname === '/api/config') return json(res, 200, { demoMode: !pocketbase });
    if (pathname === '/api/ambassador-applications') {
      if (!pocketbase) throw new ApiError(503, 'Søknader krever PocketBase. Bruk den ordinære portalen, ikke den lokale demoen.');
      const now = Date.now();
      for (const [key, value] of applicationAttempts) if (value.until <= now) applicationAttempts.delete(key);
      // Do not trust caller-supplied forwarding headers as a rate-limit key.
      const key = req.socket.remoteAddress;
      const attempt = applicationAttempts.get(key) || { count: 0, until: now + 900000 };
      if (attempt.count >= 10 || (!applicationAttempts.has(key) && applicationAttempts.size >= 5000)) {
        res.setHeader('Retry-After', '900');
        throw new ApiError(429, 'For mange søknadsforsøk. Prøv igjen om 15 minutter.');
      }
      attempt.count++;
      applicationAttempts.set(key, attempt);
    }
    if (pocketbase) {
      const { status, body } = await pocketbase(req, res, pathname);
      return json(res, status, body);
    }
    const user = currentUser(req);
    if (pathname === '/api/session') return json(res, 200, { user: user ? safeUser(user) : null });
    if (pathname === '/api/login') {
      const body = await readBody(req);
      checkFields(body, ['email', 'password']);
      const email = text(body.email, 'E-post', 254).toLowerCase();
      const password = text(body.password, 'Passord', 256);
      const key = `${req.socket.remoteAddress}:${email}`;
      const attempt = attempts.get(key);
      if (attempt && attempt.until > Date.now() && attempt.count >= 10) throw new ApiError(429, 'For mange forsøk. Prøv igjen om 15 minutter.');
      const found = state.users.find((item) => item.email.toLowerCase() === email);
      // Do password work for unknown accounts too, without disclosing whether an email exists.
      const match = validPassword(password, found?.passwordHash ?? state.users[0].passwordHash);
      if (!found || found.active === false || !match) {
        attempts.set(key, { count: attempt && attempt.until > Date.now() ? attempt.count + 1 : 1, until: Date.now() + 900000 });
        if (attempts.size > 5000) {
          for (const [id, value] of attempts) if (value.until <= Date.now()) attempts.delete(id);
          if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
        }
        throw new ApiError(401, 'Feil e-post eller passord.');
      }
      attempts.delete(key);
      for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
      const token = randomBytes(32).toString('hex');
      sessions.set(digest(token), { userId: found.id, expiresAt: Date.now() + SESSION_MS });
      res.setHeader('Set-Cookie', cookieValue(token, SESSION_MS / 1000));
      return json(res, 200, { user: safeUser(found) });
    }
    if (!user) throw new ApiError(401, 'Logg inn for å fortsette.');
    if (pathname === '/api/logout') {
      const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
      if (cookie) sessions.delete(digest(cookie.slice(COOKIE.length + 1)));
      res.setHeader('Set-Cookie', cookieValue('', 0));
      return json(res, 200, { user: null });
    }
    if (pathname === '/api/workspace') {
      const today = new Date().toISOString().slice(0, 10);
      const tickets = state.tickets.filter((ticket) => user.role !== 'ambassador' || ticket.ambassadorId === user.id
        || ticket.status === 'available' && !ticket.ambassadorId && ticket.acceptBy >= today);
      const staff = user.role !== 'ambassador';
      const relevant = new Set([user.id, ...state.users.filter((item) => item.role === 'employee').map((item) => item.id)]);
      for (const ticket of tickets) {
        relevant.add(ticket.ambassadorId);
        relevant.add(ticket.assigneeId);
        for (const message of ticket.messages) relevant.add(message.authorId);
      }
      return json(res, 200, {
        user: safeUser(user), products: state.products, tickets,
        users: state.users.filter((item) => user.role === 'admin' || item.role === 'employee' || staff && item.role === 'ambassador' || relevant.has(item.id)).map(safeUser),
        articles: state.articles,
        damageReports: state.damageReports.filter((item) => staff || item.ambassadorId === user.id),
        emailConfigured,
      });
    }
    if (pathname === '/api/articles' && method === 'GET') return json(res, 200, { articles: state.articles });
    if (pathname === '/api/users' && method === 'GET') {
      if (user.role !== 'admin') throw new ApiError(403, 'Bare administratorer kan administrere brukere.');
      return json(res, 200, { users: state.users.map(safeUser) });
    }
    if (pathname === '/api/profile') {
      const body = await readBody(req);
      const updated = updateProfile(user, body);
      commit({ ...state, users: state.users.map((item) => item.id === user.id ? updated : item) });
      return json(res, 200, { user: safeUser(updated) });
    }
    const body = await readBody(req);
    if (pathname === '/api/products/preview') {
      checkFields(body, ['url']);
      return json(res, 200, { product: await fetchProductDetails(body.url) });
    }
    if (pathname === '/api/tasks') {
      if (!['admin', 'employee'].includes(user.role)) throw new ApiError(403, 'Bare ansatte kan opprette åpne oppgaver.');
      checkFields(body, ['productUrl', 'subject', 'description', 'acceptBy', 'dueDate']);
      const snapshot = await fetchProductDetails(body.productUrl);
      const subject = text(body.subject, 'Oppgavenavn', 160);
      const description = text(body.description, 'Idé eller instruksjoner', 5000);
      const acceptBy = dateValue(body.acceptBy);
      const dueDate = dateValue(body.dueDate);
      const today = new Date().toISOString().slice(0, 10);
      if (!acceptBy || !dueDate || acceptBy < today || dueDate < acceptBy) {
        throw new ApiError(400, 'Velg en frist for å melde interesse i dag eller senere, og en publiseringsfrist etter denne.');
      }
      const employeeId = user.role === 'employee' ? user.id : state.users.find((item) => item.role === 'employee')?.id;
      if (!employeeId) throw new ApiError(409, 'Ingen medarbeider er tilgjengelig.');
      const number = Math.max(1000, ...state.tickets.map((ticket) => ticket.number)) + 1;
      const ticket = {
        id: randomUUID(), number, subject, description, productId: null,
        productUrl: snapshot.url, productSnapshot: snapshot, ambassadorId: '', assigneeId: employeeId,
        status: 'available', channel: '', acceptBy, dueDate,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [],
      };
      commit({ ...state, tickets: [...state.tickets, ticket] });
      return json(res, 201, { ticket });
    }
    if (pathname === '/api/users') {
      if (user.role !== 'admin') throw new ApiError(403, 'Bare administratorer kan administrere brukere.');
      checkFields(body, ['name', 'email', 'password', 'role']);
      const name = text(body.name, 'Navn', 100);
      const email = text(body.email, 'E-post', 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Oppgi en gyldig e-postadresse.');
      if (state.users.some((item) => item.email.toLowerCase() === email)) throw new ApiError(409, 'E-postadressen er allerede i bruk.');
      const password = text(body.password, 'Passord', 128, { min: 12 });
      if (!['employee', 'ambassador'].includes(body.role)) throw new ApiError(400, 'Velg ansatt eller ambassadør.');
      const created = { id: randomUUID(), name, email, role: body.role, active: true, socialMedia: '', passwordHash: passwordHash(password) };
      commit({ ...state, users: [...state.users, created] });
      return json(res, 201, { user: safeUser(created) });
    }
    if (/^\/api\/users\/[^/]+$/.test(pathname)) {
      if (!['admin', 'employee'].includes(user.role)) throw new ApiError(403, 'Du har ikke tilgang til å endre profiler.');
      const id = pathname.split('/')[3];
      const target = state.users.find((item) => item.id === id);
      if (!target || (user.role === 'employee' && target.role !== 'ambassador')) throw new ApiError(404, 'Fant ikke profilen.');
      const allowedFields = user.role === 'admin' ? ['name', 'email', 'socialMedia', 'role', 'active'] : ['name', 'email', 'socialMedia'];
      checkFields(body, allowedFields);
      const profileFields = Object.fromEntries(Object.entries(body).filter(([field]) => ['name', 'email', 'socialMedia'].includes(field)));
      const profile = Object.keys(profileFields).length ? updateProfile(target, profileFields) : { ...target };
      if (body.role !== undefined) {
        if (!['employee', 'ambassador'].includes(body.role)) throw new ApiError(400, 'Velg ansatt eller ambassadør.');
        profile.role = body.role;
      }
      if (body.active !== undefined) {
        if (typeof body.active !== 'boolean') throw new ApiError(400, 'Aktiv-status må være ja eller nei.');
        if (target.id === user.id && !body.active) throw new ApiError(400, 'Du kan ikke deaktivere din egen konto.');
        profile.active = body.active;
      }
      if (target.id === user.id && body.role !== undefined && body.role !== target.role) throw new ApiError(400, 'Du kan ikke endre din egen administratorrolle.');
      commit({ ...state, users: state.users.map((item) => item.id === id ? profile : item) });
      if (profile.active === false) {
        for (const [key, session] of sessions) if (session.userId === id) sessions.delete(key);
      }
      return json(res, 200, { user: safeUser(profile) });
    }
    if (pathname === '/api/articles') {
      if (user.role === 'ambassador') throw new ApiError(403, 'Bare ansatte kan publisere artikler.');
      checkFields(body, ['title', 'body', 'category']);
      const article = {
        id: randomUUID(), title: text(body.title, 'Tittel', 160),
        body: text(body.body, 'Innhold', 12000), category: text(body.category, 'Kategori', 60),
        authorId: user.id, updatedBy: user.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      commit({ ...state, articles: [...state.articles, article] });
      return json(res, 201, { article });
    }
    if (/^\/api\/articles\/[^/]+$/.test(pathname)) {
      if (user.role === 'ambassador') throw new ApiError(403, 'Bare ansatte kan redigere artikler.');
      const id = pathname.split('/')[3];
      const article = state.articles.find((item) => item.id === id);
      if (!article) throw new ApiError(404, 'Fant ikke artikkelen.');
      checkFields(body, ['title', 'body', 'category']);
      if (!Object.keys(body).length) throw new ApiError(400, 'Ingen endringer er oppgitt.');
      const updated = { ...article };
      if (body.title !== undefined) updated.title = text(body.title, 'Tittel', 160);
      if (body.body !== undefined) updated.body = text(body.body, 'Innhold', 12000);
      if (body.category !== undefined) updated.category = text(body.category, 'Kategori', 60);
      updated.updatedBy = user.id;
      updated.updatedAt = new Date().toISOString();
      commit({ ...state, articles: state.articles.map((item) => item.id === id ? updated : item) });
      return json(res, 200, { article: updated });
    }
    if (pathname === '/api/damage-reports') {
      if (user.role !== 'ambassador') throw new ApiError(403, 'Skademeldinger kan bare opprettes av ambassadører.');
      checkFields(body, ['productId', 'description', 'ticketId']);
      const productId = body.productId === undefined ? null : text(body.productId, 'Produkt', 100);
      if (productId && !state.products.some((item) => item.id === productId)) throw new ApiError(400, 'Velg et gyldig produkt.');
      const ticketId = body.ticketId === undefined || body.ticketId === '' ? null : text(body.ticketId, 'Samarbeid', 100);
      if (ticketId) {
        const relatedTicket = authorizedTicket(ticketId, user);
        if (relatedTicket.ambassadorId !== user.id || relatedTicket.productId !== productId) throw new ApiError(400, 'Velg et av dine samarbeid med samme produkt.');
      }
      const report = {
        id: randomUUID(), ambassadorId: user.id, productId, ticketId,
        description: text(body.description, 'Beskrivelse', 5000), status: 'pending',
        createdAt: new Date().toISOString(), reviewedBy: null, reviewNote: '',
      };
      commit({ ...state, damageReports: [...state.damageReports, report] });
      return json(res, 201, { report });
    }
    if (/^\/api\/damage-reports\/[^/]+$/.test(pathname)) {
      if (!['admin', 'employee'].includes(user.role)) throw new ApiError(403, 'Bare ansatte kan behandle skademeldinger.');
      const id = pathname.split('/')[3];
      const report = state.damageReports.find((item) => item.id === id);
      if (!report) throw new ApiError(404, 'Fant ikke skademeldingen.');
      checkFields(body, ['status', 'reviewNote']);
      if (!['approved', 'rejected'].includes(body.status)) throw new ApiError(400, 'Velg godkjent eller avslått.');
      const updated = {
        ...report, status: body.status, reviewedBy: user.id,
        reviewNote: body.reviewNote === undefined ? report.reviewNote : text(body.reviewNote, 'Kommentar', 1000, { optional: true, min: 0 }) || '',
      };
      commit({ ...state, damageReports: state.damageReports.map((item) => item.id === id ? updated : item) });
      return json(res, 200, { report: updated });
    }
    const acceptMatch = pathname.match(/^\/api\/tickets\/([a-z0-9-]{15,36})\/accept$/i);
    if (acceptMatch) {
      checkFields(body, []);
      if (user.role !== 'ambassador') throw new ApiError(403, 'Bare ambassadører kan melde interesse for oppgaver.');
      const ticket = state.tickets.find((item) => item.id === acceptMatch[1]);
      if (!ticket || ticket.status !== 'available' || ticket.ambassadorId) throw new ApiError(409, 'Denne oppgaven er ikke lenger tilgjengelig.');
      const today = new Date().toISOString().slice(0, 10);
      if (!ticket.acceptBy || ticket.acceptBy < today) throw new ApiError(409, 'Fristen for å melde interesse for denne oppgaven har gått ut.');
      const accepted = { ...ticket, ambassadorId: user.id, status: 'approved', updatedAt: new Date().toISOString() };
      commit({ ...state, tickets: state.tickets.map((item) => item.id === ticket.id ? accepted : item) });
      return json(res, 200, { ticket: accepted });
    }
    if (pathname === '/api/tickets') {
      checkFields(body, ['productId', 'productUrl', 'subject', 'description', 'channel', 'dueDate', 'ambassadorId']);
      const productId = text(body.productId, 'Produkt', 100);
      const product = state.products.find((item) => item.id === productId && item.available);
      if (!product) throw new ApiError(400, 'Velg et tilgjengelig produkt.');
      let ambassadorId = user.id;
      if (user.role !== 'ambassador') {
        ambassadorId = text(body.ambassadorId, 'Ambassadør', 100);
        if (!state.users.some((item) => item.id === ambassadorId && item.role === 'ambassador')) throw new ApiError(400, 'Velg en gyldig ambassadør.');
      } else if (body.ambassadorId !== undefined && body.ambassadorId !== user.id) {
        throw new ApiError(403, 'Du kan bare opprette egne forespørsler.');
      }
      const subject = text(body.subject, 'Tittel', 160);
      const description = text(body.description, 'Beskrivelse', 5000);
      if (!CHANNELS.includes(body.channel)) throw new ApiError(400, 'Velg en gyldig kanal.');
      const dueDate = body.dueDate === undefined ? null : dateValue(body.dueDate);
      const assigneeId = state.users.find((item) => item.role === 'employee')?.id;
      if (!assigneeId) throw new ApiError(409, 'Ingen medarbeider er tilgjengelig.');
      const productSnapshot = await fetchProductDetails(body.productUrl);
      const now = new Date().toISOString();
      const ticket = {
        id: randomUUID(), number: Math.max(1000, ...state.tickets.map((item) => item.number)) + 1,
        subject, description, productId, productUrl: productSnapshot.url, productSnapshot,
        ambassadorId, assigneeId, status: 'requested', channel: body.channel,
        dueDate, createdAt: now, updatedAt: now, messages: [],
      };
      commit({ ...state, tickets: [...state.tickets, ticket] });
      return json(res, 201, { ticket });
    }
    const id = pathname.split('/')[3];
    const ticket = authorizedTicket(id, user);
    if (method !== 'PATCH' && user.role === 'ambassador' && ticket.ambassadorId !== user.id) {
      throw new ApiError(404, 'Meld interesse for oppgaven før du starter en samtale.');
    }
    if (method === 'PATCH') {
      checkFields(body, ['status', 'assigneeId', 'dueDate', 'channel']);
      if (!Object.keys(body).length) throw new ApiError(400, 'Ingen endringer er oppgitt.');
      if (user.role === 'ambassador') {
        const transitions = { approved: 'in_progress', in_progress: 'review' };
        const selectingChannel = Object.keys(body).length === 1 && body.channel !== undefined
          && ticket.ambassadorId === user.id && ['approved', 'in_progress'].includes(ticket.status);
        const changingStatus = Object.keys(body).length === 1 && body.status !== undefined && transitions[ticket.status] === body.status;
        if (!selectingChannel && !changingStatus) {
          throw new ApiError(403, 'Du kan velge kanal på din oppgave, starte en godkjent oppgave eller sende en pågående oppgave til vurdering.');
        }
      }
      if (body.status !== undefined && !STATUSES.includes(body.status)) throw new ApiError(400, 'Ugyldig status.');
      if (body.status === 'available' && (ticket.ambassadorId || !ticket.acceptBy || ticket.acceptBy < new Date().toISOString().slice(0, 10))) throw new ApiError(400, 'Bare en utildelt oppgave med gyldig akseptfrist kan være åpen.');
      if (body.status !== undefined && !ticket.ambassadorId && !['available', 'declined'].includes(body.status)) throw new ApiError(400, 'En ambassadør må akseptere oppgaven først.');
      if (body.assigneeId !== undefined && !state.users.some((item) => item.id === body.assigneeId && item.role === 'employee')) {
        throw new ApiError(400, 'Ansvarlig må være en medarbeider.');
      }
      const updated = { ...ticket, updatedAt: new Date().toISOString() };
      if (body.status !== undefined) updated.status = body.status;
      if (body.assigneeId !== undefined) updated.assigneeId = body.assigneeId;
      if (body.dueDate !== undefined) {
        updated.dueDate = dateValue(body.dueDate);
        if (ticket.acceptBy && (!updated.dueDate || updated.dueDate < ticket.acceptBy)) throw new ApiError(400, 'Publiseringsfristen kan ikke være før akseptfristen.');
      }
      if (body.channel !== undefined) {
        if (!CHANNELS.includes(body.channel)) throw new ApiError(400, 'Velg en gyldig publiseringskanal.');
        if (!ticket.ambassadorId && user.role === 'ambassador') throw new ApiError(403, 'Meld interesse for oppgaven før du velger kanal.');
        updated.channel = body.channel;
      }
      commit({ ...state, tickets: state.tickets.map((item) => item.id === id ? updated : item) });
      return json(res, 200, { ticket: updated });
    }
    if (!ticket.ambassadorId) throw new ApiError(400, 'Samtalen åpnes når en ambassadør har akseptert oppgaven.');
    checkFields(body, ['body', 'sendEmail']);
    const messageBody = text(body.body, 'Melding', 5000);
    if (body.sendEmail !== undefined && typeof body.sendEmail !== 'boolean') throw new ApiError(400, 'sendEmail må være true eller false.');
    const message = { id: randomUUID(), authorId: user.id, body: messageBody, createdAt: new Date().toISOString(), emailStatus: body.sendEmail ? 'failed' : 'not_requested' };
    let updated = { ...ticket, messages: [...ticket.messages, message], updatedAt: message.createdAt };
    // Save before contacting the mail provider: a provider failure must never lose the conversation.
    commit({ ...state, tickets: state.tickets.map((item) => item.id === id ? updated : item) });
    if (body.sendEmail && emailConfigured) {
      const recipientId = user.role === 'employee' ? ticket.ambassadorId : ticket.assigneeId;
      const recipient = state.users.find((item) => item.id === recipientId);
      if (recipient) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), emailTimeoutMs);
        try {
          const response = await fetchEmail('https://api.resend.com/emails', {
            method: 'POST', signal: controller.signal,
            headers: { Authorization: ['Bearer', emailApiKey].join(' '), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: emailFrom, to: [recipient.email],
              subject: `Ølbrygging · #${ticket.number}: ${ticket.subject}`,
              text: `${user.name} skrev:\n\n${messageBody}\n\nDette er en utgående melding fra Ølbrygging-portalen. Svar i portalen; innkommende e-post synkroniseres ikke.`,
            }),
          });
          if (response.ok) message.emailStatus = 'sent';
          await response.body?.cancel();
        } catch {
          message.emailStatus = 'failed';
        } finally {
          clearTimeout(timeout);
        }
        updated = { ...updated, messages: updated.messages.map((item) => item.id === message.id ? { ...message } : item) };
        commit({ ...state, tickets: state.tickets.map((item) => item.id === id ? updated : item) });
      }
    }
    return json(res, 201, { message });
  }

  function staticFile(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'Metoden er ikke tillatt.');
    const target = resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(`${publicDir}${sep}`)) throw new ApiError(404, 'Fant ikke filen.');
    if (!existsSync(target) || !statSync(target).isFile()) throw new ApiError(404, 'Fant ikke siden.');
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(`${realpathSync(publicDir)}${sep}`)) throw new ApiError(404, 'Fant ikke filen.');
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
    const content = readFileSync(target);
    res.writeHead(200, { 'Content-Type': `${mime[extname(target)] || 'application/octet-stream'}${['.html', '.css', '.js', '.mjs', '.svg'].includes(extname(target)) ? '; charset=utf-8' : ''}`, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  }

  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new ApiError(400, 'Ugyldig URL.');
      const rawPath = req.url.split('?')[0];
      let decoded;
      try { decoded = decodeURIComponent(rawPath); } catch { throw new ApiError(400, 'Ugyldig URL.'); }
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((part) => part === '..' || part === '.')) {
        throw new ApiError(400, 'Ugyldig filsti.');
      }
      const parsed = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(parsed.pathname);
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (pocketbase || req.method === 'GET') await api(req, res, pathname);
        else {
          const operation = mutationQueue.then(() => api(req, res, pathname));
          mutationQueue = operation.catch(() => {});
          await operation;
        }
      } else {
        staticFile(req, res, pathname);
      }
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'En intern feil oppstod. Prøv igjen.' });
      else res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  createApp(process.argv.includes('--demo') ? { pocketbaseUrl: '' } : {})
    .listen(port, host, () => console.log(`Ølbrygging: http://${host}:${port}`));
}
