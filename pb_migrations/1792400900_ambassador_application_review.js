migrate((app) => {
  const users = app.findCollectionByNameOrId('users');
  if (!users.fields.getByName('isPortalAdmin')) {
    users.fields.add(new BoolField({ name: 'isPortalAdmin' }));
    app.save(users);
  }

  const applications = app.findCollectionByNameOrId('ambassador_applications');
  const fields = [
    new RelationField({ name: 'reviewerId', maxSelect: 1, collectionId: users.id }),
    new TextField({ name: 'reviewedAt', max: 40 }),
    new SelectField({ name: 'invitationStatus', maxSelect: 1, values: ['not_sent', 'pending', 'sent', 'failed', 'accepted'] }),
    new TextField({ name: 'setupTokenHash', max: 64 }),
    new TextField({ name: 'setupTokenExpiresAt', max: 40 }),
  ];
  for (const field of fields) {
    if (!applications.fields.getByName(field.name)) applications.fields.add(field);
  }
  app.save(applications);
}, () => {
  // Retain review and invitation history if the migration marker is rolled back.
});