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
  return { id: user.id, name: user.getString("name"), email: user.getString("email"), role: user.getString("role") };
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
      };
    });
    return e.json(200, result);
  },

  create(e) {
    const input = body(e);
    fields(input, ["productId", "subject", "description", "channel", "dueDate", "ambassadorId"]);
    const subject = text(input.subject, 160);
    const description = text(input.description, 5000);
    const slug = text(input.productId, 100);
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
        assigneeId: employees[0].id, status: "requested", channel: input.channel, dueDate,
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
