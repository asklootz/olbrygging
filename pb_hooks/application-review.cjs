function requirePortalAdmin(app, id) {
  let user;
  try { user = app.findRecordById('users', id); } catch (_) {
    throw new UnauthorizedError('Logg inn for å fortsette.');
  }
  if (!user.getBool('isPortalAdmin') || user.getString('role') !== 'employee') {
    throw new ApiError(403, 'Bare administratorer kan behandle ambassadørsøknader.');
  }
  return user;
}

function applicationJSON(record) {
  return {
    id: record.id, name: record.getString('name'), phone: record.getString('phone'), email: record.getString('email'),
    addressLine1: record.getString('addressLine1'), addressLine2: record.getString('addressLine2'),
    postalCode: record.getString('postalCode'), city: record.getString('city'), region: record.getString('region'),
    country: record.getString('country'), socialLinks: record.get('socialLinks') || {}, status: record.getString('status'),
    createdAt: new Date(record.getString('createdAt').replace(' ', 'T')).toISOString(), userId: record.getString('userId') || null,
    reviewerId: record.getString('reviewerId') || null, reviewedAt: record.getString('reviewedAt') || null,
    invitationStatus: record.getString('invitationStatus') || 'not_sent',
  };
}

function reviewInput(e) {
  if (!/^application\/json(?:;|$)/i.test(e.request.header.get('Content-Type'))) {
    throw new ApiError(415, 'Bruk Content-Type: application/json.');
  }
  return e.requestInfo().body;
}

function setupCredentials(input) {
  if (typeof input.setupTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.setupTokenHash)
    || typeof input.setupTokenExpiresAt !== 'string' || !Number.isFinite(Date.parse(input.setupTokenExpiresAt))
    || Date.parse(input.setupTokenExpiresAt) <= Date.now()
    || Date.parse(input.setupTokenExpiresAt) > Date.now() + 49 * 60 * 60 * 1000
    || typeof input.temporaryPassword !== 'string' || input.temporaryPassword.length < 32 || input.temporaryPassword.length > 128) {
    throw new BadRequestError('Ugyldig invitasjon.');
  }
}

function list(e) {
  let user;
  try { user = e.app.findRecordById('users', e.auth.id); } catch (_) {
    return e.json(401, { message: 'Logg inn for å fortsette.' });
  }
  if (!user.getBool('isPortalAdmin') || user.getString('role') !== 'employee') {
    return e.json(403, { message: 'Bare administratorer kan behandle ambassadørsøknader.' });
  }
  const applications = e.app.findRecordsByFilter('ambassador_applications', '', '-createdAt', 0, 0).map(applicationJSON);
  return e.json(200, { applications });
}

