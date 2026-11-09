// First-boot bootstrap for containerized deployments: creates the server-only
// PocketBase superuser (the account POCKETBASE_ADMIN_EMAIL /
// POCKETBASE_ADMIN_PASSWORD authenticate as) from the process environment,
// because the interactive `superuser create` command is unavailable in a
// headless container. An existing data directory with a superuser is left
// untouched, and locally the variables are normally unset, so this is a no-op.
migrate((app) => {
  const email = $os.getenv('POCKETBASE_ADMIN_EMAIL');
  const password = $os.getenv('POCKETBASE_ADMIN_PASSWORD');
  if (!email || !password) return;
  const rows = arrayOf(new DynamicModel({ id: '' }));
  app.db().newQuery('SELECT id FROM _superusers').all(rows);
  if (rows.length > 0) return;
  const superusers = app.findCollectionByNameOrId('_superusers');
  const record = new Record(superusers);
  record.set('email', email);
  record.set('password', password);
  app.save(record);
});