migrate((app) => {
  const collection = (options) => {
    const fields = options.fields;
    delete options.fields;
    const result = new Collection(options);
    for (const field of fields) result.fields.add(field);
    return result;
  };
  const users = app.findCollectionByNameOrId("users");
  users.listRule = null;
  users.viewRule = null;
  users.createRule = null;
  users.updateRule = null;
  users.deleteRule = null;
  users.manageRule = null;
  users.fields.add(new TextField({ name: "name", required: true, max: 160 }));
  users.fields.add(new SelectField({ name: "role", required: true, maxSelect: 1, values: ["employee", "ambassador"] }));
  users.fields.add(new TextField({ name: "socialMedia", max: 200 }));
  users.passwordAuth = { enabled: true, identityFields: ["email"] };
  users.authToken = { duration: 43200 };
  app.save(users);

  const authenticated = "@request.auth.id != '' && @request.auth.collectionName = 'users'";
  const ownsTicket = authenticated + " && (@request.auth.role = 'employee' || ambassadorId = @request.auth.id)";
  const timestamps = () => [
    new AutodateField({ name: "createdAt", onCreate: true }),
    new AutodateField({ name: "updatedAt", onCreate: true, onUpdate: true }),
  ];
  const products = collection({
    type: "base", name: "products", listRule: authenticated, viewRule: authenticated,
    fields: [
      new TextField({ name: "slug", required: true, max: 100, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }),
      new TextField({ name: "name", required: true, max: 160 }),
      new TextField({ name: "category", required: true, max: 100 }),
      new TextField({ name: "description", required: true, max: 5000 }),
      new NumberField({ name: "price", min: 0 }),
      new BoolField({ name: "available" }),
      ...timestamps(),
    ],
    indexes: ["CREATE UNIQUE INDEX idx_products_slug ON products (slug)"],
  });
  app.save(products);

  const tickets = collection({
    type: "base", name: "tickets", listRule: ownsTicket, viewRule: ownsTicket,
    fields: [
      new NumberField({ name: "number", required: true, onlyInt: true, min: 1001 }),
      new TextField({ name: "subject", required: true, max: 160 }),
      new TextField({ name: "description", required: true, max: 5000 }),
      new TextField({ name: "productUrl", max: 2000 }),
      new JSONField({ name: "productSnapshot" }),
      new RelationField({ name: "productId", required: true, maxSelect: 1, collectionId: products.id }),
      new RelationField({ name: "ambassadorId", required: true, maxSelect: 1, collectionId: users.id }),
      new RelationField({ name: "assigneeId", required: true, maxSelect: 1, collectionId: users.id }),
      new SelectField({ name: "status", required: true, maxSelect: 1, values: ["requested", "approved", "in_progress", "review", "completed", "declined"] }),
      new SelectField({ name: "channel", required: true, maxSelect: 1, values: ["Instagram", "TikTok", "YouTube", "Blogg", "Annet"] }),
      new TextField({ name: "dueDate", pattern: "^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$", max: 10 }),
      ...timestamps(),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_tickets_number ON tickets (number)",
      "CREATE INDEX idx_tickets_ambassador ON tickets (ambassadorId)",
      "CREATE INDEX idx_tickets_assignee ON tickets (assigneeId)",
    ],
  });
  app.save(tickets);

  app.save(collection({
    type: "base", name: "articles",
    fields: [
      new TextField({ name: "title", required: true, max: 160 }),
      new TextField({ name: "body", required: true, max: 12000 }),
      new TextField({ name: "category", required: true, max: 60 }),
      new RelationField({ name: "authorId", required: true, maxSelect: 1, collectionId: users.id }),
      new RelationField({ name: "updatedBy", required: true, maxSelect: 1, collectionId: users.id }),
      ...timestamps(),
    ],
    indexes: ["CREATE INDEX idx_articles_updated ON articles (updatedAt DESC)"],
  }));
  app.save(collection({
    type: "base", name: "damage_reports",
    fields: [
      new RelationField({ name: "ambassadorId", required: true, maxSelect: 1, collectionId: users.id }),
      new RelationField({ name: "productId", maxSelect: 1, collectionId: products.id }),
      new RelationField({ name: "ticketId", maxSelect: 1, collectionId: tickets.id }),
      new TextField({ name: "description", required: true, max: 5000 }),
      new SelectField({ name: "status", required: true, maxSelect: 1, values: ["pending", "approved", "rejected"] }),
      new RelationField({ name: "reviewedBy", maxSelect: 1, collectionId: users.id }),
      new TextField({ name: "reviewNote", max: 1000 }),
      ...timestamps(),
    ],
    indexes: ["CREATE INDEX idx_damage_reports_created ON damage_reports (createdAt DESC)"],
  }));
  const readsMessage = authenticated + " && (@request.auth.role = 'employee' || ticketId.ambassadorId = @request.auth.id)";
  app.save(collection({
    type: "base", name: "messages", listRule: readsMessage, viewRule: readsMessage,
    fields: [
      new RelationField({ name: "ticketId", required: true, maxSelect: 1, collectionId: tickets.id, cascadeDelete: true }),
      new RelationField({ name: "authorId", required: true, maxSelect: 1, collectionId: users.id }),
      new TextField({ name: "body", required: true, max: 5000 }),
      new SelectField({ name: "emailStatus", required: true, maxSelect: 1, values: ["not_requested", "failed", "sent"] }),
      ...timestamps(),
    ],
    indexes: ["CREATE INDEX idx_messages_ticket_created ON messages (ticketId, createdAt, id)"],
  }));
  const counters = collection({
    type: "base", name: "portal_counters",
    fields: [
      new TextField({ name: "key", required: true }),
      new NumberField({ name: "value", required: true, onlyInt: true, min: 1000 }),
    ],
    indexes: ["CREATE UNIQUE INDEX idx_portal_counters_key ON portal_counters (key)"],
  });
  app.save(counters);
  const counter = new Record(counters);
  counter.set("key", "tickets");
  counter.set("value", 1000);
  app.save(counter);

  const catalogue = [
    ["fjord-pale", "Fjordglød Pale Ale", "Ølsett", "Friskt allgrain-sett med sitrus, norsk bryggeglede og en gyllen avslutning. 20 liter.", 449],
    ["skog-ipa", "Skogbris IPA", "Ølsett", "Et aromatisk ølsett med tropiske toner og en tydelig, balansert bitterhet. 20 liter.", 529],
    ["kveld-pils", "Lys kveld Pilsner", "Ølsett", "Ren og lettdrikkelig pilsner til lange sommerkvelder. 20 liter.", 399],
    ["brew-kettle", "Bryggekjele 30 L", "Bryggeutstyr", "Solid rustfri bryggekjele med tappekran og tydelig literskala.", 1890],
    ["fermenter", "Gjæringskar 30 L", "Bryggeutstyr", "Praktisk gjæringskar med gjærlås, lokk og tappekran.", 349],
    ["hop-citra", "Citra humle 100 g", "Råvarer", "Pelletshumle med frisk sitrus, pasjonsfrukt og et tropisk løft.", 109],
    ["malt", "Pale Ale malt 5 kg", "Råvarer", "En allsidig basemalt med lett brødpreg til ditt neste hjemmebrygg.", 189],
    ["glass", "Smaksglass, 2-pakning", "Tilbehør", "Tulipanformede glass som gir plass til både aroma og skumkrone.", 249],
  ];
  for (const [slug, name, category, description, price] of catalogue) {
    const record = new Record(products);
    for (const [key, value] of Object.entries({ slug, name, category, description, price, available: true })) record.set(key, value);
    app.save(record);
  }
}, (app) => {
  for (const name of ["messages", "damage_reports", "articles", "tickets", "portal_counters", "products"]) {
    app.delete(app.findCollectionByNameOrId(name));
  }
  // Keep accounts and their roles private on rollback rather than reopening signup.
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("role");
  users.fields.removeByName("socialMedia");
  app.save(users);
});
