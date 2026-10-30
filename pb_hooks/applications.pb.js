routerAdd('POST', '/api/portal/ambassador-applications', (e) => {
  if (!/^application\/json(?:;|$)/i.test(e.request.header.get('Content-Type'))) {
    throw new ApiError(415, 'Bruk Content-Type: application/json.');
  }
  const { validateApplication, TERMS_VERSION } = require(__hooks + '/application.cjs');
  const input = validateApplication(e.requestInfo().body, (message) => new BadRequestError(message));
  e.app.runInTransaction((app) => {
    // Repeated submissions never overwrite reviewed/contact data or disclose
    // whether an email belongs to an applicant or an authenticated account.
    const recent = app.findRecordsByFilter('ambassador_applications',
      'email = {:email} && createdAt >= {:since}', '', 1, 0,
      { email: input.email, since: new Date(Date.now() - 86400000).toISOString() });
    if (recent.length) return;
    const record = new Record(app.findCollectionByNameOrId('ambassador_applications'));
    for (const [key, value] of Object.entries(input)) record.set(key, value);
    record.set('status', 'pending');
    record.set('termsVersion', TERMS_VERSION);
    record.set('termsAcceptedAt', new Date().toISOString());
    app.save(record);
  });
  return e.json(201, { submitted: true });
}, $apis.bodyLimit(24 * 1024));

// Even trusted administration may only link an ambassador, never an employee
// or superuser. Linking is deliberate: possession of an email isn't identity.
onRecordValidate((e) => {
  const userId = e.record.getString('userId');
  if (userId) {
    const user = e.app.findRecordById('users', userId);
    if (user.getString('role') !== 'ambassador') throw new BadRequestError('Brukeren må være ambassadør.');
  }
  e.next();
}, 'ambassador_applications');