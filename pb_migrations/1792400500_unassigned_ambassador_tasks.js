migrate((app) => {
  const tickets = app.findCollectionByNameOrId('tickets');
  tickets.fields.getByName('productId').required = false;
  tickets.fields.getByName('ambassadorId').required = false;
  tickets.fields.getByName('channel').required = false;
  const status = tickets.fields.getByName('status');
  if (status.values.indexOf('available') < 0) status.values = [...status.values, 'available'];
  if (!tickets.fields.getByName('acceptBy')) {
    tickets.fields.add(new TextField({ name: 'acceptBy', pattern: '^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$', max: 10 }));
  }
  tickets.indexes = [...tickets.indexes.filter((index) => !index.includes('idx_tickets_available_accept')),
    'CREATE INDEX idx_tickets_available_accept ON tickets (status, acceptBy)'];
  app.save(tickets);
}, () => {
  // Preserve accepted and pending tasks; downgrading could orphan their data.
});
