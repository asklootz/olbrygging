routerAdd("GET", "/api/portal/workspace", (e) => {
  return require(__hooks + "/portal.js").workspace(e);
}, $apis.requireAuth("users"));

routerAdd("PATCH", "/api/portal/profile", (e) => {
  return require(__hooks + "/portal.js").profile(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("PATCH", "/api/portal/users/{id}", (e) => {
  return require(__hooks + "/portal.js").updateUser(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("GET", "/api/portal/articles", (e) => {
  return require(__hooks + "/portal.js").articles(e);
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/portal/articles", (e) => {
  return require(__hooks + "/portal.js").createArticle(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("PATCH", "/api/portal/articles/{id}", (e) => {
  return require(__hooks + "/portal.js").updateArticle(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("POST", "/api/portal/damage-reports", (e) => {
  return require(__hooks + "/portal.js").createDamageReport(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("PATCH", "/api/portal/damage-reports/{id}", (e) => {
  return require(__hooks + "/portal.js").reviewDamageReport(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("POST", "/api/portal/tickets", (e) => {
  return require(__hooks + "/portal.js").create(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("POST", "/api/portal/tasks", (e) => {
  return require(__hooks + "/portal.js").createTask(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("POST", "/api/portal/tickets/{id}/accept", (e) => {
  return require(__hooks + "/portal.js").acceptTask(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("PATCH", "/api/portal/tickets/{id}", (e) => {
  return require(__hooks + "/portal.js").update(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("POST", "/api/portal/tickets/{id}/messages", (e) => {
  return require(__hooks + "/portal.js").message(e);
}, $apis.requireAuth("users"), $apis.bodyLimit(24 * 1024));

routerAdd("POST", "/api/portal/messages/{id}/email-result", (e) => {
  return require(__hooks + "/portal.js").emailResult(e);
}, $apis.requireSuperuserAuth(), $apis.bodyLimit(24 * 1024));
