// Trusted, offline database-owner command; no HTTP import route or superuser
// credentials are exposed. Stop serve before running this command.
$app.rootCmd.addCommand(new Command({
  use: 'portal-import-users',
  short: 'Import portal users from the local import launcher',
  run: () => {
    const input = JSON.parse($os.getenv('OLBRYGGING_IMPORT_USERS') || 'null');
    if (!Array.isArray(input)) throw new Error('Run npm run pocketbase:import-users instead.');
    $app.runAllMigrations();
    let created = 0;
    let existing = 0;
    $app.runInTransaction((app) => {
      const collection = app.findCollectionByNameOrId('users');
      const seen = {};
      for (const user of input) {
        if (!user || typeof user.email !== 'string' || user.email !== user.email.trim().toLowerCase()
          || !['employee', 'ambassador'].includes(user.role) || typeof user.password !== 'string'
          || user.password.length < 12 || seen[user.email]) throw new Error('Invalid import input.');
        seen[user.email] = true;
        const matches = app.findRecordsByFilter('users', 'email = {:email}', '', 1, 0, { email: user.email });
        if (matches.length) { existing++; continue; }
        const record = new Record(collection);
        record.set('email', user.email);
        record.set('name', user.name);
        record.set('role', user.role);
        record.set('socialMedia', user.socialMedia || '');
        record.set('emailVisibility', false);
        record.setPassword(user.password);
        app.save(record);
        created++;
      }
    });
    console.log(`User import complete: ${created} created, ${existing} existing accounts left unchanged.`);
  },
}));