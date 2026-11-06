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

function secureUrl(value) {
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?(?:[/?#][^\s]*)?$/i.exec(value);
  if (!match || !match[1].includes(".") || match[1].includes("..")) return "";
  if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return "";
  return value;
}

function mediaExtension(file) {
  let reader;
  let bytes;
  try {
    reader = file.reader.open();
    bytes = toBytes(reader, 12);
  } catch (_) {
    throw new BadRequestError("Kunne ikke lese mediefilen.");
  } finally {
    if (reader) reader.close();
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "png";
  if (bytes.length >= 12 && [82, 73, 70, 70].every((value, index) => bytes[index] === value)
    && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return "webp";
  if (bytes.length >= 12 && [102, 116, 121, 112].every((value, index) => bytes[index + 4] === value)) return "mp4";
  if (bytes.length >= 4 && [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)) return "webm";
  return "";
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

function submissionJSON(submission) {
  const files = submission.getStringSlice("files");
  return {
    id: submission.id, version: submission.getInt("version"),
    caption: submission.getString("caption"), link: submission.getString("link"),
    status: submission.getString("status"), submittedBy: submission.getString("submittedBy"),
    createdAt: timestamp(submission, "createdAt"), reviewerId: submission.getString("reviewerId") || null,
    feedback: submission.getString("feedback"), decidedAt: submission.getString("decidedAt") || null,
    files: files.map((name) => {
      const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" }[extension] || "application/octet-stream";
      return { name, type };
    }),
  };
}

function ticketJSON(app, ticket) {
  const productId = ticket.getString("productId");
  let product = null;
  if (productId) {
    try { product = app.findRecordById("products", productId); } catch (_) { /* Custom-URL tasks have no catalogue relation. */ }
  }
  const messages = app.findRecordsByFilter("messages", "ticketId = {:id}", "createdAt,id", 0, 0, { id: ticket.id });
  const submissions = app.findRecordsByFilter("content_submissions", "ticketId = {:id}", "version", 0, 0, { id: ticket.id });
  return {
    id: ticket.id, number: ticket.getInt("number"), displayNumber: ticket.getString("displayNumber") || String(ticket.getInt("number")),
    promotionBase: ticket.getInt("promotionBase") || ticket.getInt("number"),
    promotionIndex: ticket.getInt("promotionIndex") || 1,
    promotionCount: Math.max(1, ticket.getInt("promotionCount") || 1), subject: ticket.getString("subject"),
    promotionOpen: ticket.getBool("promotionOpen"),
    description: ticket.getString("description"), productId: product ? product.getString("slug") : null,
    productUrl: ticket.getString("productUrl"), productSnapshot: ticket.get("productSnapshot") || null,
    ambassadorId: ticket.getString("ambassadorId"), assigneeId: ticket.getString("assigneeId"),
    status: ticket.getString("status"), channel: ticket.getString("channel"),
    acceptBy: ticket.getString("acceptBy") || null,
    dueDate: ticket.getString("dueDate") || null,
    publicationUrl: ticket.getString("publicationUrl") || null,
    createdAt: timestamp(ticket, "createdAt"), updatedAt: timestamp(ticket, "updatedAt"),
    messages: messages.map(messageJSON), submissions: submissions.map(submissionJSON),
  };
}

function authorizedTicket(app, id, user) {
  let ticket;
  try { ticket = app.findRecordById("tickets", id); } catch (_) {
    throw new NotFoundError("Fant ikke forespørselen.");
  }
  const availableTask = ticket.getString("status") === "available" && !ticket.getString("ambassadorId")
    && ticket.getString("acceptBy") >= new Date().toISOString().slice(0, 10);
  if (user.getString("role") !== "employee" && ticket.getString("ambassadorId") !== user.id && !availableTask) {
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
      const ticketFilter = employee ? "" : "ambassadorId = {:id} || (status = 'available' && ambassadorId = '' && acceptBy >= {:today})";
      const tickets = app.findRecordsByFilter("tickets", ticketFilter, "-number", 0, 0,
        { id: user.id, today: new Date().toISOString().slice(0, 10) }).map((record) => ticketJSON(app, record));
      const relevant = {};
      relevant[user.id] = true;
      for (const ticket of tickets) {
        relevant[ticket.ambassadorId] = true;
        relevant[ticket.assigneeId] = true;
        for (const message of ticket.messages) relevant[message.authorId] = true;
      }
      result = {
        user: { ...safeUser(user), ...(user.getBool("isPortalAdmin") ? { isPortalAdmin: true } : {}) },
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
        if (ticket.getString("ambassadorId") !== user.id || !productId || ticket.getString("productId") !== productId) throw new BadRequestError("Velg et av dine samarbeid med samme produkt.");
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
    fields(input, ["productId", "productUrl", "productSnapshot", "subject", "description", "channel", "dueDate", "ambassadorId", "promotionCount"]);
    const promotionCount = input.promotionCount === undefined ? 1 : input.promotionCount;
    if (typeof promotionCount !== "number" || !Number.isInteger(promotionCount) || promotionCount < 1 || promotionCount > 50) {
      throw new BadRequestError("Antall promoteringsoppgaver må være et heltall fra 1 til 50.");
    }
    const subject = text(input.subject, 160);
    const description = text(input.description, 5000);
    const slug = input.productId === undefined || input.productId === "" ? "" : text(input.productId, 100);
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
      const products = slug ? app.findRecordsByFilter("products", "slug = {:slug} && available = true", "", 1, 0, { slug }) : [];
      if (slug && !products.length) throw new BadRequestError("Velg et tilgjengelig produkt.");
      if (!products.length && (!productUrl || !productSnapshot)) throw new BadRequestError("Oppgi en produktlenke og hent produktinformasjonen.");
      if (!products.length && user.getString("role") !== "ambassador") throw new BadRequestError("Ansatte må opprette åpne oppgaver via oppgaveflyten.");
      const employees = app.findRecordsByFilter("users", "role = 'employee'", "created,id", 1, 0);
      if (!employees.length) throw new ApiError(409, "Ingen medarbeider er tilgjengelig.");
      const counter = app.findFirstRecordByFilter("portal_counters", "key = 'tickets'");
      const baseNumber = counter.getInt("value") + 1;
      counter.set("value", counter.getInt("value") + promotionCount);
      app.save(counter);
      const tickets = [];
      for (let index = 1; index <= promotionCount; index++) {
        const ticket = new Record(app.findCollectionByNameOrId("tickets"));
        for (const [key, value] of Object.entries({
          number: baseNumber + index - 1, displayNumber: `${baseNumber}-${index}`,
          promotionBase: baseNumber, promotionIndex: index, promotionCount,
          promotionOpen: false,
          subject, description, productId: products.length ? products[0].id : "", ambassadorId,
          productUrl, productSnapshot, assigneeId: employees[0].id, status: "requested", channel: input.channel, dueDate,
        })) ticket.set(key, value);
        app.save(ticket);
        tickets.push(ticketJSON(app, ticket));
      }
      result = { ticket: tickets[0], tickets, promotionCount };
    });
    return e.json(201, result);
  },

  createTask(e) {
    const input = body(e);
    fields(input, ["productUrl", "productSnapshot", "subject", "description", "acceptBy", "dueDate", "promotionCount"]);
    const promotionCount = input.promotionCount === undefined ? 1 : input.promotionCount;
    if (typeof promotionCount !== "number" || !Number.isInteger(promotionCount) || promotionCount < 1 || promotionCount > 50) {
      throw new BadRequestError("Antall ambassadører må være et heltall fra 1 til 50.");
    }
    const user = actor(e.app, e.auth.id);
    if (user.getString("role") !== "employee") throw new ForbiddenError("Bare ansatte kan opprette åpne oppgaver.");
    const productUrl = text(input.productUrl, 2000);
    if (!/^https:\/\/www\.olbrygging\.no\/.+/i.test(productUrl)) throw new BadRequestError("Ugyldig produktlenke.");
    const subject = text(input.subject, 160);
    const description = text(input.description, 5000);
    const acceptBy = date(input.acceptBy);
    const dueDate = date(input.dueDate);
    const today = new Date().toISOString().slice(0, 10);
    if (!acceptBy || !dueDate || acceptBy < today || dueDate < acceptBy) {
      throw new BadRequestError("Velg en frist for å melde interesse i dag eller senere, og en publiseringsfrist etter denne.");
    }
    const snapshot = input.productSnapshot;
    fields(snapshot, ["url", "name", "description", "price", "currency", "image"]);
    if (snapshot.url !== productUrl || typeof snapshot.name !== "string" || !snapshot.name.trim() || snapshot.name.length > 300
      || typeof snapshot.description !== "string" || snapshot.description.length > 2000
      || (snapshot.price !== null && (typeof snapshot.price !== "number" || !isFinite(snapshot.price) || snapshot.price < 0))
      || (snapshot.currency !== null && (typeof snapshot.currency !== "string" || snapshot.currency.length > 12))
      || (snapshot.image !== null && (typeof snapshot.image !== "string" || snapshot.image.length > 2000 || !/^https:\/\//i.test(snapshot.image)))) {
      throw new BadRequestError("Hent produktinformasjonen fra lenken før du oppretter oppgaven.");
    }
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "employee") throw new ForbiddenError("Bare ansatte kan opprette åpne oppgaver.");
      const employees = app.findRecordsByFilter("users", "role = 'employee'", "created,id", 1, 0);
      if (!employees.length) throw new ApiError(409, "Ingen medarbeider er tilgjengelig.");
      const counter = app.findFirstRecordByFilter("portal_counters", "key = 'tickets'");
      const baseNumber = counter.getInt("value") + 1;
      counter.set("value", counter.getInt("value") + promotionCount);
      app.save(counter);
      const tickets = [];
      for (let index = 1; index <= promotionCount; index++) {
        const ticket = new Record(app.findCollectionByNameOrId("tickets"));
        for (const [key, value] of Object.entries({
          number: baseNumber + index - 1, displayNumber: `${baseNumber}-${index}`,
          promotionBase: baseNumber, promotionIndex: index, promotionCount,
          promotionOpen: true,
          subject, description, productId: "", ambassadorId: "", assigneeId: user.id,
          productUrl, productSnapshot: snapshot, status: "available", channel: "", acceptBy, dueDate,
        })) ticket.set(key, value);
        app.save(ticket);
        tickets.push(ticketJSON(app, ticket));
      }
      result = { ticket: tickets[0], tickets, promotionCount };
    });
    return e.json(201, result);
  },

  acceptTask(e) {
    fields(body(e), []);
    const id = e.request.pathValue("id");
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "ambassador") throw new ForbiddenError("Bare ambassadører kan melde interesse for oppgaver.");
      let ticket;
      try { ticket = app.findRecordById("tickets", id); } catch (_) {
        throw new NotFoundError("Fant ikke oppgaven.");
      }
      const today = new Date().toISOString().slice(0, 10);
      if (ticket.getString("status") !== "available" || ticket.getString("ambassadorId")) {
        throw new ApiError(409, "Denne oppgaven er ikke lenger tilgjengelig.");
      }
      if (!ticket.getString("acceptBy") || ticket.getString("acceptBy") < today) {
        throw new ApiError(409, "Fristen for å melde interesse for denne oppgaven har gått ut.");
      }
      const siblings = app.findRecordsByFilter("tickets",
        "promotionOpen = true && promotionBase = {:base} && ambassadorId = {:ambassador}", "", 1, 0,
        { base: ticket.getInt("promotionBase"), ambassador: user.id });
      if (ticket.getBool("promotionOpen") && siblings.length) {
        throw new ApiError(409, "Du har allerede en promoteringsoppgave fra denne forespørselen.");
      }
      ticket.set("ambassadorId", user.id);
      ticket.set("status", "approved");
      app.save(ticket);
      result = ticketJSON(app, ticket);
    });
    return e.json(200, { ticket: result });
  },

  update(e) {
    const input = body(e);
    fields(input, ["status", "assigneeId", "dueDate", "channel"]);
    if (!Object.keys(input).length) throw new BadRequestError("Ingen endringer er oppgitt.");
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      const ticket = authorizedTicket(app, e.request.pathValue("id"), user);
      if (user.getString("role") === "ambassador" && ticket.getString("ambassadorId") !== user.id) {
        throw new NotFoundError("Meld interesse for oppgaven før du kan endre den.");
      }
      if (user.getString("role") !== "employee") {
        const transitions = { approved: "in_progress" };
        const selectingChannel = Object.keys(input).length === 1 && input.channel !== undefined
          && ticket.getString("ambassadorId") === user.id && ["approved", "in_progress"].indexOf(ticket.getString("status")) >= 0;
        const changingStatus = Object.keys(input).length === 1 && input.status !== undefined
          && transitions[ticket.getString("status")] === input.status;
        if (!selectingChannel && !changingStatus) {
          throw new ForbiddenError("Du kan velge kanal eller starte en godkjent oppgave. Send innhold i innsendingsfeltet for vurdering.");
        }
      }
      if (input.status !== undefined) {
        if (["available", "requested", "approved", "in_progress", "review", "completed", "declined"].indexOf(input.status) < 0) throw new BadRequestError("Ugyldig status.");
        if (input.status === "review") throw new BadRequestError("Send innholdet gjennom innsendingsfeltet for vurdering.");
        const latest = app.findRecordsByFilter("content_submissions", "ticketId = {:id}", "-version", 1, 0, { id: ticket.id })[0];
        if (latest && latest.getString("status") === "submitted" && input.status !== ticket.getString("status")) {
          throw new ApiError(409, "Vurder innholdet før du endrer status på oppgaven.");
        }
        if (input.status === "completed") {
          if (!latest || latest.getString("status") !== "approved" || !ticket.getString("publicationUrl")) {
            throw new BadRequestError("Oppgaven kan lukkes først når innholdet er godkjent og lenken til publiseringen er registrert.");
          }
        }
        if (input.status === "available" && (ticket.getString("ambassadorId") || !ticket.getString("acceptBy")
          || ticket.getString("acceptBy") < new Date().toISOString().slice(0, 10))) {
          throw new BadRequestError("Bare en utildelt oppgave med akseptfrist kan være åpen.");
        }
        if (!ticket.getString("ambassadorId") && ["available", "declined"].indexOf(input.status) < 0) {
          throw new BadRequestError("En ambassadør må akseptere oppgaven før den kan starte.");
        }
        ticket.set("status", input.status);
      }
      if (input.assigneeId !== undefined) ticket.set("assigneeId", userWithRole(app, input.assigneeId, "employee").id);
      if (input.dueDate !== undefined) {
        const dueDate = date(input.dueDate);
        if (ticket.getString("acceptBy") && (!dueDate || dueDate < ticket.getString("acceptBy"))) throw new BadRequestError("Publiseringsfristen kan ikke være før akseptfristen.");
        ticket.set("dueDate", dueDate);
      }
      if (input.channel !== undefined) {
        if (["Instagram", "TikTok", "YouTube", "Blogg", "Annet"].indexOf(input.channel) < 0) throw new BadRequestError("Ugyldig publiseringskanal.");
        if (user.getString("role") === "ambassador" && ticket.getString("ambassadorId") !== user.id) throw new ForbiddenError("Meld interesse for oppgaven før du velger kanal.");
        ticket.set("channel", input.channel);
      }
      app.save(ticket);
      result = ticketJSON(app, ticket);
    });
    return e.json(200, { ticket: result });
  },

  submitContent(e) {
    const input = e.requestInfo().body;
    fields(input, ["caption", "link"]);
    const caption = input.caption === undefined || input.caption === "" ? "" : text(input.caption, 1500);
    let link = "";
    if (input.link !== undefined && input.link !== "") {
      link = text(input.link, 2000);
      link = secureUrl(link);
      if (!link) throw new BadRequestError("Oppgi en gyldig HTTPS-lenke.");
    }
    const files = e.findUploadedFiles("files");
    if (!files.length || files.length > 5) throw new BadRequestError("Velg mellom 1 og 5 bilder eller videoer.");
    let totalSize = 0;
    for (const file of files) {
      if (file.size) totalSize += file.size;
      if (file.size > 20 * 1024 * 1024 || totalSize > 30 * 1024 * 1024) {
        throw new BadRequestError("Hver fil kan være opptil 20 MB og samlet opplasting opptil 30 MB.");
      }
      const match = /\.(jpe?g|png|webp|mp4|webm)$/i.exec(file.originalName);
      const extension = match && match[1].toLowerCase() === "jpeg" ? "jpg" : match && match[1].toLowerCase();
      if (!extension || extension !== mediaExtension(file)) {
        throw new BadRequestError("Filtypen må samsvare med et JPEG-, PNG- eller WebP-bilde eller en MP4- eller WebM-video.");
      }
    }
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "ambassador") throw new ForbiddenError("Bare ambassadører kan sende innhold til vurdering.");
      const ticket = authorizedTicket(app, e.request.pathValue("id"), user);
      if (ticket.getString("ambassadorId") !== user.id) throw new NotFoundError("Fant ikke forespørselen.");
      const previous = app.findRecordsByFilter("content_submissions", "ticketId = {:id}", "-version", 1, 0, { id: ticket.id })[0];
      if (previous && previous.getString("status") !== "changes_requested") {
        throw new ApiError(409, "Vent på tilbakemelding før du sender inn en ny versjon.");
      }
      if (ticket.getString("status") !== "in_progress") throw new BadRequestError("Oppgaven må være pågående før du kan sende inn innhold.");
      const submission = new Record(app.findCollectionByNameOrId("content_submissions"));
      submission.set("ticketId", ticket.id);
      submission.set("submittedBy", user.id);
      submission.set("version", previous ? previous.getInt("version") + 1 : 1);
      submission.set("caption", caption);
      submission.set("link", link);
      submission.set("files", files);
      submission.set("status", "submitted");
      submission.set("createdAt", new Date().toISOString());
      app.save(submission);
      ticket.set("status", "review");
      app.save(ticket);
      result = submissionJSON(submission);
    });
    return e.json(201, { submission: result });
  },

  reviewContent(e) {
    const input = body(e);
    fields(input, ["decision", "feedback"]);
    if (["approved", "changes_requested"].indexOf(input.decision) < 0) throw new BadRequestError("Velg godkjenning eller be om endringer.");
    let feedback = "";
    if (input.feedback !== undefined && input.feedback !== "") feedback = text(input.feedback, 2000);
    if (input.decision === "changes_requested" && !feedback) throw new BadRequestError("Skriv en tilbakemelding før du ber om endringer.");
    let result;
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "employee") throw new ForbiddenError("Bare ansatte kan vurdere innhold.");
      let submission;
      try { submission = app.findRecordById("content_submissions", e.request.pathValue("id")); } catch (_) {
        throw new NotFoundError("Fant ikke innsendt innhold.");
      }
      const ticket = authorizedTicket(app, submission.getString("ticketId"), user);
      const latest = app.findRecordsByFilter("content_submissions", "ticketId = {:id}", "-version", 1, 0, { id: ticket.id })[0];
      if (!latest || latest.id !== submission.id || submission.getString("status") !== "submitted" || ticket.getString("status") !== "review") {
        throw new ApiError(409, "Denne innholdsversjonen er ikke lenger til vurdering.");
      }
      submission.set("status", input.decision);
      submission.set("reviewerId", user.id);
      submission.set("feedback", feedback);
      submission.set("decidedAt", new Date().toISOString());
      app.save(submission);
      ticket.set("status", "in_progress");
      app.save(ticket);
      result = submissionJSON(submission);
    });
    return e.json(200, { submission: result });
  },

  publication(e) {
    const input = body(e);
    fields(input, ["url"]);
    const value = text(input.url, 2000);
    const url = secureUrl(value);
    if (!url) throw new BadRequestError("Publiseringslenken må bruke HTTPS.");
    e.app.runInTransaction((app) => {
      const user = actor(app, e.auth.id);
      if (user.getString("role") !== "ambassador") throw new ForbiddenError("Bare ambassadøren kan registrere lenken til innlegget.");
      const ticket = authorizedTicket(app, e.request.pathValue("id"), user);
      const latest = app.findRecordsByFilter("content_submissions", "ticketId = {:id}", "-version", 1, 0, { id: ticket.id })[0];
      if (ticket.getString("ambassadorId") !== user.id || ticket.getString("status") !== "in_progress"
        || !latest || latest.getString("status") !== "approved") {
        throw new BadRequestError("Registrer publiseringslenken etter at innholdet er godkjent.");
      }
      ticket.set("publicationUrl", url);
      app.save(ticket);
    });
    return e.json(200, { ticket: {} });
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
      if (!ticket.getString("ambassadorId")) throw new BadRequestError("Samtalen åpnes når en ambassadør har akseptert oppgaven.");
      if (user.getString("role") === "ambassador" && ticket.getString("ambassadorId") !== user.id) {
        throw new NotFoundError("Meld interesse for oppgaven før du starter en samtale.");
      }
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
