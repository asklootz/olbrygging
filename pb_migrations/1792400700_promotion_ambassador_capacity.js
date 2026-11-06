migrate((app) => {
  const tickets = app.findCollectionByNameOrId('tickets');
  if (!tickets.fields.getByName('promotionOpen')) {
    tickets.fields.add(new BoolField({ name: 'promotionOpen' }));
  }
  const index = "CREATE UNIQUE INDEX idx_tickets_promotion_ambassador ON tickets (promotionBase, ambassadorId) WHERE promotionOpen = 1 AND promotionBase > 0 AND ambassadorId != ''";
  if (tickets.indexes.indexOf(index) < 0) {
    tickets.indexes = [...tickets.indexes.filter((item) => !item.includes('idx_tickets_promotion_ambassador')), index];
    app.save(tickets);
  }
}, () => {
  // Preserve accepted promotion instances and their uniqueness constraint on rollback.
});
