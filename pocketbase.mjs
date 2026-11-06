import { createHash, randomBytes } from 'node:crypto';
import { ApiError, checkFields, promotionQuantity, readBody, readMultipart, text, validateSubmission } from './api.mjs';
import application from './pb_hooks/application.cjs';

const AUTH_COOKIE = 'olbrygging_pb_auth';
const MAX_COOKIE_AGE = 60 * 60 * 12;
const safeUser = ({ id, name, email, role, isPortalAdmin }) => ({
  id, name, email, role, ...(isPortalAdmin ? { isPortalAdmin: true } : {}),
});
const safeWorkspaceUser = ({ id, name, email, role, socialMedia, isPortalAdmin }) => ({
  ...safeUser({ id, name, email, role, isPortalAdmin }), active: true, socialMedia: socialMedia || '',
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
  const invitationEmailConfigured = Boolean(options.emailApiKey && options.emailFrom && options.publicUrl);
  const publicUrl = options.publicUrl;
  let publicBaseUrl = '';
  if (publicUrl) {
    let parsedPublicUrl;
    try { parsedPublicUrl = new URL(publicUrl); } catch { throw new Error('PUBLIC_URL must be an HTTPS origin (HTTP is allowed for loopback).'); }
    if ((parsedPublicUrl.protocol !== 'https:' && !(parsedPublicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsedPublicUrl.hostname)))
      || parsedPublicUrl.username || parsedPublicUrl.password || parsedPublicUrl.search || parsedPublicUrl.hash || parsedPublicUrl.pathname !== '/') {
      throw new Error('PUBLIC_URL must be an HTTPS origin (HTTP is allowed for loopback).');
    }
    publicBaseUrl = parsedPublicUrl.origin;
  }
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

  async function requestMultipart(path, { token, form }) {
    let response;
    try {
      response = await options.fetch(`${base}${path}`, {
        method: 'POST', headers: { Authorization: token }, body: form,
        signal: AbortSignal.timeout(options.timeoutMs), redirect: 'error',
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw unavailable();
      const raw = await response.text();
      const data = raw ? JSON.parse(raw) : null;
      if (!response.ok) {
        const status = [400, 401, 403, 404, 409, 413, 422].includes(response.status) ? response.status : 503;
        const messages = {
          400: 'Ugyldig filopplasting.', 401: 'Logg inn for å fortsette.', 403: 'Du har ikke tilgang til denne oppgaven.',
          404: 'Fant ikke oppgaven.', 409: 'Innsendingen er allerede endret. Last inn oppgaven på nytt.',
          413: 'Opplastingen er for stor.', 422: 'Ugyldig filopplasting.',
        };
        throw new ApiError(status, messages[status]);
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }

  async function downloadSubmissionFile(submissionId, filename, token) {
    const record = await request(`/api/collections/content_submissions/records/${submissionId}`, { token });
    const files = Array.isArray(record.files) ? record.files : [];
    const extension = filename.split('.').pop().toLowerCase();
    const contentType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' }[extension];
    if (!files.includes(filename) || !contentType) throw new ApiError(404, 'Fant ikke mediefilen.');
    const fileAccess = await request('/api/files/token', { token, method: 'POST', body: {} });
    let response;
    try {
      response = await options.fetch(`${base}/api/files/content_submissions/${submissionId}/${encodeURIComponent(filename)}?token=${encodeURIComponent(fileAccess.token)}`, {
        signal: AbortSignal.timeout(options.timeoutMs), redirect: 'error',
      });
      if (!response.ok || response.redirected) throw new ApiError(404, 'Fant ikke mediefilen.');
      return { status: 200, body: Buffer.from(await response.arrayBuffer()), contentType };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }

  async function sendInvitation(token, application, setupToken) {
    const tokenHash = createHash('sha256').update(setupToken).digest('hex');
    let sent = false;
    if (invitationEmailConfigured) {
      try {
        const response = await options.fetchEmail('https://api.resend.com/emails', {
          method: 'POST', signal: AbortSignal.timeout(options.emailTimeoutMs), redirect: 'error',
          headers: { Authorization: `Bearer ${options.emailApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: options.emailFrom, to: [application.email], subject: 'Velkommen som ambassadør hos Ølbrygging',
            text: `Hei ${application.name}!\n\nSøknaden din er godkjent. Opprett passordet ditt ved å åpne denne sikre lenken innen 48 timer:\n\n${publicBaseUrl}/#setup=${encodeURIComponent(setupToken)}\n\nHvis du ikke ba om dette, kan du se bort fra e-posten.`,
          }),
        });
        sent = response.ok && !response.redirected;
        await response.body?.cancel();
      } catch {
        // The account and invitation token are durable before email delivery is attempted.
      }
    }
    try {
      await request(`/api/portal/ambassador-applications/${application.id}/invitation-status`, {
        token, method: 'POST', body: { status: sent ? 'sent' : 'failed', setupTokenHash: tokenHash },
      });
    } catch {
      // The durable pending state can be safely retried by rotating the setup token.
      sent = false;
    }
    return { ...application, invitationStatus: sent ? 'sent' : 'failed' };
  }

  async function reviewApplication(token, id, decision) {
    const setupToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(setupToken).digest('hex');
    const setupTokenExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const temporaryPassword = randomBytes(48).toString('base64url');
    const application = await request(`/api/portal/ambassador-applications/${id}/decision`, {
      token, method: 'POST', body: {
        decision, setupTokenHash: tokenHash, setupTokenExpiresAt, temporaryPassword,
      },
    });
    return sendInvitation(token, application.application, setupToken);
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
          subject: `Ølbrygging · #${ticket.displayNumber || ticket.number}: ${ticket.subject}`,
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
    if (pathname === '/api/ambassador-applications' && req.method === 'POST') {
      const input = application.validateApplication(await readBody(req), (message) => new ApiError(400, message));
      await request('/api/portal/ambassador-applications', { method: 'POST', body: input });
      return { status: 201, body: { submitted: true } };
    }
    if (pathname === '/api/ambassador-account/setup' && req.method === 'POST') {
      const input = await readBody(req);
      checkFields(input, ['token', 'password']);
      const setupToken = text(input.token, 'Invitasjonslenke', 128);
      const password = input.password;
      if (setupToken.length !== 64 || !/^[a-f0-9]{64}$/.test(setupToken)
        || typeof password !== 'string' || password.length < 12 || password.length > 128) {
        throw new ApiError(400, 'Lenken er ugyldig eller utløpt, eller passordet er for kort.');
      }
      const setupTokenHash = createHash('sha256').update(setupToken).digest('hex');
      return { status: 200, body: await request('/api/portal/ambassador-account/setup', {
        method: 'POST', body: { setupTokenHash, password },
      }) };
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
    if (pathname === '/api/ambassador-applications' && req.method === 'GET') {
      return { status: 200, body: await request('/api/portal/ambassador-applications', { token: auth.token }) };
    }
    const applicationMatch = pathname.match(/^\/api\/ambassador-applications\/([a-z0-9]{15})\/(decision|retry-invitation)$/);
    if (applicationMatch && req.method === 'POST') {
      const input = await readBody(req);
      checkFields(input, applicationMatch[2] === 'decision' ? ['decision'] : []);
      const decision = applicationMatch[2] === 'retry-invitation' ? 'retry_invitation' : input.decision;
      if (!['approved', 'declined', 'retry_invitation'].includes(decision)) throw new ApiError(400, 'Velg godkjenning eller avslag.');
      try {
        if (decision === 'declined') {
          const result = await request(`/api/portal/ambassador-applications/${applicationMatch[1]}/decision`, {
            token: auth.token, method: 'POST', body: { decision },
          });
          return { status: 200, body: { application: result.application } };
        }
        const invitation = await reviewApplication(auth.token, applicationMatch[1], decision);
        return { status: 200, body: { application: invitation } };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          throw new ApiError(409, 'Søknaden er allerede behandlet, eller e-postadressen er knyttet til en eksisterende konto. Kontroller søknaden.');
        }
        throw error;
      }
    }
    const submissionFileMatch = pathname.match(/^\/api\/submissions\/([a-z0-9]{15})\/files\/([^/]+)$/);
    if (submissionFileMatch && req.method === 'GET') {
      return downloadSubmissionFile(submissionFileMatch[1], submissionFileMatch[2], auth.token);
    }
    const uploadMatch = pathname.match(/^\/api\/tickets\/([a-z0-9]{15})\/submissions$/);
    if (uploadMatch && req.method === 'POST') {
      const input = await validateSubmission(await readMultipart(req));
      const form = new FormData();
      form.append('caption', input.caption);
      form.append('link', input.link);
      for (const file of input.files) form.append('files', new Blob([file.data], { type: file.type }), file.name);
      return { status: 201, body: await requestMultipart(`/api/portal/tickets/${uploadMatch[1]}/submissions`, { token: auth.token, form }) };
    }
    const publicationMatch = pathname.match(/^\/api\/tickets\/([a-z0-9]{15})\/publication$/);
    if (publicationMatch) {
      const input = await readBody(req);
      checkFields(input, ['url']);
      return { status: 200, body: await request(`/api/portal/tickets/${publicationMatch[1]}/publication`, { token: auth.token, method: 'PATCH', body: input }) };
    }
    const decisionMatch = pathname.match(/^\/api\/submissions\/([a-z0-9]{15})\/decision$/);
    if (decisionMatch) {
      const input = await readBody(req);
      checkFields(input, ['decision', 'feedback']);
      return { status: 200, body: await request(`/api/portal/submissions/${decisionMatch[1]}/decision`, { token: auth.token, method: 'POST', body: input }) };
    }
    if (pathname === '/api/products/preview') {
      const input = await readBody(req);
      checkFields(input, ['url']);
      return { status: 200, body: { product: await options.readProductPage(input.url) } };
    }
    if (pathname === '/api/tasks') {
      if (auth.user.role !== 'employee') throw new ApiError(403, 'Bare ansatte kan opprette åpne oppgaver.');
      const input = await readBody(req);
      checkFields(input, ['productUrl', 'subject', 'description', 'acceptBy', 'dueDate', 'promotionCount']);
      input.promotionCount = promotionQuantity(input.promotionCount);
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
      checkFields(input, ['productId', 'productUrl', 'subject', 'description', 'channel', 'dueDate', 'ambassadorId', 'promotionCount']);
      if (input.promotionCount !== undefined) input.promotionCount = promotionQuantity(input.promotionCount);
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
