migrate((app) => {
  const users = app.findCollectionByNameOrId('users');
  const applications = new Collection({
    type: 'base', name: 'ambassador_applications',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: [
      'CREATE INDEX idx_ambassador_applications_email ON ambassador_applications (email)',
      'CREATE INDEX idx_ambassador_applications_status ON ambassador_applications (status, createdAt)',
      "CREATE UNIQUE INDEX idx_ambassador_applications_user ON ambassador_applications (userId) WHERE userId != ''",
    ],
  });
  const fields = [
    new RelationField({ name: 'userId', collectionId: users.id, maxSelect: 1 }),
    new TextField({ name: 'name', required: true, max: 160 }),
    new TextField({ name: 'phone', required: true, max: 40 }),
    new EmailField({ name: 'email', required: true }),
    new TextField({ name: 'addressLine1', required: true, max: 200 }),
    new TextField({ name: 'addressLine2', max: 200 }),
    new TextField({ name: 'postalCode', required: true, max: 20 }),
    new TextField({ name: 'city', required: true, max: 100 }),
    new TextField({ name: 'region', max: 100 }),
    new TextField({ name: 'country', required: true, max: 100 }),
    new JSONField({ name: 'socialUrls', required: true, maxSize: 12000 }),
    new BoolField({ name: 'termsAccepted', required: true }),
    new TextField({ name: 'termsVersion', required: true, max: 40 }),
    new DateField({ name: 'termsAcceptedAt', required: true }),
    new SelectField({ name: 'status', required: true, maxSelect: 1, values: ['pending', 'approved', 'declined'] }),
    new AutodateField({ name: 'createdAt', onCreate: true }),
    new AutodateField({ name: 'updatedAt', onCreate: true, onUpdate: true }),
  ];
  for (const field of fields) applications.fields.add(field);
  app.save(applications);
}, (app) => {
  app.delete(app.findCollectionByNameOrId('ambassador_applications'));
});