// Older installations already recorded the initial migration before profile,
// article and damage-report support was added to it. Only add missing schema;
// never recreate collections, reset accounts or replace existing records.
migrate((app) => {
  const users = app.findCollectionByNameOrId('users');
  if (!users.fields.getByName('socialMedia')) {
    users.fields.add(new TextField({ name: 'socialMedia', max: 200 }));
    app.save(users);
  }
  const tickets = app.findCollectionByNameOrId('tickets');
  let changed = false;
  if (!tickets.fields.getByName('productUrl')) {
    tickets.fields.add(new TextField({ name: 'productUrl', max: 2000 }));
    changed = true;
  }
  if (!tickets.fields.getByName('productSnapshot')) {
    tickets.fields.add(new JSONField({ name: 'productSnapshot' }));
    changed = true;
  }
  if (changed) app.save(tickets);

  const timestamps = () => [
    new AutodateField({ name: 'createdAt', onCreate: true }),
    new AutodateField({ name: 'updatedAt', onCreate: true, onUpdate: true }),
  ];
  const ensureCollection = (name, fields, indexes) => {
    let existing;
    try { existing = app.findCollectionByNameOrId(name); } catch (_) { /* Missing in older databases. */ }
    if (existing) return;
    const collection = new Collection({
      type: 'base', name, indexes,
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    });
    for (const field of fields) collection.fields.add(field);
    app.save(collection);
  };
  ensureCollection('articles', [
    new TextField({ name: 'title', required: true, max: 160 }),
    new TextField({ name: 'body', required: true, max: 12000 }),
    new TextField({ name: 'category', required: true, max: 60 }),
    new RelationField({ name: 'authorId', required: true, maxSelect: 1, collectionId: users.id }),
    new RelationField({ name: 'updatedBy', required: true, maxSelect: 1, collectionId: users.id }),
    ...timestamps(),
  ], ['CREATE INDEX idx_articles_updated ON articles (updatedAt DESC)']);
  const products = app.findCollectionByNameOrId('products');
  ensureCollection('damage_reports', [
    new RelationField({ name: 'ambassadorId', required: true, maxSelect: 1, collectionId: users.id }),
    new RelationField({ name: 'productId', maxSelect: 1, collectionId: products.id }),
    new RelationField({ name: 'ticketId', maxSelect: 1, collectionId: tickets.id }),
    new TextField({ name: 'description', required: true, max: 5000 }),
    new SelectField({ name: 'status', required: true, maxSelect: 1, values: ['pending', 'approved', 'rejected'] }),
    new RelationField({ name: 'reviewedBy', maxSelect: 1, collectionId: users.id }),
    new TextField({ name: 'reviewNote', max: 1000 }),
    ...timestamps(),
  ], ['CREATE INDEX idx_damage_reports_created ON damage_reports (createdAt DESC)']);
}, () => {
  // Intentionally preserve additive schema and user data on rollback.
});