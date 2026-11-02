migrate((app) => {
  const tickets = app.findCollectionByNameOrId('tickets');
  const fields = [
    new TextField({ name: 'displayNumber', max: 40 }),
    new NumberField({ name: 'promotionBase', onlyInt: true, min: 0 }),
    new NumberField({ name: 'promotionIndex', onlyInt: true, min: 0, max: 50 }),
    new NumberField({ name: 'promotionCount', onlyInt: true, min: 0, max: 50 }),
    new BoolField({ name: 'promotionOpen' }),
  ];
  let changed = false;
  for (const field of fields) {
    if (!tickets.fields.getByName(field.name)) {
      tickets.fields.add(field);
      changed = true;
    }
  }
  if (changed) {
    tickets.indexes = [...tickets.indexes.filter((index) => !index.includes('idx_tickets_promotion_instance')),
      "CREATE UNIQUE INDEX idx_tickets_promotion_instance ON tickets (promotionBase, promotionIndex) WHERE promotionBase > 0"];
    app.save(tickets);
  }
}, () => {
  // Preserve promotion instances and their history on rollback.
});
