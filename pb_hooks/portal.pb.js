routerAdd("GET", "/api/portal/workspace", (e) => {
  return require(__hooks + "/portal.js").workspace(e);
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/portal/tickets", (e) => {
  return require(__hooks + "/portal.js").create(e);
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