function decide(e) {
  const input = reviewInput(e);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['decision', 'setupTokenHash', 'setupTokenExpiresAt', 'temporaryPassword'].includes(key))) {
    throw new BadRequestError('Ugyldig beslutning.');
  }
  const decision = input.decision;
  if (!['approved', 'declined', 'retry_invitation'].includes(decision)) throw new BadRequestError('Velg godkjenning eller avslag.');
  if (decision !== 'declined') setupCredentials(input);
  let result;
  e.app.runInTransaction((app) => {
    const reviewer = requirePortalAdmin(app, e.auth.id);
    let application;
    try { application = app.findRecordById('ambassador_applications', e.request.pathValue('id')); } catch (_) {
      throw new NotFoundError('Fant ikke søknaden.');
    }
    if (decision === 'retry_invitation') {
      if (application.getString('status') !== 'approved' || application.getString('invitationStatus') === 'accepted'
        || !application.getString('userId')) throw new ApiError(409, 'Denne søknaden kan ikke inviteres på nytt.');
      application.set('setupTokenHash', input.setupTokenHash);
      application.set('setupTokenExpiresAt', input.setupTokenExpiresAt);
      application.set('invitationStatus', 'pending');
      app.save(application);
      result = applicationJSON(application);
      return;
    }
    if (application.getString('status') !== 'pending') throw new ApiError(409, 'Søknaden er allerede behandlet.');
    if (decision === 'declined') {
      application.set('status', 'declined');
      application.set('invitationStatus', 'not_sent');
    } else {
      const email = application.getString('email').toLowerCase();
      const existingUsers = app.findRecordsByFilter('users', '', '', 0, 0);
      if (existingUsers.some((user) => user.getString('email').toLowerCase() === email)) {
        throw new ApiError(409, 'E-postadressen er allerede knyttet til en konto. Kontroller identiteten før manuell oppfølging.');
      }
      const ambassador = new Record(app.findCollectionByNameOrId('users'));
      ambassador.set('email', email);
      ambassador.set('name', application.getString('name'));
      ambassador.set('role', 'ambassador');
      ambassador.set('socialMedia', '');
      ambassador.set('isPortalAdmin', false);
      ambassador.set('emailVisibility', false);
      ambassador.setPassword(input.temporaryPassword);
      app.save(ambassador);
      application.set('userId', ambassador.id);
      application.set('status', 'approved');
      application.set('invitationStatus', 'pending');
      application.set('setupTokenHash', input.setupTokenHash);
      application.set('setupTokenExpiresAt', input.setupTokenExpiresAt);
    }
    application.set('reviewerId', reviewer.id);
    application.set('reviewedAt', new Date().toISOString());
    app.save(application);
    result = applicationJSON(application);
  });
  return e.json(200, { application: result });
}

function invitationStatus(e) {
  const input = reviewInput(e);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['status', 'setupTokenHash'].includes(key))
    || !['sent', 'failed'].includes(input.status) || !/^[a-f0-9]{64}$/.test(input.setupTokenHash || '')) {
    throw new BadRequestError('Ugyldig leveringsstatus.');
  }
  e.app.runInTransaction((app) => {
    requirePortalAdmin(app, e.auth.id);
    let application;
    try { application = app.findRecordById('ambassador_applications', e.request.pathValue('id')); } catch (_) {
      throw new NotFoundError('Fant ikke søknaden.');
    }
    if (application.getString('status') !== 'approved' || application.getString('invitationStatus') === 'accepted'
      || application.getString('setupTokenHash') !== input.setupTokenHash) {
      throw new ApiError(409, 'Invitasjonen er allerede brukt eller fornyet.');
    }
    application.set('invitationStatus', input.status);
    app.save(application);
  });
  return e.json(200, {});
}

function setup(e) {
  const input = reviewInput(e);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['setupTokenHash', 'password'].includes(key))
    || typeof input.setupTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.setupTokenHash)
    || typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) {
    throw new BadRequestError('Oppgi invitasjonens lenke og et passord på minst 12 tegn.');
  }
  e.app.runInTransaction((app) => {
    let application;
    try {
      application = app.findFirstRecordByFilter('ambassador_applications',
        'setupTokenHash = {:hash} && status = "approved"', { hash: input.setupTokenHash });
    } catch (_) { throw new ApiError(400, 'Invitasjonen er ugyldig eller utløpt.'); }
    if (!application.getString('setupTokenExpiresAt') || Date.parse(application.getString('setupTokenExpiresAt')) <= Date.now()
      || application.getString('invitationStatus') === 'accepted') {
      throw new ApiError(400, 'Invitasjonen er ugyldig eller utløpt.');
    }
    let ambassador;
    try { ambassador = app.findRecordById('users', application.getString('userId')); } catch (_) {
      throw new ApiError(400, 'Invitasjonen er ugyldig eller utløpt.');
    }
    if (ambassador.getString('role') !== 'ambassador') throw new ApiError(400, 'Invitasjonen er ugyldig eller utløpt.');
    ambassador.setPassword(input.password);
    ambassador.set('verified', true);
    app.save(ambassador);
    application.set('setupTokenHash', '');
    application.set('setupTokenExpiresAt', '');
    application.set('invitationStatus', 'accepted');
    app.save(application);
  });
  return e.json(200, { completed: true });
}

module.exports = { list, decide, invitationStatus, setup };