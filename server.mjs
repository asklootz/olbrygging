import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATUSES = ['requested', 'approved', 'in_progress', 'review', 'completed', 'declined'];
const CHANNELS = ['Instagram', 'TikTok', 'YouTube', 'Blogg', 'Annet'];
const COOKIE = 'olbrygging_session';
const SESSION_MS = 1000 * 60 * 60 * 12;
const MAX_BODY = 24 * 1024;
const safeUser = ({ id, name, email, role }) => ({ id, name, email, role });
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
    id, name, email, role, passwordHash: passwordHash('BrewTogether!2026'),
  });
  const users = [
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
    version: 1, users, products,
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

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function text(value, field, max, { optional = false, min = 1 } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new ApiError(400, `${field} må være tekst på ${min}–${max} tegn.`);
  }
  return value.trim();
}

function dateValue(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'Frist må være en gyldig dato (ÅÅÅÅ-MM-DD).');
  }
  return value;
}

function checkFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Forventet et JSON-objekt.');
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new ApiError(400, 'Forespørselen inneholder ukjente felt.');
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
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
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
  try {
    const parsedImage = new URL(image, url);
    if (parsedImage.protocol === 'https:' && !parsedImage.username && !parsedImage.password) imageUrl = parsedImage.href;
  } catch { /* An invalid or absent image is optional. */ }
  const priceValue = metadata.get('product:price:amount') || offer.price || offer.lowPrice;
  const numericPrice = Number(String(priceValue ?? '').replace(',', '.'));
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]+>/g, '');
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

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ApiError(415, 'Bruk Content-Type: application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'Forespørselen er for stor.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'Ugyldig JSON.');
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
  const secureCookies = options.secureCookies ?? process.env.COOKIE_SECURE === 'true';
  const sessions = new Map();
  const attempts = new Map();
  let mutationQueue = Promise.resolve();

  const persist = (next) => {
    mkdirSync(dirname(dataFile), { recursive: true });
    const pending = `${dataFile}.${randomBytes(8).toString('hex')}.pending`;
    writeFileSync(pending, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(pending, dataFile);
  };
  let state;
  if (existsSync(dataFile)) {
    state = JSON.parse(readFileSync(dataFile, 'utf8'));
    if (state.version !== 1 || !['users', 'products', 'tickets'].every((key) => Array.isArray(state[key]))) {
      throw new Error('Unsupported workspace data format.');
    }
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
    return state.users.find((user) => user.id === session.userId) ?? null;
  };
  const cookieValue = (token, age) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookies ? '; Secure' : ''}`;
  const authorizedTicket = (id, user) => {
    const ticket = state.tickets.find((item) => item.id === id);
    if (!ticket || (user.role === 'ambassador' && ticket.ambassadorId !== user.id)) {
      throw new ApiError(404, 'Fant ikke forespørselen.');
    }
    return ticket;
  };
  const readProductPage = async (value) => {
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
  };

  async function api(req, res, pathname) {
    const method = req.method;
    const known = ['/api/session', '/api/login', '/api/logout', '/api/workspace', '/api/tickets'].includes(pathname)
      || pathname === '/api/products/preview'
      || /^\/api\/tickets\/[a-zA-Z0-9_-]{1,100}(?:\/messages)?$/.test(pathname);
    if (!known) throw new ApiError(404, 'Ukjent API-endepunkt.');
    const allowed = pathname === '/api/session' || pathname === '/api/workspace' ? ['GET']
      : /^\/api\/tickets\/[^/]+$/.test(pathname) ? ['PATCH'] : ['POST'];
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
      if (!found || !match) {
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
      const tickets = state.tickets.filter((ticket) => user.role === 'employee' || ticket.ambassadorId === user.id);
      const relevant = new Set([user.id, ...state.users.filter((item) => item.role === 'employee').map((item) => item.id)]);
      for (const ticket of tickets) {
        relevant.add(ticket.ambassadorId);
        relevant.add(ticket.assigneeId);
        for (const message of ticket.messages) relevant.add(message.authorId);
      }
      return json(res, 200, {
        user: safeUser(user), products: state.products, tickets,
        users: state.users.filter((item) => user.role === 'employee' || relevant.has(item.id)).map(safeUser),
        emailConfigured,
      });
    }
    const body = await readBody(req);
    if (pathname === '/api/products/preview') {
      checkFields(body, ['url']);
      return json(res, 200, { product: await readProductPage(body.url) });
    }
    if (pathname === '/api/tickets') {
      checkFields(body, ['productId', 'productUrl', 'subject', 'description', 'channel', 'dueDate', 'ambassadorId']);
      const productId = text(body.productId, 'Produkt', 100);
      const product = state.products.find((item) => item.id === productId && item.available);
      if (!product) throw new ApiError(400, 'Velg et tilgjengelig produkt.');
      let ambassadorId = user.id;
      if (user.role === 'employee') {
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
      const productSnapshot = body.productUrl === undefined ? null : await readProductPage(body.productUrl);
      const now = new Date().toISOString();
      const ticket = {
        id: randomUUID(), number: Math.max(1000, ...state.tickets.map((item) => item.number)) + 1,
        subject, description, productId, productUrl: productSnapshot?.url ?? null, productSnapshot,
        ambassadorId, assigneeId, status: 'requested', channel: body.channel,
        dueDate, createdAt: now, updatedAt: now, messages: [],
      };
      commit({ ...state, tickets: [...state.tickets, ticket] });
      return json(res, 201, { ticket });
    }
    const id = pathname.split('/')[3];
    const ticket = authorizedTicket(id, user);
    if (method === 'PATCH') {
      checkFields(body, ['status', 'assigneeId', 'dueDate']);
      if (!Object.keys(body).length) throw new ApiError(400, 'Ingen endringer er oppgitt.');
      if (user.role !== 'employee') {
        const transitions = { approved: 'in_progress', in_progress: 'review' };
        if (body.assigneeId !== undefined || body.dueDate !== undefined || !body.status || transitions[ticket.status] !== body.status) {
          throw new ApiError(403, 'Du kan bare starte en godkjent oppgave eller sende en pågående oppgave til vurdering.');
        }
      }
      if (body.status !== undefined && !STATUSES.includes(body.status)) throw new ApiError(400, 'Ugyldig status.');
      if (body.assigneeId !== undefined && !state.users.some((item) => item.id === body.assigneeId && item.role === 'employee')) {
        throw new ApiError(400, 'Ansvarlig må være en medarbeider.');
      }
      const updated = { ...ticket, updatedAt: new Date().toISOString() };
      if (body.status !== undefined) updated.status = body.status;
      if (body.assigneeId !== undefined) updated.assigneeId = body.assigneeId;
      if (body.dueDate !== undefined) updated.dueDate = dateValue(body.dueDate);
      commit({ ...state, tickets: state.tickets.map((item) => item.id === id ? updated : item) });
      return json(res, 200, { ticket: updated });
    }
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
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
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
        if (req.method === 'GET') await api(req, res, pathname);
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
  createApp().listen(port, host, () => console.log(`Ølbrygging demo: http://${host}:${port}`));
}
