migrate((app) => {
  const applications = app.findCollectionByNameOrId('ambassador_applications');
  const legacySocialUrls = applications.fields.getByName('socialUrls');
  if (legacySocialUrls.required) {
    legacySocialUrls.required = false;
    app.save(applications);
  }
  if (!applications.fields.getByName('socialLinks')) {
    // Keep socialUrls in place for historical applications; new submissions
    // use a keyed object so each profile remains associated with its platform.
    applications.fields.add(new JSONField({ name: 'socialLinks', maxSize: 64000 }));
    app.save(applications);
  }
}, () => {
  // Preserve socialLinks data on rollback.
});
