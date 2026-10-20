import { ApiError, checkFields, readBody, text } from './api.mjs';

const ACCESS_COOKIE = 'olbrygging_access';
const REFRESH_COOKIE = 'olbrygging_refresh';
const COOKIE_AGE = 60 * 60 * 24 * 30;
const safeUser = ({ id, name, email, role }) => ({ id, name, email, role });

export function createSupabaseApi(options) {
  if (!options.url && !options.key) return null;
  if (!options.url || !options.key) throw new Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY).');
  const url = new URL(options.url);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SUPABASE_URL must be an HTTPS origin (HTTP is allowed for local Supabase).');
  }
  let keyRole;
  try { keyRole = JSON.parse(Buffer.from(options.key.split('.')[1], 'base64url').toString()).role; } catch { /* Publishable keys are not JWTs. */ }
  if (options.key.startsWith('sb_secret_') || keyRole === 'service_role') {
    throw new Error('Use a publishable/anon key, not a privileged Supabase key.');
  }
  const base = url.origin;
  const emailConfigured = Boolean(options.emailApiKey && options.emailFrom && options.serviceKey);
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${options.secureCookies ? '; Secure' : ''}`;
  const setCookies = (res, session) => res.setHeader('Set-Cookie', [
    cookie(ACCESS_COOKIE, session?.access_token ?? '', session ? COOKIE_AGE : 0),
    cookie(REFRESH_COOKIE, session?.refresh_token ?? '', session ? COOKIE_AGE : 0),
  ]);

  async function request(path, { token, method = 'GET', body, privileged = false } = {}) {
    const key = privileged ? options.serviceKey : options.key;
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    // New publishable keys are not JWTs; Auth accepts the apikey header alone.
    if (token || (privileged && !key.startsWith('sb_secret_'))) headers.Authorization = ['Bearer', token || key].join(' ');
    let response;
    let data;
    try {
      response = await options.fetch(`${base}${path}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: 'error',
      });
      const raw = await response.text();
      data = raw ? JSON.parse(raw) : null;
    } catch {
      throw new ApiError(503, 'Kan ikke kontakte Supabase. Prøv igjen.');
    }
    if (!response.ok) {
      const invalidSession = path === '/auth/v1/user' && response.status === 403
        && ['bad_jwt', 'session_not_found'].includes(data?.code ?? data?.error_code);
      const status = invalidSession ? 401
        : [400, 401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 503;
      const messages = {
        400: 'Ugyldig forespørsel.', 401: 'Logg inn for å fortsette.', 403: 'Du har ikke tilgang til denne handlingen.',
        404: 'Fant ikke forespørselen.', 409: 'Endringen kunne ikke lagres. Kontroller at en medarbeider er tilgjengelig.',
        422: 'Ugyldig forespørsel.', 429: 'For mange forsøk. Prøv igjen senere.', 503: 'Supabase er utilgjengelig. Prøv igjen.',
      };
      // Never forward provider error details, tokens, SQL, or account information.
      throw new ApiError(status, messages[status]);
    }
    return data;
  }

  const rpc = (name, token, body = {}) => request(`/rest/v1/rpc/${name}`, { token, method: 'POST', body });
  function validSession(session) {
    return session && [session.access_token, session.refresh_token].every((value) =>
      typeof value === 'string' && /^[a-zA-Z0-9._~-]{1,3800}$/.test(value));
  }
  async function profile(token) {
    const account = await request('/auth/v1/user', { token });
    if (!account?.id) throw new ApiError(401, 'Logg inn for å fortsette.');
    const profiles = await request(`/rest/v1/profiles?select=id,name,email,role&id=eq.${encodeURIComponent(account.id)}`, { token });
    const user = profiles?.find((item) => item.id === account.id);
    if (!user || !['employee', 'ambassador'].includes(user.role)) throw new ApiError(403, 'Kontoen mangler en gyldig profil. Kontakt administrator.');
    return safeUser(user);
  }
  async function authenticate(req, res) {
    const cookies = new Map((req.headers.cookie || '').split(';').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1)];
    }));
    let token = cookies.get(ACCESS_COOKIE);
    const refresh = cookies.get(REFRESH_COOKIE);
    const validToken = (value) => typeof value === 'string' && /^[a-zA-Z0-9._~-]{1,3800}$/.test(value);
    if (validToken(token)) {
      try {
        return { token, user: await profile(token) };
      } catch (error) {
        if (error.status !== 401) throw error;
      }
    }
    if (!validToken(refresh)) return null;
    let session;
    try {
      session = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refresh } });
    } catch (error) {
      if (![400, 401, 422].includes(error.status)) throw error;
      setCookies(res, null);
      return null;
    }
    if (!validSession(session)) throw new ApiError(503, 'Ugyldig svar fra Supabase.');
    token = session.access_token;
    const user = await profile(token);
    setCookies(res, session);
    return { token, user };
  }

  async function notify(token, user, ticketId, message, sendEmail) {
    if (!sendEmail || !emailConfigured) return;
    let sent = false;
    try {
      const workspace = await rpc('portal_workspace', token);
      const ticket = workspace.tickets.find((item) => item.id === ticketId);
      const recipientId = user.role === 'employee' ? ticket?.ambassadorId : ticket?.assigneeId;
      const recipient = workspace.users.find((item) => item.id === recipientId);
      if (!ticket || !recipient) return;
      const response = await options.fetchEmail('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(options.emailTimeoutMs),
        headers: { Authorization: ['Bearer', options.emailApiKey].join(' '), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: options.emailFrom, to: [recipient.email],
          subject: `Ølbrygging · #${ticket.number}: ${ticket.subject}`,
          text: `${user.name} skrev:\n\n${message.body}\n\nDette er en utgående melding fra Ølbrygging-portalen. Svar i portalen; innkommende e-post synkroniseres ikke.`,
        }),
        redirect: 'error',
      });
      sent = response.ok;
      await response.body?.cancel();
    } catch {
      // The database message is already durable even if notification delivery fails.
    }
    try {
      await request('/rest/v1/rpc/portal_email_result', {
        method: 'POST', privileged: true, body: { message_id: message.id, delivery_status: sent ? 'sent' : 'failed' },
      });
      message.emailStatus = sent ? 'sent' : 'failed';
    } catch {
      // Keep the persisted failure marker if the delivery outcome cannot be recorded.
    }
  }

  return async (req, res, pathname) => {
    if (pathname === '/api/login') {
      const body = await readBody(req);
      checkFields(body, ['email', 'password']);
      const email = text(body.email, 'E-post', 254).toLowerCase();
      text(body.password, 'Passord', 256);
      let session;
      try {
        session = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: body.password } });
      } catch (error) {
        if ([400, 401, 422].includes(error.status)) throw new ApiError(401, 'Feil e-post eller passord.');
        throw error;
      }
      if (!validSession(session)) throw new ApiError(503, 'Ugyldig svar fra Supabase.');
      const user = await profile(session.access_token);
      setCookies(res, session);
      return { status: 200, body: { user } };
    }
    if (pathname === '/api/logout') {
      let auth;
      try {
        auth = await authenticate(req, res);
      } finally {
        setCookies(res, null);
      }
      if (auth) {
        try { await request('/auth/v1/logout?scope=local', { token: auth.token, method: 'POST' }); }
        catch (error) { if (error.status !== 401) throw error; }
      }
      return { status: 200, body: { user: null } };
    }
    const auth = await authenticate(req, res);
    if (pathname === '/api/session') return { status: 200, body: { user: auth?.user ?? null } };
    if (!auth) throw new ApiError(401, 'Logg inn for å fortsette.');
    if (pathname === '/api/workspace') {
      const workspace = await rpc('portal_workspace', auth.token);
      return { status: 200, body: { ...workspace, emailConfigured } };
    }
    const input = await readBody(req);
    if (pathname === '/api/tickets') {
      checkFields(input, ['productId', 'subject', 'description', 'channel', 'dueDate', 'ambassadorId']);
      return { status: 201, body: await rpc('portal_create_ticket', auth.token, { input }) };
    }
    const ticketId = pathname.split('/')[3];
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ticketId)) {
      throw new ApiError(404, 'Fant ikke forespørselen.');
    }
    if (req.method === 'PATCH') {
      checkFields(input, ['status', 'assigneeId', 'dueDate']);
      return { status: 200, body: await rpc('portal_update_ticket', auth.token, { ticket_id: ticketId, input }) };
    }
    checkFields(input, ['body', 'sendEmail']);
    const result = await rpc('portal_add_message', auth.token, { ticket_id: ticketId, input });
    await notify(auth.token, auth.user, ticketId, result.message, input.sendEmail);
    return { status: 201, body: result };
  };
}
