migrate((app) => {
  const applications = app.findCollectionByNameOrId('ambassador_applications');
  // Ten 1,000-character URLs can exceed 12 KB with international characters
  // or JSON escaping. Public requests remain bounded by the 24 KB body limit.
  applications.fields.getByName('socialUrls').maxSize = 64000;
  app.save(applications);
}, () => {
  // Preserve accepted international links rather than shrinking their storage.
});