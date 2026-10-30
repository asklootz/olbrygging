function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => allowed.indexOf(key) < 0)) {
    throw new BadRequestError("Forventet et JSON-objekt uten ukjente felt.");
  }
}

function text(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new BadRequestError("Teksten er tom, for lang eller ugyldig.");
  }
  return value.trim();
}

function date(value) {
  if (value === null || value === "") return "";
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
    || value.slice(0, 4) === "0000" || !isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new BadRequestError("Frist må være en gyldig dato (ÅÅÅÅ-MM-DD).");
  }
  return value;
}

function actor(app, id) {
  let user;
  try { user = app.findRecordById("users", id); } catch (_) {
    throw new UnauthorizedError("Logg inn for å fortsette.");
  }
  if (["employee", "ambassador"].indexOf(user.getString("role")) < 0) {
    throw new ForbiddenError("Kontoen har ingen gyldig rolle.");
  }
  return user;
}

function safeUser(user) {
  return {
    id: user.id, name: user.getString("name"), email: user.getString("email"),
    role: user.getString("role"), active: true, socialMedia: user.getString("socialMedia"),
  };
}

function articleJSON(article) {
  return {
    id: article.id, title: article.getString("title"), body: article.getString("body"),
    category: article.getString("category"), authorId: article.getString("authorId"),
    updatedBy: article.getString("updatedBy"), createdAt: timestamp(article, "createdAt"),
    updatedAt: timestamp(article, "updatedAt"),
  };
}

function damageReportJSON(app, report) {
  const productId = report.getString("productId");
  let productSlug = null;
  if (productId) productSlug = app.findRecordById("products", productId).getString("slug");
  return {
    id: report.id, ambassadorId: report.getString("ambassadorId"),
    productId: productSlug, ticketId: report.getString("ticketId") || null,
    description: report.getString("description"), status: report.getString("status"),
    createdAt: timestamp(report, "createdAt"), reviewedBy: report.getString("reviewedBy") || null,
    reviewNote: report.getString("reviewNote"),
  };
}

function productJSON(product) {
  return {
    id: product.getString("slug"), name: product.getString("name"),
    category: product.getString("category"), description: product.getString("description"),
    price: product.getFloat("price"), available: product.getBool("available"),
  };
}

function timestamp(record, field) {
  return new Date(record.getString(field).replace(" ", "T")).toISOString();
}

function messageJSON(message) {
  return {
    id: message.id, authorId: message.getString("authorId"), body: message.getString("body"),
    emailStatus: message.getString("emailStatus"),
    createdAt: timestamp(message, "createdAt"), updatedAt: timestamp(message, "updatedAt"),
  };
}

function ticketJSON(app, ticket) {
  const product = app.findRecordById("products", ticket.getString("productId"));
  const messages = app.findRecordsByFilter("messages", "ticketId = {:id}", "createdAt,id", 0, 0, { id: ticket.id });
  return {
    id: ticket.id, number: ticket.getInt("number"), subject: ticket.getString("subject"),
    description: ticket.getString("description"), productId: product.getString("slug"),
    productUrl: ticket.getString("productUrl"), productSnapshot: ticket.get("productSnapshot") || null,
    ambassadorId: ticket.getString("ambassadorId"), assigneeId: ticket.getString("assigneeId"),
    status: ticket.getString("status"), channel: ticket.getString("channel"),
    dueDate: ticket.getString("dueDate") || null,
    createdAt: timestamp(ticket, "createdAt"), updatedAt: timestamp(ticket, "updatedAt"),
    messages: messages.map(messageJSON),
  };
}

function authorizedTicket(app, id, user) {
  let ticket;
  try { ticket = app.findRecordById("tickets", id); } catch (_) {
    throw new NotFoundError("Fant ikke forespørselen.");
  }
  if (user.getString("role") !== "employee" && ticket.getString("ambassadorId") !== user.id) {
    throw new NotFoundError("Fant ikke forespørselen.");
  }
  return ticket;
}

function userWithRole(app, id, role) {
  if (typeof id !== "string") throw new BadRequestError("Ugyldig bruker.");
  let user;
  try { user = app.findRecordById("users", id); } catch (_) {
    throw new BadRequestError("Ugyldig bruker.");
  }
  if (user.getString("role") !== role) throw new BadRequestError("Ugyldig brukerrolle.");
  return user;
}

