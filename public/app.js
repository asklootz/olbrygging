const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const state = { user: null, products: [], tickets: [], users: [], articles: [], damageReports: [], page: 'overview', query: '', filter: 'Alle', profileId: '', editArticle: null, ownerFilter: 'Alle', emailConfigured: false };
const statuses = { requested: 'Avventer svar', approved: 'Godkjent', in_progress: 'Pågår', review: 'Til gjennomgang', completed: 'Fullført', declined: 'Avslått' };
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bag: '<rect x="4" y="7" width="16" height="14" rx="2"/><path d="M8 8V6a4 4 0 0 1 8 0v2M9 12h6"/>',
  box: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v10l9 5 9-5V8M12 13v10M7.5 5.5l9 5"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 9h9M7 13h6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  leaf: '<path d="M20 3C8 2 2 8 5 15s16 5 15-12ZM5 20 16 8"/>',
  logout: '<path d="M9 4H4v16h5m5-13 5 5-5 5m-5-5h10"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  send: '<path d="m22 2-7 20-4-9L2 9 22 2Zm-11 11L22 2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-1 .5-1 1.2-1 2.2M12 17h.01"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M4 5.5v14A2.5 2.5 0 0 1 6.5 17H20M8 7h8"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.6-1.4-2.4 1.4-1.1a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.8-1L13 7h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.6 1.4 2.4-1.4 1.1a8 8 0 0 1-.2 2.3Z"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.box}</svg>`;
const escape = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const initials = (name = '') => name.split(' ').map((part) => part[0]).slice(0, 2).join('');
const person = (id) => state.users.find((user) => user.id === id);
const product = (id) => state.products.find((item) => item.id === id);
const employee = () => state.user?.role !== 'ambassador';
const active = (ticket) => !['completed', 'declined'].includes(ticket.status);
const date = (value, options = { day: 'numeric', month: 'short' }) => value ? new Intl.DateTimeFormat('nb-NO', options).format(new Date(value)) : 'Ingen frist';
const price = (value) => new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(value);
const avatar = (user, extra = '') => `<span class="avatar ${extra}" aria-hidden="true">${escape(initials(user?.name || '?'))}</span>`;
const pill = (status) => `<span class="pill ${escape(status)}">${escape(statuses[status] || status)}</span>`;
const brand = () => '<div class="brand"><span class="brand-mark">ø</span><div><strong>ØLBRYGGING</strong><small>Ambassadørportalen</small></div></div>';
let toastTimer;
let lastFocus;
let modalTicketId = null;
let mutating = false;
let authVersion = 0;

async function api(path, { method = 'GET', body } = {}) {
  const version = authVersion;
  const response = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user && version === authVersion) {
      authVersion++;
      state.user = null;
      closeModal();
      renderLogin();
    }
    throw new Error(data.error || 'Noe gikk galt. Prøv igjen.');
  }
  return data;
}

function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 4500);
}

function illustration(item, index = 0) {
  const backgrounds = ['#eeeadd', '#e6ebdf', '#eee6dd', '#e5e8e1'];
  const background = backgrounds[index % backgrounds.length];
  const category = item?.category || '';
  let drawing;
  if (category.includes('utstyr')) {
    drawing = '<ellipse cx="130" cy="148" rx="57" ry="7" fill="#000" opacity=".06"/><path d="M91 61h78v71q0 14-39 14t-39-14Z" fill="#b9bfba"/><path d="M98 63h64v68q0 9-32 9t-32-9Z" fill="#d7dbd6"/><ellipse cx="130" cy="61" rx="39" ry="10" fill="#e7e9e2" stroke="#a3aba4"/><path d="M91 74H81v31h10m78-31h10v31h-10" fill="none" stroke="#8c978e" stroke-width="5"/><path d="M117 49h26v5h-26z" fill="#7f8e81"/><rect x="112" y="80" width="36" height="31" rx="4" fill="#455c4c"/><rect x="119" y="87" width="22" height="11" rx="2" fill="#bad0a5"/><circle cx="130" cy="103" r="2" fill="#e0e9d7"/><path d="M143 130h22v8h-14v9h-8" fill="#9ca79c"/>';
  } else if (category.includes('Råvar')) {
    drawing = '<ellipse cx="130" cy="148" rx="51" ry="7" fill="#000" opacity=".06"/><path d="m99 43 61 4-3 28 13 65q-39 14-79-3l11-63Z" fill="#d9bb83"/><path d="m102 44 54 4M100 53l56 4" stroke="#b7965d" stroke-width="2"/><rect x="106" y="77" width="47" height="49" rx="2" fill="#f4efdb"/><path d="M130 87v28m0-20q-14-13-12 1 3 8 12 8m0-3q14-13 12 1-3 8-12 8" stroke="#76804f" fill="none" stroke-width="2"/><path d="M112 120h35" stroke="#c4bb99"/>';
  } else if (category.includes('Tilbeh')) {
    drawing = '<ellipse cx="130" cy="148" rx="51" ry="7" fill="#000" opacity=".06"/><path d="m110 38 5 31-11 18v51q26 14 52 0V87l-11-18 4-31Z" fill="#f4f5e9" fill-opacity=".7" stroke="#acb6a1" stroke-width="2"/><path d="M108 99h44v35q-23 11-44 0Z" fill="#dba64c" opacity=".8"/><path d="M109 99h42" stroke="#faf2d7" stroke-width="5"/><path d="M117 49h24m-24 5h24" stroke="#d8ddce"/><text x="130" y="122" text-anchor="middle" fill="#fff6d9" font-family="Georgia,serif" font-size="22">ø</text>';
  } else {
    drawing = '<ellipse cx="130" cy="148" rx="61" ry="7" fill="#000" opacity=".06"/><path d="m78 57 58-17 45 24-57 18Z" fill="#cbae7b"/><path d="M78 57v75l46 23V82Z" fill="#c3a16c"/><path d="m124 82 57-18v73l-57 18Z" fill="#dfc596"/><path d="m101 50 46 24v22l-13 4V78L89 54Z" fill="#e8d7b3"/><path d="m134 99 36-11v37l-36 11Z" fill="#294b39"/><text x="152" y="116" text-anchor="middle" fill="#eadcc1" font-family="Georgia,serif" font-size="21" transform="rotate(-16 152 116)">ø</text><path d="m137 126 29-9" stroke="#a9bb8b" stroke-width="2"/><path d="m86 107 25 13m-25-7 25 13" stroke="#a18558" stroke-width="2"/>';
  }
  return `<svg viewBox="0 0 260 180" role="img" aria-label="${escape(item?.name || 'Bryggeprodukter')}"><rect width="260" height="180" fill="${background}"/>${drawing}</svg>`;
}

function renderLogin(error = '') {
  app.innerHTML = `<main class="login">
    <section class="login-story">${brand()}<h1>Gode råvarer.<br>Enda bedre<br><em>samarbeid.</em></h1><p>For deg som deler bryggeglede. Velkommen til fellesskapet vårt.</p><div class="login-art">${illustration({ category: 'Ølsett', name: 'Illustrert bryggesett' })}</div><div class="story-foot">${icon('leaf')} Sammen skaper vi bryggeglede · Ølbrygging AS</div></section>
    <section class="login-panel"><div class="login-box"><div class="eyebrow">Laget for bryggeglede</div><h2>Velkommen tilbake.</h2><p>Produktene, samarbeidene og samtalene dine.<br>Alt samlet på ett sted.</p>
    <form id="login-form"><div class="field"><label for="email">E-postadresse</label><input id="email" name="email" type="email" autocomplete="username" placeholder="deg@eksempel.no" required maxlength="254"></div><div class="field"><label for="password">Passord</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Ditt passord" required maxlength="128"></div><p class="error" role="alert">${escape(error)}</p><button class="primary" type="submit">Logg inn ${icon('arrow')}</button></form>
    <div class="demo-box"><label>Ta en titt på portalen</label><p>Prøv med eksempeldata. Ingen ekte bestillinger eller e-poster sendes uten konfigurert e-posttjeneste.</p><div class="demo-actions"><button class="secondary" data-demo="ambassador">${icon('leaf')} Ambassadør</button><button class="secondary" data-demo="employee">${icon('bag')} Ansatt</button><button class="secondary" data-demo="admin">${icon('user')} Admin</button></div></div>
    <p class="login-note">Lokal demonstrasjon · Eksempelprodukter, ikke en live produktkatalog.<br>Bruk kun fiktive opplysninger i demoen.</p></div></section></main>`;
}

async function login(email, password, button) {
  const version = ++authVersion;
  if (button) button.disabled = true;
  try {
    const data = await api('/login', { method: 'POST', body: { email, password } });
    if (version !== authVersion) return;
    state.user = data.user;
    state.page = 'overview';
    state.query = '';
    state.filter = 'Alle';
    await loadWorkspace();
  } catch (error) {
    if (version === authVersion) renderLogin(error.message);
  }
}

async function loadWorkspace() {
  const version = authVersion;
  const data = await api('/workspace');
  if (version !== authVersion) return;
  Object.assign(state, data);
  render();
}

function matchingTickets() {
  const query = state.query.toLocaleLowerCase('nb-NO');
  return state.tickets.filter((ticket) => {
    const text = [ticket.subject, ticket.number, product(ticket.productId)?.name, person(ticket.ambassadorId)?.name].join(' ').toLocaleLowerCase('nb-NO');
    return text.includes(query) && (state.filter === 'Alle' || ticket.status === state.filter)
      && (!employee() || state.ownerFilter === 'Alle' || ticket.ambassadorId === state.ownerFilter);
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function render() {
  if (!state.user) return renderLogin();
  const titles = { overview: 'Oversikt', tickets: 'Oppgaver', products: 'Produktkatalog', messages: 'Meldinger', profiles: 'Ambassadører', knowledge: 'Kunnskapsbase', damage: 'Skademeldinger', settings: 'Innstillinger', admin: 'Brukeradministrasjon' };
  const links = [
    ['overview', 'grid', 'Oversikt'],
    ['tickets', 'bag', employee() ? 'Oppgaver' : 'Mine samarbeid'],
    ['products', 'box', 'Produktkatalog'],
    ['messages', 'chat', 'Meldinger'],
    ['profiles', 'user', employee() ? 'Ambassadører' : 'Min profil'],
    ['knowledge', 'book', 'Kunnskapsbase'],
    ['damage', 'warning', 'Skademeldinger'],
    ['settings', 'settings', 'Innstillinger'],
    ...(state.user.role === 'admin' ? [['admin', 'user', 'Brukere']] : []),
  ];
  app.innerHTML = `<div class="shell"><aside class="sidebar">${brand()}<div class="nav-label">DITT ARBEIDSROM</div><nav class="nav" aria-label="Hovedmeny">${[
    ...links,
  ].map(([page, symbol, label]) => `<button data-page="${page}" class="${state.page === page ? 'active' : ''}" ${state.page === page ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${page === 'tickets' ? `<span class="count">${state.tickets.filter(active).length}</span>` : page === 'damage' ? `<span class="count">${state.damageReports.filter((report) => report.status === 'pending').length}</span>` : ''}</button>`).join('')}</nav>
    <div class="sidebar-bottom"><div class="sidebar-note">${icon('leaf')}<h3>Vi brygger bedre sammen.</h3><p>En idé, et spørsmål eller litt inspirasjon? Vi er her for deg.</p><button data-action="help">Slik fungerer portalen ${icon('arrow')}</button></div><div class="side-user">${avatar(state.user)}<div><strong>${escape(state.user.name)}</strong><small>${employee() ? 'Ølbrygging-teamet' : 'Ambassadør'}</small></div><button data-action="logout" title="Logg ut" aria-label="Logg ut">${icon('logout')}</button></div></div></aside>
    <div class="workspace"><header class="topbar"><div class="mobile-brand" aria-label="Ølbrygging">ø</div><div class="breadcrumb">Ambassadørportalen ${icon('chevron')}<span>${titles[state.page]}</span></div><div class="top-tools"><div class="search">${icon('search')}<label class="sr-only" for="global-search">Søk i produkter og samarbeid</label><input id="global-search" type="search" placeholder="Søk i portalen …" value="${escape(state.query)}" maxlength="100"></div><span class="demo-label">Demomodus</span><button class="icon-button" data-action="help" aria-label="Hjelp og informasjon" title="Hjelp">${icon('help')}</button>${avatar(state.user, 'green')}</div></header>
    <main class="main" id="main-content">${pageContent()}</main></div></div>`;
}

function pageContent() {
  const pages = { overview, tickets: ticketsPage, products: catalogue, messages: inbox, profiles: profilesPage, knowledge: knowledgePage, damage: damagePage, settings: settingsPage, admin: adminPage };
  const content = (pages[state.page] || overview)();
  return `${content}<footer class="page-foot"><span>© ${new Date().getFullYear()} Ølbrygging AS · Sammen skaper vi bryggeglede.</span><span>${icon('leaf')} Eksempeldata · Lokal demo</span></footer>`;
}

function heading(title, subtitle, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">Ølbrygging · ${employee() ? 'Teamportalen' : 'Ambassadørportalen'}</div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}

function overview() {
  const activeCount = state.tickets.filter(active).length;
  const requested = state.tickets.filter((ticket) => ticket.status === 'requested').length;
  const complete = state.tickets.filter((ticket) => ticket.status === 'completed').length;
  const metrics = [
    [employee() ? 'Aktive samarbeid' : 'Mine aktive samarbeid', activeCount, 'bag', '', 'Gode ting er på gang'],
    [employee() ? 'Venter på godkjenning' : 'Avventer svar', requested, 'clock', 'amber', 'Forespørsler til teamet'],
    ['Fullførte samarbeid', complete, 'check', 'purple', 'Bryggeglede delt videre'],
    ['Tilgjengelige produkter', state.products.filter((item) => item.available).length, 'box', 'blue', 'Finn din neste favoritt'],
  ];
  const tickets = matchingTickets().filter(active).slice(0, 4);
  const assignedContact = person(state.tickets.find(active)?.assigneeId) || state.users.find((user) => user.role === 'employee');
  return `${heading(`Hei, ${escape(state.user.name.split(' ')[0])} <span class="heading-wave">👋</span>`, employee() ? 'Her er det som skjer i ambassadørfellesskapet ditt.' : 'Hyggelig å se deg! Her er oversikten over dine samarbeid.', `<button class="primary orange" data-page="products">${icon('plus')} Finn nye produkter</button>`)}
    <section class="metrics" aria-label="Nøkkeltall">${metrics.map(([label, value, symbol, color, note]) => `<div class="metric"><div class="metric-top">${label}<span class="metric-icon ${color}">${icon(symbol)}</span></div><strong>${value}</strong><small>${note}</small></div>`).join('')}</section>
    <div class="overview-grid"><section class="card"><div class="card-head"><div><h2>${employee() ? 'Aktive samarbeid' : 'Dine samarbeid'} <span class="count">${activeCount}</span></h2><p>Fra den første ideen til ferdig innhold.</p></div><button class="text-button" data-page="tickets">Se alle ${icon('arrow')}</button></div>${ticketTable(tickets)}<div class="table-foot">${icon('leaf')} Små øyeblikk. Stor bryggeglede.</div></section>
    <aside class="overview-aside"><section class="card contact"><div class="eyebrow">${employee() ? 'Ditt ambassadørteam' : 'Din kontakt hos oss'}</div><div class="contact-person">${avatar(employee() ? state.user : assignedContact, 'large green')}<div><h3>${escape((employee() ? state.user : assignedContact)?.name || 'Ølbrygging-teamet')}</h3><p>${employee() ? 'Ansvarlig kontaktperson' : 'Ambassadøransvarlig · Ølbrygging'}</p></div></div><p class="contact-copy">${employee() ? 'Følg opp forespørsler, gi tilbakemeldinger og hjelp ambassadørene videre.' : 'Lurer du på noe? Jeg hjelper deg med produkter, ideer og alt imellom.'}</p><button class="primary" data-action="contact">${icon('chat')} ${employee() ? 'Åpne samtaler' : 'Send en melding'}</button><div class="contact-footer">${icon('mail')} Samtaler knyttet til samarbeid</div></section><section class="tip-card"><h3>${icon('leaf')} Et lite bryggetips</h3><p>Det beste innholdet er ekte. Del prosessen, de små feilene og gleden ved den første smaken.</p></section></aside></div>
    <section><div class="section-heading"><div><h2>Klar for noe nytt?</h2><p>Oppdag produkter du har lyst til å dele med følgerne dine.</p></div><button class="text-button" data-page="products">Se produktkatalogen ${icon('arrow')}</button></div><div class="product-grid">${filteredProducts().slice(0, 4).map(productCard).join('') || empty('Ingen produkter passer søket ditt.')}</div></section>`;
}

function filteredProducts() {
  const query = state.query.toLocaleLowerCase('nb-NO');
  return state.products.filter((item) => `${item.name} ${item.category} ${item.description}`.toLocaleLowerCase('nb-NO').includes(query) && (state.page !== 'products' || state.filter === 'Alle' || item.category === state.filter));
}

function productCard(item, index) {
  return `<article class="product-card"><div class="product-image">${illustration(item, index)}<span class="tag">${item.available ? 'FOR AMBASSADØRER' : 'IKKE TILGJENGELIG'}</span></div><div class="product-info"><div class="category">${escape(item.category)}</div><h3>${escape(item.name)}</h3><p>${escape(item.description)}</p><div class="product-action"><strong>${price(item.price)} kr <small>veiledende</small></strong><button data-product="${escape(item.id)}" ${!item.available ? 'disabled' : ''}>${employee() ? 'Opprett samarbeid' : 'Jeg vil promotere'} ↗</button></div></div></article>`;
}

function empty(message) {
  return `<div class="empty">${icon('leaf')}<p>${escape(message)}</p></div>`;
}

function ticketTable(tickets) {
  if (!tickets.length) return empty('Ingen samarbeid her ennå. Finn et produkt i katalogen for å komme i gang.');
  return `<div class="table-wrap"><table><thead><tr><th>SAMARBEID / PRODUKT</th><th>STATUS</th><th class="due-column">FRIST</th><th><span class="sr-only">Åpne</span></th></tr></thead><tbody>${tickets.map((ticket, index) => `<tr data-ticket="${escape(ticket.id)}"><td><div class="ticket-cell"><div class="mini-product">${illustration(product(ticket.productId), index)}</div><div><strong>${escape(product(ticket.productId)?.name || ticket.subject)}</strong><small>#${escape(ticket.number)} · ${employee() ? escape(person(ticket.ambassadorId)?.name) : escape(ticket.channel)}</small></div></div></td><td>${pill(ticket.status)}</td><td class="due due-column">${date(ticket.dueDate)}</td><td><button class="row-arrow" data-ticket="${escape(ticket.id)}" aria-label="Åpne ${escape(ticket.subject)}">${icon('chevron')}</button></td></tr>`).join('')}</tbody></table></div>`;
}

function ticketsPage() {
  const ambassadors = state.users.filter((user) => user.role === 'ambassador' && user.active !== false);
  return `${heading(employee() ? 'Oppgaver' : 'Mine samarbeid', 'Hold oversikt fra første forespørsel til publisert innhold.', `<button class="primary" data-page="products">${icon('plus')} Nytt samarbeid</button>`)}${employee() ? `<div class="field owner-filter"><label for="owner-filter">Filtrer på ambassadør</label><select id="owner-filter" data-owner-filter><option value="Alle">Alle ambassadører</option>${ambassadors.map((user) => `<option value="${escape(user.id)}" ${state.ownerFilter === user.id ? 'selected' : ''}>${escape(user.name)}</option>`).join('')}</select></div>` : ''}<div class="filters" aria-label="Filtrer samarbeid">${[['Alle', 'Alle'], ...Object.entries(statuses)].map(([value, label]) => `<button class="filter ${state.filter === value ? 'active' : ''}" data-filter="${value}" aria-pressed="${state.filter === value}">${label}</button>`).join('')}</div><section class="card"><div class="card-head"><h2>${employee() ? 'Oppgaver' : 'Samarbeid'} <span class="count">${matchingTickets().length}</span></h2><span class="muted small">Sist oppdatert først</span></div>${ticketTable(matchingTickets())}</section>`;
}

function catalogue() {
  const categories = ['Alle', ...new Set(state.products.map((item) => item.category))];
  return `${heading('Finn din neste favoritt.', 'Velg et produkt du brenner for. Vi tar oss av resten.')}<div class="filters" aria-label="Produktkategorier">${categories.map((category) => `<button class="filter ${state.filter === category ? 'active' : ''}" data-filter="${escape(category)}" aria-pressed="${state.filter === category}">${escape(category)}</button>`).join('')}</div><div class="section-heading"><p>${filteredProducts().length} produkter · Eksempelkatalog, priser er veiledende</p></div><section class="product-grid" aria-label="Produktkatalog">${filteredProducts().map(productCard).join('') || empty('Ingen produkter passer søket ditt.')}</section>`;
}

function inbox() {
  const tickets = matchingTickets().filter((ticket) => ticket.messages.length);
  return `${heading('Gode samtaler starter her.', 'Alt om samarbeidene dine, samlet i én innboks.')}<section class="inbox" aria-label="Samtaler">${tickets.map((ticket) => {
    const last = ticket.messages.at(-1);
    const author = person(last.authorId);
    return `<button class="card inbox-item" data-ticket="${escape(ticket.id)}">${avatar(author, author?.role === 'employee' ? 'green' : '')}<div class="message-preview"><h3>${escape(ticket.subject)} ${pill(ticket.status)}</h3><p>${escape(author?.name)}: ${escape(last.body)}</p></div><small>${date(last.createdAt)}</small>${icon('chevron')}</button>`;
  }).join('') || empty('Ingen samtaler ennå. Åpne et samarbeid for å sende den første meldingen.')}</section>`;
}

function profilesPage() {
  const ambassadors = state.users.filter((user) => user.role === 'ambassador');
  const selectedId = employee() ? state.profileId || ambassadors[0]?.id : state.user.id;
  const profile = employee() ? ambassadors.find((user) => user.id === selectedId) : state.user;
  return `${heading(employee() ? 'Ambassadørprofiler' : 'Min profil', employee() ? 'Kontaktinformasjon og kanaler for ambassadørene.' : 'Hold kontaktinformasjonen din oppdatert.')}
    <section class="card profile-card">${employee() ? `<div class="field"><label for="profile-select">Ambassadør</label><select id="profile-select" data-profile-select>${ambassadors.map((user) => `<option value="${escape(user.id)}" ${user.id === profile?.id ? 'selected' : ''}>${escape(user.name)}</option>`).join('')}</select></div>` : ''}
    ${profile ? `<form id="profile-form" data-user-id="${escape(profile.id)}"><div class="field"><label for="profile-name">Navn</label><input id="profile-name" name="name" value="${escape(profile.name)}" required maxlength="100"></div><div class="field"><label for="profile-email">E-post</label><input id="profile-email" name="email" type="email" value="${escape(profile.email)}" required maxlength="254"></div><div class="field"><label for="profile-social">Sosiale medier / profil-lenke</label><input id="profile-social" name="socialMedia" value="${escape(profile.socialMedia)}" maxlength="200" placeholder="@brukernavn eller lenke"></div><p class="error" role="alert"></p><button class="primary" type="submit">Lagre profil ${icon('check')}</button></form>` : empty('Ingen ambassadørprofiler er tilgjengelige.')}</section>
    ${employee() ? `<section class="section-heading"><div><h2>Oppgaver per ambassadør</h2><p>Se samarbeidsstatus og kontaktperson.</p></div></section><section class="card">${ticketTable(state.tickets.filter((ticket) => ticket.ambassadorId === selectedId))}</section>` : ''}`;
}

function knowledgePage() {
  const categories = ['Alle', ...new Set(state.articles.map((article) => article.category))];
  const query = state.query.toLocaleLowerCase('nb-NO');
  const articles = state.articles.filter((article) => (state.filter === 'Alle' || article.category === state.filter)
    && `${article.title} ${article.body} ${article.category}`.toLocaleLowerCase('nb-NO').includes(query));
  const edit = state.editArticle && state.articles.find((article) => article.id === state.editArticle);
  return `${heading('Kunnskapsbase', 'Bryggetips, retningslinjer og svar samlet på ett sted.', employee() ? `<button class="primary" data-action="new-article">${icon('plus')} Ny artikkel</button>` : '')}
    <div class="filters" aria-label="Artikkelkategorier">${categories.map((category) => `<button class="filter ${state.filter === category ? 'active' : ''}" data-filter="${escape(category)}" aria-pressed="${state.filter === category}">${escape(category)}</button>`).join('')}</div>
    ${employee() && state.editArticle !== null ? `<section class="card article-editor"><h2>${edit ? 'Rediger artikkel' : 'Ny artikkel'}</h2><form id="article-form" data-article-id="${escape(edit?.id || '')}"><div class="field"><label for="article-title">Tittel</label><input id="article-title" name="title" value="${escape(edit?.title || '')}" required maxlength="160"></div><div class="field"><label for="article-category">Kategori</label><input id="article-category" name="category" value="${escape(edit?.category || '')}" required maxlength="60"></div><div class="field"><label for="article-body">Innhold</label><textarea id="article-body" name="body" required maxlength="12000">${escape(edit?.body || '')}</textarea></div><p class="error" role="alert"></p><div class="modal-actions"><button class="secondary" type="button" data-action="cancel-article">Avbryt</button><button class="primary" type="submit">Lagre artikkel</button></div></form></section>` : ''}
    <section class="article-list" aria-label="Artikler">${articles.map((article) => `<article class="card article-card"><div class="category">${escape(article.category)}</div><h2>${escape(article.title)}</h2><p>${escape(article.body)}</p><small>Skrevet av ${escape(person(article.authorId)?.name || 'Ølbrygging-teamet')} · Sist endret av ${escape(person(article.updatedBy || article.authorId)?.name || 'Ølbrygging-teamet')} ${date(article.updatedAt, { day: 'numeric', month: 'short', year: 'numeric' })}</small>${employee() ? `<button class="text-button" data-article-edit="${escape(article.id)}">Rediger ${icon('arrow')}</button>` : ''}</article>`).join('') || empty('Ingen artikler i denne kategorien ennå.')}</section>`;
}

function damagePage() {
  const reports = state.damageReports;
  const labels = { pending: 'Til behandling', approved: 'Godkjent', rejected: 'Avslått' };
  return `${heading('Skademeldinger', employee() ? 'Gjennomgå meldinger om varer fra ambassadørfellesskapet.' : 'Meld fra dersom en vare du mottok er skadet.')}
    ${employee() ? '' : `<section class="card damage-form-card"><h2>Registrer en skade</h2><form id="damage-form"><div class="field"><label for="damage-product">Produkt</label><select id="damage-product" name="productId"><option value="">Ikke knyttet til et produkt</option>${state.products.map((item) => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('')}</select></div><div class="field"><label for="damage-ticket">Samarbeid (valgfritt)</label><select id="damage-ticket" name="ticketId"><option value="">Velg samarbeid</option>${state.tickets.map((ticket) => `<option value="${escape(ticket.id)}">${escape(ticket.subject)}</option>`).join('')}</select></div><div class="field"><label for="damage-description">Beskriv skaden</label><textarea id="damage-description" name="description" required maxlength="5000" placeholder="Hva er skadet, og når oppdaget du det?"></textarea></div><p class="error" role="alert"></p><button class="primary" type="submit">Send skademelding ${icon('arrow')}</button></form></section>`}
    <section class="damage-list">${reports.map((report) => `<article class="card damage-card"><div class="category">${labels[report.status] || report.status}</div><h2>${escape(product(report.productId)?.name || 'Produkt ikke oppgitt')}</h2><p>${escape(report.description)}</p><small>${escape(person(report.ambassadorId)?.name || 'Ambassadør')} · ${date(report.createdAt, { day: 'numeric', month: 'long', year: 'numeric' })}${report.reviewNote ? ` · ${escape(report.reviewNote)}` : ''}</small>${employee() && report.status === 'pending' ? `<div class="modal-actions"><button class="secondary" data-report-decision="rejected" data-report-id="${escape(report.id)}">Avslå</button><button class="primary" data-report-decision="approved" data-report-id="${escape(report.id)}">Godkjenn</button></div>` : ''}</article>`).join('') || empty('Ingen skademeldinger ennå.')}</section>`;
}

function settingsPage() {
  let settings = { theme: 'light', compact: false, notifications: true };
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem(`settings-${state.user.id}`) || '{}') }; } catch {}
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('compact', Boolean(settings.compact));
  return `${heading('Innstillinger', 'Tilpass visningen og varslene dine.')}<section class="card settings-card"><form id="settings-form"><div class="field"><label for="setting-theme">Tema</label><select id="setting-theme" name="theme"><option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Lyst</option><option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Mørkt</option></select></div><label class="check-label"><input name="compact" type="checkbox" ${settings.compact ? 'checked' : ''}> Kompakt visning</label><label class="check-label"><input name="notifications" type="checkbox" ${settings.notifications ? 'checked' : ''}> Vis varsler om nye meldinger</label><p class="small muted">Innstillingene lagres i denne nettleseren.</p><button class="primary" type="submit">Lagre innstillinger ${icon('check')}</button></form></section>`;
}

function adminPage() {
  if (state.user.role !== 'admin') return empty('Denne siden er bare tilgjengelig for administrator.');
  return `${heading('Brukeradministrasjon', 'Opprett kontoer og administrer tilgang for ansatte og ambassadører.')}
    <section class="card admin-create"><h2>Opprett bruker</h2><form id="admin-create-form"><div class="field"><label for="new-name">Navn</label><input id="new-name" name="name" required maxlength="100"></div><div class="field"><label for="new-email">E-post</label><input id="new-email" name="email" type="email" required maxlength="254"></div><div class="form-row"><div class="field"><label for="new-role">Rolle</label><select id="new-role" name="role"><option value="ambassador">Ambassadør</option><option value="employee">Ansatt</option></select></div><div class="field"><label for="new-password">Midlertidig passord</label><input id="new-password" name="password" type="password" required minlength="12" maxlength="128"></div></div><p class="error" role="alert"></p><button class="primary" type="submit">Opprett konto ${icon('plus')}</button></form></section>
    <section class="admin-users" aria-label="Brukere">${state.users.map((user) => `<article class="card admin-user"><h2>${escape(user.name)} <span class="pill ${user.active ? 'approved' : 'declined'}">${user.active ? 'Aktiv' : 'Deaktivert'}</span></h2><form class="admin-user-form" data-user-id="${escape(user.id)}"><div class="field"><label for="role-${escape(user.id)}">Rolle</label><select id="role-${escape(user.id)}" name="role" ${user.id === state.user.id ? 'disabled' : ''}><option value="ambassador" ${user.role === 'ambassador' ? 'selected' : ''}>Ambassadør</option><option value="employee" ${user.role === 'employee' ? 'selected' : ''}>Ansatt</option>${user.role === 'admin' ? '<option value="admin" selected>Administrator</option>' : ''}</select></div><label class="check-label"><input name="active" type="checkbox" ${user.active ? 'checked' : ''} ${user.id === state.user.id ? 'disabled' : ''}> Aktiv konto</label><button class="secondary" type="submit" ${user.id === state.user.id ? 'disabled' : ''}>Lagre tilgang</button></form></article>`).join('')}</section>`;
}

function showModal(content, drawer = false) {
  if (!modalRoot.hasChildNodes()) lastFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop ${drawer ? 'drawer-backdrop' : ''}"><section class="modal ${drawer ? 'drawer' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">${content}</section></div>`;
  app.inert = true;
  document.body.style.overflow = 'hidden';
  modalRoot.querySelector('.modal').focus();
}

