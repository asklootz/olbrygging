import { ApiError, checkFields, readBody, text } from './api.mjs';
import application from './pb_hooks/application.cjs';

const AUTH_COOKIE = 'olbrygging_pb_auth';
const MAX_COOKIE_AGE = 60 * 60 * 12;
const safeUser = ({ id, name, email, role }) => ({ id, name, email, role });
const safeWorkspaceUser = ({ id, name, email, role, socialMedia }) => ({
  ...safeUser({ id, name, email, role }), active: true, socialMedia: socialMedia || '',
});
const validToken = (token) => typeof token === 'string' && token.length <= 3800
  && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
const unavailable = () => new ApiError(503, 'PocketBase er utilgjengelig. Prøv igjen.');

export function createPocketbaseApi(options) {
  if (Boolean(options.adminEmail) !== Boolean(options.adminPassword)) {
    throw new Error('Set both POCKETBASE_ADMIN_EMAIL and POCKETBASE_ADMIN_PASSWORD.');
  }
  if (!options.url) {
    if (options.adminEmail) throw new Error('POCKETBASE_URL is required with PocketBase admin credentials.');
    return null;
  }
  let url;
  try { url = new URL(options.url); } catch { throw new Error('POCKETBASE_URL must be an HTTPS origin (HTTP is allowed for loopback).'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('POCKETBASE_URL must be an HTTPS origin (HTTP is allowed for loopback).');
  }
  const base = url.origin;
  const emailConfigured = Boolean(options.emailApiKey && options.emailFrom && options.adminEmail && options.adminPassword);
  const setCookie = (res, token, age = 0) => res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${options.secureCookies ? '; Secure' : ''}`);

  async function request(path, { token, method = 'GET', body } = {}) {
    let response;
    let data;
    try {
      response = await options.fetch(`${base}${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs), redirect: 'error',
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw unavailable();
      const raw = await response.text();
      data = raw ? JSON.parse(raw) : null;
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      const status = [400, 401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 503;
      const messages = {
        400: 'Ugyldig forespørsel.', 401: 'Logg inn for å fortsette.', 403: 'Du har ikke tilgang til denne handlingen.',
        404: 'Fant ikke forespørselen.', 409: 'Endringen kunne ikke lagres. Kontroller at en medarbeider er tilgjengelig.',
        422: 'Ugyldig forespørsel.', 429: 'For mange forsøk. Prøv igjen senere.', 503: 'PocketBase er utilgjengelig. Prøv igjen.',
      };
      throw new ApiError(status, messages[status]);
    }
    return data;
  }

  function sessionAge(token) {
    if (!validToken(token)) throw unavailable();
    let exp;
    try { exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp; } catch { throw unavailable(); }
    if (!Number.isFinite(exp) || exp <= Date.now() / 1000) throw unavailable();
    return Math.max(1, Math.min(MAX_COOKIE_AGE, Math.floor(exp - Date.now() / 1000)));
  }

  function acceptSession(session, res, persist = false) {
    const age = sessionAge(session?.token);
    const record = session?.record;
    if (!record || !['employee', 'ambassador'].includes(record.role)) {
      if (persist) setCookie(res, null);
      throw new ApiError(403, 'Kontoen mangler en gyldig profil. Kontakt administrator.');
    }
    if (typeof record.id !== 'string' || !/^[a-z0-9]{15}$/.test(record.id)
      || typeof record.name !== 'string' || typeof record.email !== 'string') throw unavailable();
    // Only explicit login changes cookies: delayed polls must not undo logout or account switches.
    if (persist) setCookie(res, session.token, age);
    return { token: session.token, user: safeUser(record) };
  }

  async function authenticate(req, res) {
    const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${AUTH_COOKIE}=`));
    if (!cookie) return null;
    const token = cookie.slice(AUTH_COOKIE.length + 1);
    if (!validToken(token)) return null;
    let session;
    try {
      session = await request('/api/collections/users/auth-refresh', { token, method: 'POST' });
    } catch (error) {
      if (![400, 401, 422].includes(error.status)) throw error;
      return null;
    }
    return acceptSession(session, res);
  }

  async function notify(token, user, ticketId, message, sendEmail) {
    if (!sendEmail || !emailConfigured) return;
    let sent = false;
    try {
      const workspace = await request('/api/portal/workspace', { token });
      const ticket = workspace.tickets.find((item) => item.id === ticketId);
      const recipientId = user.role === 'employee' ? ticket?.ambassadorId : ticket?.assigneeId;
      const recipient = workspace.users.find((item) => item.id === recipientId);
      if (!ticket || !recipient) return;
      const response = await options.fetchEmail('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(options.emailTimeoutMs), redirect: 'error',
        headers: { Authorization: ['Bearer', options.emailApiKey].join(' '), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: options.emailFrom, to: [recipient.email],
          subject: `Ølbrygging · #${ticket.number}: ${ticket.subject}`,
          text: `${user.name} skrev:\n\n${message.body}\n\nDette er en utgående melding fra Ølbrygging-portalen. Svar i portalen; innkommende e-post synkroniseres ikke.`,
        }),
      });
      sent = response.ok && !response.redirected;
      await response.body?.cancel();
    } catch {
      // The portal message is already durable when notification delivery fails.
    }
    try {
      const admin = await request('/api/collections/_superusers/auth-with-password', {
        method: 'POST', body: { identity: options.adminEmail, password: options.adminPassword },
      });
      sessionAge(admin?.token);
      if (!/^[a-z0-9]{15}$/.test(message.id)) return;
      await request(`/api/portal/messages/${message.id}/email-result`, {
        token: admin.token, method: 'POST', body: { deliveryStatus: sent ? 'sent' : 'failed' },
      });
      message.emailStatus = sent ? 'sent' : 'failed';
    } catch {
      // Keep the durable failure marker if delivery status cannot be recorded.
    }
  }

  return async (req, res, pathname) => {
    if (pathname === '/api/ambassador-applications') {
      const input = application.validateApplication(await readBody(req), (message) => new ApiError(400, message));
      await request('/api/portal/ambassador-applications', { method: 'POST', body: input });
      return { status: 201, body: { submitted: true } };
    }
    if (pathname === '/api/login') {
      const body = await readBody(req);
      checkFields(body, ['email', 'password']);
      const email = text(body.email, 'E-post', 254).toLowerCase();
      text(body.password, 'Passord', 256);
      let session;
      try {
        session = await request('/api/collections/users/auth-with-password', {
          method: 'POST', body: { identity: email, password: body.password },
        });
      } catch (error) {
        if ([400, 401, 422].includes(error.status)) throw new ApiError(401, 'Feil e-post eller passord.');
        throw error;
      }
      const auth = acceptSession(session, res, true);
      return { status: 200, body: { user: auth.user } };
    }
    if (pathname === '/api/logout') {
      // PocketBase tokens are stateless: logout clears this browser's cookie, not the token itself.
      setCookie(res, null);
      return { status: 200, body: { user: null } };
    }
    const auth = await authenticate(req, res);
    if (pathname === '/api/session') return { status: 200, body: { user: auth?.user ?? null } };
    if (!auth) throw new ApiError(401, 'Logg inn for å fortsette.');
    if (pathname === '/api/workspace') {
      const workspace = await request('/api/portal/workspace', { token: auth.token });
      return {
        status: 200,
        body: { ...workspace, user: safeWorkspaceUser(workspace.user), users: workspace.users.map(safeWorkspaceUser), emailConfigured },
      };
    }
    if (pathname === '/api/products/preview') {
      const input = await readBody(req);
      checkFields(input, ['url']);
      return { status: 200, body: { product: await options.readProductPage(input.url) } };
    }
    if (pathname === '/api/tasks') {
      if (auth.user.role !== 'employee') throw new ApiError(403, 'Bare ansatte kan opprette åpne oppgaver.');
      const input = await readBody(req);
      checkFields(input, ['productUrl', 'subject', 'description', 'acceptBy', 'dueDate']);
      const productSnapshot = await options.readProductPage(input.productUrl);
      return {
        status: 201,
        body: await request('/api/portal/tasks', {
          token: auth.token, method: 'POST', body: { ...input, productUrl: productSnapshot.url, productSnapshot },
        }),
      };
    }
    const acceptMatch = pathname.match(/^\/api\/tickets\/([a-z0-9]{15})\/accept$/);
    if (acceptMatch) {
      checkFields(await readBody(req), []);
      return {
        status: 200,
        body: await request(`/api/portal/tickets/${acceptMatch[1]}/accept`, { token: auth.token, method: 'POST', body: {} }),
      };
    }
    if (pathname === '/api/profile') {
      const input = await readBody(req);
      checkFields(input, ['name', 'email', 'socialMedia']);
      return { status: 200, body: await request('/api/portal/profile', { token: auth.token, method: 'PATCH', body: input }) };
    }
    const userMatch = pathname.match(/^\/api\/users\/([a-z0-9]{15})$/);
    if (userMatch) {
      const input = await readBody(req);
      checkFields(input, ['name', 'email', 'socialMedia']);
      return { status: 200, body: await request(`/api/portal/users/${userMatch[1]}`, { token: auth.token, method: 'PATCH', body: input }) };
    }
    if (pathname === '/api/users') throw new ApiError(403, 'Brukere og roller administreres av en PocketBase-superbruker.');
    if (pathname === '/api/articles') {
      if (req.method === 'GET') return { status: 200, body: await request('/api/portal/articles', { token: auth.token }) };
      const input = await readBody(req);
      checkFields(input, ['title', 'body', 'category']);
      return { status: 201, body: await request('/api/portal/articles', { token: auth.token, method: 'POST', body: input }) };
    }
    const articleMatch = pathname.match(/^\/api\/articles\/([a-z0-9]{15})$/);
    if (articleMatch) {
      const input = await readBody(req);
      checkFields(input, ['title', 'body', 'category']);
      return { status: 200, body: await request(`/api/portal/articles/${articleMatch[1]}`, { token: auth.token, method: 'PATCH', body: input }) };
    }
    if (pathname === '/api/damage-reports') {
      const input = await readBody(req);
      checkFields(input, ['productId', 'description', 'ticketId']);
      return { status: 201, body: await request('/api/portal/damage-reports', { token: auth.token, method: 'POST', body: input }) };
    }
    const reportMatch = pathname.match(/^\/api\/damage-reports\/([a-z0-9]{15})$/);
    if (reportMatch) {
      const input = await readBody(req);
      checkFields(input, ['status', 'reviewNote']);
      return { status: 200, body: await request(`/api/portal/damage-reports/${reportMatch[1]}`, { token: auth.token, method: 'PATCH', body: input }) };
    }
    const input = await readBody(req);
    if (pathname === '/api/tickets') {
      checkFields(input, ['productId', 'productUrl', 'subject', 'description', 'channel', 'dueDate', 'ambassadorId']);
      if (input.productUrl !== undefined) {
        const productSnapshot = await options.readProductPage(input.productUrl);
        input.productUrl = productSnapshot.url;
        input.productSnapshot = productSnapshot;
      }
      return { status: 201, body: await request('/api/portal/tickets', { token: auth.token, method: 'POST', body: input }) };
    }
    const ticketId = pathname.split('/')[3];
    if (!/^[a-z0-9]{15}$/.test(ticketId)) throw new ApiError(404, 'Fant ikke forespørselen.');
    if (req.method === 'PATCH') {
      checkFields(input, ['status', 'assigneeId', 'dueDate', 'channel']);
      return { status: 200, body: await request(`/api/portal/tickets/${ticketId}`, { token: auth.token, method: 'PATCH', body: input }) };
    }
    checkFields(input, ['body', 'sendEmail']);
    const result = await request(`/api/portal/tickets/${ticketId}/messages`, { token: auth.token, method: 'POST', body: input });
    await notify(auth.token, auth.user, ticketId, result.message, input.sendEmail);
    return { status: 201, body: result };
  };
}