function profileFields(input) {
  fields(input, ["name", "email", "socialMedia"]);
  if (!Object.keys(input).length) throw new BadRequestError("Ingen endringer er oppgitt.");
  const result = {};
  if (input.name !== undefined) result.name = text(input.name, 160);
  if (input.email !== undefined) {
    const email = text(input.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestError("Oppgi en gyldig e-postadresse.");
    result.email = email;
  }
  if (input.socialMedia !== undefined) {
    result.socialMedia = input.socialMedia === "" ? "" : text(input.socialMedia, 200);
  }
  return result;
}

function saveProfile(app, user, input) {
  const changes = profileFields(input);
  if (changes.email !== undefined) {
    const users = app.findRecordsByFilter("users", "", "", 0, 0);
    if (users.some((record) => record.id !== user.id && record.getString("email").toLowerCase() === changes.email)) {
      throw new ApiError(409, "E-postadressen er allerede i bruk.");
    }
  }
  for (const [key, value] of Object.entries(changes)) user.set(key, value);
  app.save(user);
  return safeUser(user);
}

function body(e) {
  if (!/^application\/json(?:;|$)/i.test(e.request.header.get("Content-Type"))) {
    throw new ApiError(415, "Bruk Content-Type: application/json.");
  }
  return e.requestInfo().body;
}

module.exports = {
  workspace(e) {
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      const employee = user.getString("role") === "employee";
      const tickets = app.findRecordsByFilter("tickets", employee ? "" : "ambassadorId = {:id}", "-number", 0, 0, { id: user.id }).map((record) => ticketJSON(app, record));
      const relevant = {};
      relevant[user.id] = true;
      for (const ticket of tickets) {
        relevant[ticket.ambassadorId] = true;
        relevant[ticket.assigneeId] = true;
        for (const message of ticket.messages) relevant[message.authorId] = true;
      }
      result = {
        user: safeUser(user),
        users: app.findRecordsByFilter("users", "", "name,id", 0, 0)
          .filter((record) => employee || record.getString("role") === "employee" || relevant[record.id])
          .map(safeUser),
        products: app.findRecordsByFilter("products", "", "createdAt,id", 0, 0).map(productJSON),
        tickets,
        articles: app.findRecordsByFilter("articles", "", "-updatedAt,id", 0, 0).map(articleJSON),
        damageReports: app.findRecordsByFilter("damage_reports", employee ? "" : "ambassadorId = {:id}", "-createdAt,id", 0, 0, { id: user.id }).map((record) => damageReportJSON(app, record)),
      };
    });
    return e.json(200, result);
  },

  profile(e) {
    const input = body(e);
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      result = saveProfile(app, user, input);
    });
    return e.json(200, { user: result });
  },

  updateUser(e) {
    const input = body(e);
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "employee") throw new ForbiddenError("Bare ansatte kan redigere ambassadørprofiler.");
      const target = userWithRole(app, e.request.pathValue("id"), "ambassador");
      result = saveProfile(app, target, input);
    });
    return e.json(200, { user: result });
  },

  articles(e) {
    let result;
    e.app.runInTransaction((app) => {
      actor(app, e.auth.id);
      result = app.findRecordsByFilter("articles", "", "-updatedAt,id", 0, 0).map(articleJSON);
    });
    return e.json(200, { articles: result });
  },

  createArticle(e) {
    const input = body(e);
    fields(input, ["title", "body", "category"]);
    const title = text(input.title, 160);
    const content = text(input.body, 12000);
    const category = text(input.category, 60);
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "employee") throw new ForbiddenError("Bare ansatte kan publisere artikler.");
      const article = new Record(app.findCollectionByNameOrId("articles"));
      for (const [key, value] of Object.entries({
        title, body: content, category, authorId: user.id, updatedBy: user.id,
      })) article.set(key, value);
      app.save(article);
      result = articleJSON(article);
    });
    return e.json(201, { article: result });
  },

  updateArticle(e) {
    const input = body(e);
    fields(input, ["title", "body", "category"]);
    if (!Object.keys(input).length) throw new BadRequestError("Ingen endringer er oppgitt.");
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "employee") throw new ForbiddenError("Bare ansatte kan redigere artikler.");
      let article;
      try { article = app.findRecordById("articles", e.request.pathValue("id")); } catch (_) {
        throw new NotFoundError("Fant ikke artikkelen.");
      }
      if (input.title !== undefined) article.set("title", text(input.title, 160));
      if (input.body !== undefined) article.set("body", text(input.body, 12000));
      if (input.category !== undefined) article.set("category", text(input.category, 60));
      article.set("updatedBy", user.id);
      app.save(article);
      result = articleJSON(article);
    });
    return e.json(200, { article: result });
  },

  createDamageReport(e) {
    const input = body(e);
    fields(input, ["productId", "description", "ticketId"]);
    const description = text(input.description, 5000);
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "ambassador") throw new ForbiddenError("Skademeldinger kan bare opprettes av ambassadører.");
      let productId = "";
      if (input.productId !== undefined && input.productId !== "") {
        const slug = text(input.productId, 100);
        const products = app.findRecordsByFilter("products", "slug = {:slug}", "", 1, 0, { slug });
        if (!products.length) throw new BadRequestError("Velg et gyldig produkt.");
        productId = products[0].id;
      }
      let ticketId = "";
      if (input.ticketId !== undefined && input.ticketId !== "") {
        const ticket = authorizedTicket(app, text(input.ticketId, 100), user);
        if (!productId || ticket.getString("productId") !== productId) throw new BadRequestError("Produktet må stemme med samarbeidet.");
        ticketId = ticket.id;
      }
      const report = new Record(app.findCollectionByNameOrId("damage_reports"));
      for (const [key, value] of Object.entries({
        ambassadorId: user.id, productId, ticketId, description, status: "pending",
        reviewedBy: "", reviewNote: "",
      })) report.set(key, value);
      app.save(report);
      result = damageReportJSON(app, report);
    });
    return e.json(201, { report: result });
  },

  reviewDamageReport(e) {
    const input = body(e);
    fields(input, ["status", "reviewNote"]);
    if (["approved", "rejected"].indexOf(input.status) < 0) throw new BadRequestError("Velg godkjent eller avslått.");
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "employee") throw new ForbiddenError("Bare ansatte kan behandle skademeldinger.");
      let report;
      try { report = app.findRecordById("damage_reports", e.request.pathValue("id")); } catch (_) {
        throw new NotFoundError("Fant ikke skademeldingen.");
      }
      report.set("status", input.status);
      report.set("reviewedBy", user.id);
      if (input.reviewNote !== undefined) report.set("reviewNote", input.reviewNote === "" ? "" : text(input.reviewNote, 1000));
      app.save(report);
      result = damageReportJSON(app, report);
    });
    return e.json(200, { report: result });
  },

  create(e) {
    const input = body(e);
    fields(input, ["productId", "productUrl", "productSnapshot", "subject", "description", "channel", "dueDate", "ambassadorId"]);
    const subject = text(input.subject, 160);
    const description = text(input.description, 5000);
    const slug = text(input.productId, 100);
    const productUrl = input.productUrl === undefined ? "" : text(input.productUrl, 2000);
    let productSnapshot = null;
    if (input.productSnapshot !== undefined) {
      const snapshot = input.productSnapshot;
      fields(snapshot, ["url", "name", "description", "price", "currency", "image"]);
      if (!productUrl || snapshot.url !== productUrl || !/^https:\/\/www\.olbrygging\.no\/.+/i.test(productUrl)) {
        throw new BadRequestError("Ugyldig produktlenke eller produktinformasjon.");
      }
      if (typeof snapshot.name !== "string" || !snapshot.name.trim() || snapshot.name.length > 300
        || typeof snapshot.description !== "string" || snapshot.description.length > 2000
        || (snapshot.price !== null && (typeof snapshot.price !== "number" || !isFinite(snapshot.price) || snapshot.price < 0))
        || (snapshot.currency !== null && (typeof snapshot.currency !== "string" || snapshot.currency.length > 12))
        || (snapshot.image !== null && (typeof snapshot.image !== "string" || snapshot.image.length > 2000 || !/^https:\/\//i.test(snapshot.image)))) {
        throw new BadRequestError("Ugyldig produktinformasjon.");
      }
      productSnapshot = {
        url: productUrl, name: snapshot.name.trim(), description: snapshot.description,
        price: snapshot.price, currency: snapshot.currency, image: snapshot.image,
      };
    }
    if (["Instagram", "TikTok", "YouTube", "Blogg", "Annet"].indexOf(input.channel) < 0) throw new BadRequestError("Ugyldig kanal.");
    const dueDate = input.dueDate === undefined ? "" : date(input.dueDate);
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      let ambassadorId = user.id;
      if (user.getString("role") === "employee") {
        ambassadorId = userWithRole(app, input.ambassadorId, "ambassador").id;
      } else if (input.ambassadorId !== undefined && input.ambassadorId !== user.id) {
        throw new ForbiddenError("Du kan bare opprette egne forespørsler.");
      }
      const products = app.findRecordsByFilter("products", "slug = {:slug} && available = true", "", 1, 0, { slug });
      if (!products.length) throw new BadRequestError("Velg et tilgjengelig produkt.");
      const employees = app.findRecordsByFilter("users", "role = 'employee'", "created,id", 1, 0);
      if (!employees.length) throw new ApiError(409, "Ingen medarbeider er tilgjengelig.");
      const counter = app.findFirstRecordByFilter("portal_counters", "key = 'tickets'");
      const number = counter.getInt("value") + 1;
      counter.set("value", number);
      app.save(counter);
      const ticket = new Record(app.findCollectionByNameOrId("tickets"));
      for (const [key, value] of Object.entries({
        number, subject, description, productId: products[0].id, ambassadorId,
        productUrl, productSnapshot, assigneeId: employees[0].id, status: "requested", channel: input.channel, dueDate,
      })) ticket.set(key, value);
      app.save(ticket);
      result = ticketJSON(app, ticket);
    });
    return e.json(201, { ticket: result });
  },

  update(e) {
    const input = body(e);
    fields(input, ["status", "assigneeId", "dueDate"]);
    if (!Object.keys(input).length) throw new BadRequestError("Ingen endringer er oppgitt.");
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      const ticket = authorizedTicket(app, e.request.pathValue("id"), user);
      if (user.getString("role") !== "employee") {
        const transitions = { approved: "in_progress", in_progress: "review" };
        if (input.assigneeId !== undefined || input.dueDate !== undefined
          || !input.status || transitions[ticket.getString("status")] !== input.status) {
          throw new ForbiddenError("Du kan bare starte en godkjent oppgave eller sende den til vurdering.");
        }
      }
      if (input.status !== undefined) {
        if (["requested", "approved", "in_progress", "review", "completed", "declined"].indexOf(input.status) < 0) throw new BadRequestError("Ugyldig status.");
        ticket.set("status", input.status);
      }
      if (input.assigneeId !== undefined) ticket.set("assigneeId", userWithRole(app, input.assigneeId, "employee").id);
      if (input.dueDate !== undefined) ticket.set("dueDate", date(input.dueDate));
      app.save(ticket);
      result = ticketJSON(app, ticket);
    });
    return e.json(200, { ticket: result });
  },

  message(e) {
    const input = body(e);
    fields(input, ["body", "sendEmail"]);
    const messageBody = text(input.body, 5000);
    if (input.sendEmail !== undefined && typeof input.sendEmail !== "boolean") throw new BadRequestError("sendEmail må være true eller false.");
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      const ticket = authorizedTicket(app, e.request.pathValue("id"), user);
      const message = new Record(app.findCollectionByNameOrId("messages"));
      for (const [key, value] of Object.entries({
        ticketId: ticket.id, authorId: user.id, body: messageBody,
        emailStatus: input.sendEmail ? "failed" : "not_requested",
      })) message.set(key, value);
      app.save(message);
      app.save(ticket);
      result = messageJSON(message);
    });
    return e.json(201, { message: result });
  },

  emailResult(e) {
    const input = body(e);
    fields(input, ["deliveryStatus"]);
    if (["sent", "failed"].indexOf(input.deliveryStatus) < 0) throw new BadRequestError("Ugyldig leveringsstatus.");
    e.app.runInTransaction((app) => {
      let message;
      try { message = app.findRecordById("messages", e.request.pathValue("id")); } catch (_) {
        throw new NotFoundError("Fant ikke meldingen.");
      }
      if (message.getString("emailStatus") === "not_requested") throw new BadRequestError("E-post ble ikke forespurt.");
      message.set("emailStatus", input.deliveryStatus);
      app.save(message);
    });
    return e.json(200, {});
  },
};