function closeModal() {
  modalRoot.innerHTML = '';
  app.inert = false;
  modalTicketId = null;
  document.body.style.overflow = '';
  if (lastFocus?.isConnected) lastFocus.focus();
}

function modalHead(title, eyebrow = '') {
  return `<header class="modal-head"><div>${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<h2 id="modal-title">${title}</h2></div><button class="icon-button" data-action="close" aria-label="Lukk">${icon('close')}</button></header>`;
}

function requestProduct(id) {
  const item = product(id);
  if (!item || !item.available) return;
  modalTicketId = null;
  showModal(`${modalHead('La oss lage noe bra sammen.')}<form id="request-form" class="modal-body" data-product-id="${escape(id)}"><div class="request-product"><div class="mini-product">${illustration(item)}</div><div><h3>${escape(item.name)}</h3><p>${escape(item.category)} · ${price(item.price)} kr veiledende</p></div></div>
    ${employee() ? `<div class="field"><label for="ambassadorId">Ambassadør</label><select id="ambassadorId" name="ambassadorId" required>${state.users.filter((user) => user.role === 'ambassador').map((user) => `<option value="${escape(user.id)}">${escape(user.name)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label for="subject">Navn på samarbeidet</label><input id="subject" name="subject" required maxlength="150" value="${escape(item.name)} – ${employee() ? 'nytt samarbeid' : 'min bryggeopplevelse'}"></div>
    <div class="form-row"><div class="field"><label for="channel">Hvor vil du dele?</label><select id="channel" name="channel">${['Instagram', 'TikTok', 'YouTube', 'Blogg', 'Annet'].map((channel) => `<option>${channel}</option>`).join('')}</select></div><div class="field"><label for="dueDate">Ønsket publiseringsdato</label><input id="dueDate" name="dueDate" type="date" required min="${new Date().toISOString().slice(0, 10)}"></div></div>
    <div class="field"><label for="description">Fortell litt om ideen din</label><textarea id="description" name="description" required maxlength="5000" placeholder="Hva har du lyst til å lage? Hvem ønsker du å inspirere?"></textarea></div>
    <p class="small muted">Kontaktpersonen din følger opp forespørselen her i portalen. Dette er ikke en bestilling.</p><p class="error" role="alert"></p><div class="modal-actions"><button class="secondary" type="button" data-action="close">Avbryt</button><button class="primary" type="submit">Send forespørsel ${icon('arrow')}</button></div></form>`);
}

function ticketDetail(id, preserveDraft = '') {
  const ticket = state.tickets.find((item) => item.id === id);
  if (!ticket) return;
  modalTicketId = id;
  const contact = person(employee() ? ticket.ambassadorId : ticket.assigneeId);
  const allowedStatuses = employee() ? Object.keys(statuses) : [...new Set([ticket.status, ...(ticket.status === 'approved' ? ['in_progress'] : ticket.status === 'in_progress' ? ['review'] : [])])];
  const subject = `Re: [Ølbrygging #${ticket.number}] ${ticket.subject}`;
  const emailBody = `Hei ${contact?.name?.split(' ')[0] || ''},\n\nAngående samarbeidet «${ticket.subject}» (#${ticket.number}):\n\n`;
  const mailto = `mailto:${encodeURIComponent(contact?.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailBody)}`;
  showModal(`${modalHead(escape(ticket.subject), `SAMARBEID #${escape(ticket.number)} · ${escape(ticket.channel)}`)}
    <div class="drawer-scroll"><div class="ticket-meta"><div><label for="ticket-status">Status</label><select id="ticket-status" data-update="status" ${allowedStatuses.length === 1 ? 'disabled' : ''}>${allowedStatuses.map((status) => `<option value="${status}" ${ticket.status === status ? 'selected' : ''}>${statuses[status]}</option>`).join('')}</select></div><div><label for="ticket-assignee">Kontaktperson</label>${employee() ? `<select id="ticket-assignee" data-update="assigneeId">${state.users.filter((user) => user.role === 'employee').map((user) => `<option value="${escape(user.id)}" ${ticket.assigneeId === user.id ? 'selected' : ''}>${escape(user.name)}</option>`).join('')}</select>` : `<p>${escape(person(ticket.assigneeId)?.name || 'Ikke tildelt')}</p>`}</div><div><label for="ticket-due">Publiseringsfrist</label>${employee() ? `<input id="ticket-due" type="date" data-update="dueDate" value="${escape(ticket.dueDate?.slice(0, 10) || '')}">` : `<p>${date(ticket.dueDate, { day: 'numeric', month: 'long', year: 'numeric' })}</p>`}</div></div>
    <div class="conversation"><h3>Om samarbeidet ${pill(ticket.status)}</h3><div class="request-product"><div class="mini-product">${illustration(product(ticket.productId))}</div><div><h3>${escape(product(ticket.productId)?.name)}</h3><p>${escape(person(ticket.ambassadorId)?.name)} · ${escape(ticket.channel)}</p></div></div><p class="ticket-description">${escape(ticket.description)}</p></div>
    <section class="conversation"><h3>Samtalen <span>${ticket.messages.length} meldinger</span></h3><div id="message-list">${ticket.messages.map((message) => {
      const author = person(message.authorId);
      return `<article class="message ${message.authorId === state.user.id ? 'own' : ''}">${avatar(author, author?.role === 'employee' ? 'green' : '')}<div class="message-content"><div class="message-label"><strong>${escape(author?.name || 'Ølbrygging-teamet')}</strong><time datetime="${escape(message.createdAt)}">${date(message.createdAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div><div class="bubble">${escape(message.body)}</div>${message.emailStatus === 'sent' ? '<span class="email-state">Også sendt på e-post</span>' : message.emailStatus === 'failed' ? '<span class="email-state">Lagret i portalen · E-post kunne ikke sendes</span>' : ''}</div></article>`;
    }).join('') || empty('Start samtalen. Kontaktpersonen din ser meldingen her.')}</div></section></div>
    <form id="message-form" class="composer" data-ticket-id="${escape(id)}"><label class="sr-only" for="message-body">Skriv en melding</label><textarea id="message-body" name="body" required maxlength="5000" placeholder="Skriv en melding til ${escape(contact?.name?.split(' ')[0] || 'kontaktpersonen din')} …">${escape(preserveDraft)}</textarea>${state.emailConfigured ? '<label class="check-label"><input type="checkbox" name="sendEmail"> Send også en e-postvarsling</label>' : ''}<p class="error" role="alert"></p><div class="composer-actions"><a class="email-link" href="${escape(mailto)}">${icon('mail')} Åpne e-postutkast</a><button class="primary" type="submit">Send melding ${icon('send')}</button></div><p class="email-hint">${state.emailConfigured ? 'E-postvarsler sendes til kontaktpersonen. Svar i portalen for å holde samtalen samlet.' : 'E-posttjeneste er ikke tilkoblet. Utkast åpnes i e-postappen din.'} E-postsvar synkroniseres ikke til portalen.</p></form>`, true);
}

function help() {
  modalTicketId = null;
  showModal(`${modalHead('Et godt samarbeid, steg for steg.')}<div class="modal-body"><ol class="help-list"><li><strong>Finn noe du vil dele.</strong> Utforsk produktkatalogen og send en forespørsel med idé, kanal og ønsket publiseringsdato.</li><li><strong>Bli enige med teamet.</strong> En ansatt i Ølbrygging følger opp og godkjenner samarbeidet. Kontaktpersonen finner du på samarbeidet.</li><li><strong>Del bryggeglede.</strong> Start et godkjent samarbeid ved å endre status til «Pågår». Send innhold og lenker i samtalen og velg «Til gjennomgang» når du er klar.</li><li><strong>Hold praten i gang.</strong> Meldinger lagres på samarbeidet. E-postutkast kan åpnes i e-postappen. Med konfigurert e-posttjeneste kan du også sende varsler fra portalen.</li></ol><p>Dette er en lokal demo med eksempelprodukter og demokontoer. E-postsvar importeres ikke automatisk. Ikke bruk virkelige personopplysninger.</p><button class="primary" data-action="close">Det høres bra ut ${icon('check')}</button></div>`);
}

function navigate(page) {
  state.page = page;
  state.filter = 'Alle';
  render();
  window.scrollTo(0, 0);
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button, a, tr[data-ticket]');
  if (event.target.classList.contains('modal-backdrop')) return closeModal();
  if (!button) return;
  if (button.matches('a.email-link')) {
    const draft = modalRoot.querySelector('#message-body')?.value.trim();
    if (draft) {
      const href = new URL(button.href);
      const ticket = state.tickets.find((item) => item.id === modalTicketId);
      href.searchParams.set('body', `Angående samarbeidet «${ticket?.subject}» (#${ticket?.number}):\n\n${draft}`);
      button.href = href.href;
    }
    return;
  }
  if (button.dataset.demo) return login(`${button.dataset.demo}@olbrygging.example`, 'BrewTogether!2026', button);
  if (button.dataset.page) return navigate(button.dataset.page);
  if (button.dataset.filter) {
    state.filter = button.dataset.filter;
    document.querySelector('#main-content').innerHTML = pageContent();
    return;
  }
  if (button.dataset.product) return requestProduct(button.dataset.product);
  if (button.dataset.ticket) return ticketDetail(button.dataset.ticket);
  if (button.dataset.articleEdit) {
    state.editArticle = button.dataset.articleEdit;
    return navigate('knowledge');
  }
  if (button.dataset.action === 'new-article') {
    state.editArticle = '';
    return render();
  }
  if (button.dataset.action === 'cancel-article') {
    state.editArticle = null;
    return render();
  }
  if (button.dataset.reportDecision) {
    try {
      await api(`/damage-reports/${encodeURIComponent(button.dataset.reportId)}`, { method: 'PATCH', body: { status: button.dataset.reportDecision } });
      await loadWorkspace();
      toast('Skademeldingen er behandlet.');
    } catch (error) { toast(error.message); }
    return;
  }
  if (button.dataset.action === 'close') return closeModal();
  if (button.dataset.action === 'help') return help();
  if (button.dataset.action === 'contact') {
    const ticket = [...state.tickets].filter(active).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    return ticket ? ticketDetail(ticket.id) : navigate('messages');
  }
  if (button.dataset.action === 'logout') {
    authVersion++;
    try {
      await api('/logout', { method: 'POST' });
      state.user = null;
      state.products = [];
      state.tickets = [];
      state.users = [];
      renderLogin();
    } catch (error) { toast(error.message); }
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!['login-form', 'request-form', 'message-form', 'profile-form', 'article-form', 'damage-form', 'admin-create-form', 'settings-form'].includes(form.id) && !form.matches('.admin-user-form')) return;
  event.preventDefault();
  const fields = new FormData(form);
  const button = form.querySelector('[type=submit]');
  if (form.id === 'login-form') return login(fields.get('email'), fields.get('password'), button);
  if (form.id === 'settings-form') {
    const settings = { theme: fields.get('theme'), compact: fields.has('compact'), notifications: fields.has('notifications') };
    localStorage.setItem(`settings-${state.user.id}`, JSON.stringify(settings));
    render();
    toast('Innstillingene er lagret.');
    return;
  }
  mutating = true;
  button.disabled = true;
  const error = form.querySelector('.error');
  if (error) error.textContent = '';
  try {
    if (form.id === 'request-form') {
      const body = { ...Object.fromEntries(fields), productId: form.dataset.productId };
      const { ticket } = await api('/tickets', { method: 'POST', body });
      await loadWorkspace();
      ticketDetail(ticket.id);
      toast('Forespørselen er sendt. Nå begynner et godt samarbeid!');
    } else if (form.id === 'message-form') {
      const { message } = await api(`/tickets/${encodeURIComponent(form.dataset.ticketId)}/messages`, { method: 'POST', body: { body: fields.get('body'), sendEmail: fields.has('sendEmail') } });
      await loadWorkspace();
      ticketDetail(form.dataset.ticketId);
      modalRoot.querySelector('.drawer-scroll').scrollTop = modalRoot.querySelector('.drawer-scroll').scrollHeight;
      modalRoot.querySelector('#message-body').focus();
      if (message.emailStatus === 'failed') toast('Meldingen er lagret, men e-postvarslingen kunne ikke sendes.');
    } else if (form.id === 'profile-form') {
      const body = Object.fromEntries(fields);
      const path = employee() ? `/users/${encodeURIComponent(form.dataset.userId)}` : '/profile';
      await api(path, { method: 'PATCH', body });
      await loadWorkspace();
      toast('Profilen er oppdatert.');
    } else if (form.id === 'article-form') {
      const path = form.dataset.articleId ? `/articles/${encodeURIComponent(form.dataset.articleId)}` : '/articles';
      await api(path, { method: form.dataset.articleId ? 'PATCH' : 'POST', body: Object.fromEntries(fields) });
      state.editArticle = null;
      await loadWorkspace();
      toast('Artikkelen er lagret.');
    } else if (form.id === 'damage-form') {
      const body = Object.fromEntries(fields);
      if (!body.productId && body.ticketId) body.productId = state.tickets.find((ticket) => ticket.id === body.ticketId)?.productId || '';
      if (!body.productId) delete body.productId;
      if (!body.ticketId) delete body.ticketId;
      await api('/damage-reports', { method: 'POST', body });
      await loadWorkspace();
      toast('Skademeldingen er sendt.');
    } else if (form.id === 'admin-create-form') {
      await api('/users', { method: 'POST', body: Object.fromEntries(fields) });
      await loadWorkspace();
      toast('Brukeren er opprettet.');
    } else {
      const body = { active: fields.has('active') };
      if (fields.has('role')) body.role = fields.get('role');
      await api(`/users/${encodeURIComponent(form.dataset.userId)}`, { method: 'PATCH', body });
      await loadWorkspace();
      toast('Brukertilgangen er oppdatert.');
    }
  } catch (error) {
    if (form.isConnected && form.querySelector('.error')) form.querySelector('.error').textContent = error.message;
    else toast(error.message);
  } finally {
    mutating = false;
    button.disabled = false;
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id !== 'global-search') return;
  state.query = event.target.value;
  document.querySelector('#main-content').innerHTML = pageContent();
});

document.addEventListener('change', async (event) => {
  const field = event.target;
  if (field.matches?.('[data-profile-select]')) {
    state.profileId = field.value;
    return document.querySelector('#main-content').innerHTML = pageContent();
  }
  if (field.matches?.('[data-owner-filter]')) {
    state.ownerFilter = field.value;
    return document.querySelector('#main-content').innerHTML = pageContent();
  }
  if (!field.dataset.update || !modalTicketId) return;
  const id = modalTicketId;
  const version = authVersion;
  const refreshDetail = () => {
    if (version !== authVersion || modalTicketId !== id) return;
    const composer = modalRoot.querySelector('#message-body');
    const draft = composer?.value || '';
    const selected = modalRoot.querySelector('[name=sendEmail]')?.checked;
    const focused = document.activeElement === composer;
    const selection = [composer?.selectionStart, composer?.selectionEnd];
    ticketDetail(id, draft);
    const checkbox = modalRoot.querySelector('[name=sendEmail]');
    if (checkbox) checkbox.checked = selected;
    if (focused) {
      const newComposer = modalRoot.querySelector('#message-body');
      newComposer.focus();
      newComposer.setSelectionRange(...selection);
    }
  };
  mutating = true;
  field.disabled = true;
  try {
    await api(`/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: { [field.dataset.update]: field.value } });
    await loadWorkspace();
    refreshDetail();
    toast('Samarbeidet er oppdatert.');
  } catch (error) {
    toast(error.message);
    if (state.user) refreshDetail();
  } finally { mutating = false; field.disabled = false; }
});

document.addEventListener('keydown', (event) => {
  if (!modalRoot.hasChildNodes()) return;
  if (event.key === 'Escape') return closeModal();
  if (event.key !== 'Tab') return;
  const focusable = [...modalRoot.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement.classList.contains('modal'))) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement.classList.contains('modal'))) {
    event.preventDefault(); first?.focus();
  }
});

async function start() {
  try {
    const { user } = await api('/session');
    state.user = user;
    if (user) await loadWorkspace();
    else renderLogin();
  } catch {
    app.innerHTML = `<main class="loading"><span class="brand-mark">ø</span><h1>Vi fikk ikke kontakt med portalen.</h1><p>Kontroller at serveren kjører, og prøv igjen.</p><button class="primary" data-action="retry">Prøv igjen</button></main>`;
    app.querySelector('button').addEventListener('click', start, { once: true });
  }
}
start();

setInterval(async () => {
  if (!state.user || document.hidden || mutating) return;
  const version = authVersion;
  try {
    const data = await api('/workspace');
    if (version !== authVersion || !state.user || data.user.id !== state.user.id || mutating
      || ['tickets', 'articles', 'damageReports', 'users', 'products'].every((key) => JSON.stringify(data[key]) === JSON.stringify(state[key]))) return;
    const focused = document.activeElement;
    if (modalTicketId && focused?.matches('select,input')) return;
    const id = modalTicketId;
    const composer = modalRoot.querySelector('#message-body');
    const draft = composer?.value || '';
    const selection = [composer?.selectionStart, composer?.selectionEnd];
    const emailChecked = modalRoot.querySelector('[name=sendEmail]')?.checked;
    const scroll = modalRoot.querySelector('.drawer-scroll');
    const nearBottom = scroll && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 80;
    const scrollTop = scroll?.scrollTop;
    Object.assign(state, data);
    render();
    if (id) {
      ticketDetail(id, draft);
      const newScroll = modalRoot.querySelector('.drawer-scroll');
      newScroll.scrollTop = nearBottom ? newScroll.scrollHeight : scrollTop;
      const checkbox = modalRoot.querySelector('[name=sendEmail]');
      if (checkbox) checkbox.checked = emailChecked;
      if (focused === composer) {
        const newComposer = modalRoot.querySelector('#message-body');
        newComposer.focus();
        newComposer.setSelectionRange(...selection);
      }
    }
  } catch {
    // Leave the current workspace and unsent draft intact during temporary connection failures.
  }
}, 10000);
