migrate((app) => {
  const tickets = app.findCollectionByNameOrId("tickets");
  if (!tickets.fields.getByName("publicationUrl")) {
    tickets.fields.add(new TextField({ name: "publicationUrl", max: 2000 }));
    app.save(tickets);
  }

  let existing = null;
  try { existing = app.findCollectionByNameOrId("content_submissions"); } catch (_) { /* The collection is added below on first install. */ }
  if (existing) {
    for (const name of ["ticketId", "submittedBy", "version", "files", "status"]) {
      if (!existing.fields.getByName(name)) throw new Error("Existing content_submissions collection has an incompatible schema.");
    }
    return;
  }

  const users = app.findCollectionByNameOrId("users");
  const authenticated = "@request.auth.id != '' && @request.auth.collectionName = 'users'";
  const readsSubmission = authenticated + " && (@request.auth.role = 'employee' || ticketId.ambassadorId = @request.auth.id)";
  const submissionFields = [
    new RelationField({ name: "ticketId", required: true, maxSelect: 1, collectionId: tickets.id, cascadeDelete: true }),
    new RelationField({ name: "submittedBy", required: true, maxSelect: 1, collectionId: users.id }),
    new NumberField({ name: "version", required: true, onlyInt: true, min: 1 }),
    new TextField({ name: "caption", max: 1500 }),
    new TextField({ name: "link", max: 2000 }),
    new FileField({
      name: "files", required: true, maxSelect: 5, maxSize: 20 * 1024 * 1024,
      mimeTypes: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"], protected: true,
    }),
    new SelectField({ name: "status", required: true, maxSelect: 1, values: ["submitted", "approved", "changes_requested"] }),
    new RelationField({ name: "reviewerId", maxSelect: 1, collectionId: users.id }),
    new TextField({ name: "feedback", max: 2000 }),
    new TextField({ name: "decidedAt", max: 40 }),
    new AutodateField({ name: "createdAt", onCreate: true }),
  ];
  const submissions = new Collection({
    type: "base", name: "content_submissions", listRule: readsSubmission, viewRule: readsSubmission,
    createRule: null, updateRule: null, deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX idx_content_submissions_ticket_version ON content_submissions (ticketId, version)",
      "CREATE INDEX idx_content_submissions_ticket_created ON content_submissions (ticketId, createdAt DESC)",
    ],
  });
  for (const field of submissionFields) submissions.fields.add(field);
  app.save(submissions);
}, () => {
  // Keep submitted media and publication URLs when rolling back the migration marker.
});