let state = { products: [], services: [], sales: [], payments: [], held: [] };
let cart = {}; // productId -> { qty, price }
let discount = 0;
let resumingHeldId = null;
let editingId = null;
let cardProvider = 'Тинькофф';
let mixProvider = 'Тинькофф';
let cashSheetType = 'in';

const statusEl = document.getElementById('loadStatus');
let statusTimer = null;
function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = 'load-status show' + (isError ? ' error' : '');
  clearTimeout(statusTimer);
  if (!isError) statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1400);
}

// Disables the button for the duration of the handler so a slow response
// (Apps Script can take several seconds) doesn't invite a second tap that
// submits the same document twice. Mirrors guardClick() in app.js.
function guardClick(el, handler) {
  el.addEventListener('click', async (e) => {
    if (el.disabled) return;
    el.disabled = true;
    try {
      await handler(e);
    } finally {
      el.disabled = false;
    }
  });
}

async function api(action, payload) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(CONFIG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, payload: payload || {} })
      });
      const text = await res.text();
      const json = JSON.parse(text);
      if (!json.ok) throw new Error(json.error || 'Unknown API error');
      // A rare Apps Script cold-start hiccup can return ok:true with no
      // payload attached; treat that as retryable instead of crashing
      // downstream on e.g. "data.products is undefined".
      if (json.data === undefined || json.data === null) throw new Error('Пустой ответ сервера');
      return json.data;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

function money(n) { return Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽'; }
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function initials(name) { return (name || '?').trim().slice(0, 1).toUpperCase(); }
function formatTime(d) {
  const date = new Date(d);
  if (isNaN(date)) return '';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function isToday(d) {
  const date = new Date(d);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}
// Товары have a Quantity (stock); услуги don't — that's how the catalog
// tells the two apart wherever it needs different rendering or behavior.
function getCatalogItems() { return state.products.concat(state.services); }
function findCatalogItem(id) { return state.products.find(x => x.ID === id) || state.services.find(x => x.ID === id); }
function productName(id) {
  const p = findCatalogItem(id);
  return p ? p.Name : '';
}

// ---- Load ----
async function loadAll(silent) {
  if (!silent) setStatus('Загрузка...');
  try {
    const data = await api('getAll');
    state.products = data.products || [];
    state.services = data.services || [];
    state.sales = data.sales || [];
    state.payments = data.payments || [];
    state.held = data.held || [];
    renderCatalog(document.getElementById('searchInput').value);
    updateHeldChip();
    renderHeld();
    renderHistory();
    renderReport();
    if (!silent) setStatus('Обновлено');
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

// ---- Catalog ----
function renderCatalog(filter) {
  const q = (filter || '').trim().toLowerCase();
  const list = document.getElementById('catalogList');
  const items = getCatalogItems().filter(p => !q ||
    String(p.Name || '').toLowerCase().includes(q) ||
    String(p.Code || '').toLowerCase().includes(q) ||
    String(p.Article || '').toLowerCase().includes(q)
  );
  list.innerHTML = items.map(p => {
    const isService = p.Quantity === undefined;
    const inCart = !!cart[p.ID];
    const controls = inCart
      ? `<div class="qty-stepper"><button data-dec="${p.ID}">−</button><input type="number" inputmode="numeric" class="qv" min="1" value="${cart[p.ID].qty}" data-qty-input="${p.ID}" onfocus="this.select()"><button data-inc="${p.ID}">+</button></div>`
      : `<button class="add-btn" data-add="${p.ID}">+</button>`;
    const meta = isService ? '<span class="stock">услуга</span>' : `<span class="stock ${Number(p.Quantity) <= 0 ? 'low' : ''}">ост. ${p.Quantity}</span>`;
    return `<div class="product-row">
      <div class="product-thumb">${initials(p.Name)}</div>
      <div class="product-info">
        <div class="product-name">${escapeHtml(p.Name)}</div>
        <div class="product-meta"><span>${escapeHtml(p.Code || p.Article || '')}</span>${meta}</div>
      </div>
      <div class="product-price"><span class="amt">${money(p.Price)}</span></div>
      ${controls}
    </div>`;
  }).join('') || '<div style="text-align:center;color:var(--muted);padding:30px 0;font-size:13px;">Ничего не найдено</div>';
  updateCartBar();
}

function updateCartBar() {
  const ids = Object.keys(cart);
  const bar = document.getElementById('cartBar');
  const count = ids.reduce((s, id) => s + cart[id].qty, 0);
  const sum = ids.reduce((s, id) => s + cart[id].qty * cart[id].price, 0);
  document.getElementById('cartBarCount').textContent = count;
  document.getElementById('cartBarSum').textContent = money(sum);
  bar.classList.toggle('hidden', ids.length === 0);
}

document.getElementById('searchInput').addEventListener('input', e => renderCatalog(e.target.value));

document.getElementById('catalogList').addEventListener('click', e => {
  const addId = e.target.closest('[data-add]')?.dataset.add;
  const incId = e.target.closest('[data-inc]')?.dataset.inc;
  const decId = e.target.closest('[data-dec]')?.dataset.dec;
  const id = addId || incId || decId;
  if (!id) return;
  const p = findCatalogItem(id);
  if (!p) return;
  if (addId || incId) {
    if (!cart[id]) cart[id] = { qty: 1, price: Number(p.Price) || 0 };
    else cart[id].qty += 1;
  } else if (decId) {
    if (cart[id]) {
      cart[id].qty -= 1;
      if (cart[id].qty <= 0) delete cart[id];
    }
  }
  renderCatalog(document.getElementById('searchInput').value);
});

// Typing a quantity directly (instead of tapping + repeatedly) - committed
// on blur/Enter via 'change' so a full re-render doesn't fight the keystrokes.
document.getElementById('catalogList').addEventListener('change', e => {
  const id = e.target.closest('[data-qty-input]')?.dataset.qtyInput;
  if (!id || !cart[id]) return;
  const qty = Math.floor(Number(e.target.value));
  if (!qty || qty < 1) delete cart[id];
  else cart[id].qty = qty;
  renderCatalog(document.getElementById('searchInput').value);
});

document.getElementById('cartBar').addEventListener('click', () => goto('cart'));

// ---- Navigation ----
function goto(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  if (view === 'cart') renderCart();
  if (view === 'pay') openPay();
  if (view === 'held') renderHeld();
}

document.querySelectorAll('[data-nav]').forEach(el => {
  el.addEventListener('click', () => goto(el.dataset.nav));
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + tab).classList.add('active');
    if (tab === 'history') renderHistory();
    if (tab === 'report') renderReport();
  });
});

// ---- Cart / Чек ----
function renderCart() {
  const ids = Object.keys(cart);
  const list = document.getElementById('cartList');
  list.innerHTML = ids.map((id, i) => {
    const p = findCatalogItem(id) || { Name: 'Товар удалён', Code: '' };
    const c = cart[id];
    return `<div class="cart-item" data-edit="${id}">
      <span class="num">${i + 1}</span>
      <div class="ci-thumb">${initials(p.Name)}</div>
      <div class="ci-info">
        <div class="ci-name">${escapeHtml(p.Name)}</div>
        <div class="ci-sub">${c.qty} × ${money(c.price)}</div>
      </div>
      <div class="ci-sum">${money(c.qty * c.price)}</div>
    </div>`;
  }).join('') || '<div style="text-align:center;color:var(--muted);padding:30px 0;font-size:13px;">Чек пуст</div>';

  const subtotal = ids.reduce((s, id) => s + cart[id].qty * cart[id].price, 0);
  const total = Math.max(0, subtotal - discount);
  document.getElementById('sumSubtotal').textContent = money(subtotal);
  document.getElementById('sumDiscount').textContent = money(discount);
  document.getElementById('sumTotal').textContent = money(total);
  document.getElementById('ctaTotal').textContent = money(total);
}

document.getElementById('cartList').addEventListener('click', e => {
  const id = e.target.closest('[data-edit]')?.dataset.edit;
  if (id) openSheet(id);
});

document.getElementById('discountInput').addEventListener('input', e => {
  discount = Number(e.target.value) || 0;
  renderCart();
});

document.getElementById('checkoutBtn').addEventListener('click', () => {
  if (!Object.keys(cart).length) return;
  goto('pay');
});

// ---- Item edit sheet ----
function openSheet(id) {
  editingId = id;
  const p = findCatalogItem(id) || { Name: 'Товар', Code: '' };
  const c = cart[id];
  document.getElementById('sheetThumb').textContent = initials(p.Name);
  document.getElementById('sheetName').textContent = p.Name;
  document.getElementById('sheetSub').textContent = (p.Code || p.Article || '') + (p.Quantity === undefined ? ' · услуга' : ' · остаток ' + p.Quantity);
  document.getElementById('qtyVal').value = c.qty;
  document.getElementById('priceInput').value = c.price;
  document.getElementById('sheetBackdrop').classList.add('open');
}
function closeSheet() { document.getElementById('sheetBackdrop').classList.remove('open'); editingId = null; }

document.getElementById('qtyMinus').addEventListener('click', () => {
  const v = document.getElementById('qtyVal');
  v.value = Math.max(1, (Number(v.value) || 0) - 1);
});
document.getElementById('qtyPlus').addEventListener('click', () => {
  const v = document.getElementById('qtyVal');
  v.value = (Number(v.value) || 0) + 1;
});
document.getElementById('sheetSaveBtn').addEventListener('click', () => {
  if (!editingId) return;
  cart[editingId].qty = Math.max(1, Math.floor(Number(document.getElementById('qtyVal').value)) || 1);
  cart[editingId].price = Number(document.getElementById('priceInput').value) || 0;
  closeSheet();
  renderCart();
});
document.getElementById('sheetRemoveBtn').addEventListener('click', () => {
  if (!editingId) return;
  delete cart[editingId];
  closeSheet();
  renderCart();
  renderCatalog(document.getElementById('searchInput').value);
});
document.getElementById('sheetBackdrop').addEventListener('click', e => {
  if (e.target.id === 'sheetBackdrop') closeSheet();
});

// ---- Held checks (Отложенные) ----
function heldSum(h) { return Math.max(0, (h.Items || []).reduce((s, i) => s + Number(i.qty) * Number(i.price), 0) - Number(h.Discount || 0)); }
function heldCount(h) { return (h.Items || []).reduce((s, i) => s + Number(i.qty), 0); }

function updateHeldChip() {
  const btn = document.getElementById('heldBtn');
  document.getElementById('heldCount').textContent = state.held.length;
  btn.classList.toggle('hidden', state.held.length === 0);
}

guardClick(document.getElementById('holdBtn'), holdCurrentCart);
document.getElementById('heldBtn').addEventListener('click', () => goto('held'));

async function holdCurrentCart() {
  const ids = Object.keys(cart);
  if (!ids.length) return;
  const items = ids.map(id => ({ productId: id, name: productName(id), qty: cart[id].qty, price: cart[id].price }));
  setStatus('Сохранение...');
  try {
    let result;
    if (resumingHeldId) {
      result = await api('updateHeld', { id: resumingHeldId, items, discount });
      const idx = state.held.findIndex(h => h.ID === resumingHeldId);
      if (idx !== -1) state.held[idx] = result; else state.held.push(result);
    } else {
      result = await api('addHeld', { items, discount });
      state.held.push(result);
    }
    cart = {}; discount = 0; resumingHeldId = null;
    document.getElementById('discountInput').value = 0;
    updateHeldChip();
    renderReport();
    goto('catalog');
    renderCatalog(document.getElementById('searchInput').value);
    setStatus('Отложено');
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

function renderHeld() {
  const list = document.getElementById('heldList');
  list.innerHTML = state.held.slice().reverse().map(h => `
    <div class="held-item" data-resume="${h.ID}">
      <div class="hi-icon">⏱</div>
      <div class="hi-info">
        <div class="hi-title">Чек · ${heldCount(h)} тов.</div>
        <div class="hi-sub">Отложен в ${formatTime(h.Date)}</div>
      </div>
      <div class="hi-sum">${money(heldSum(h))}</div>
      <button class="hi-del" data-discard="${h.ID}">×</button>
    </div>
  `).join('') || '<div style="text-align:center;color:var(--muted);padding:30px 0;font-size:13px;">Нет отложенных чеков</div>';
}

function resumeHeld(id) {
  const h = state.held.find(x => x.ID === id);
  if (!h) return;
  cart = {};
  (h.Items || []).forEach(it => { cart[it.productId] = { qty: Number(it.qty), price: Number(it.price) }; });
  discount = Number(h.Discount) || 0;
  resumingHeldId = id;
  document.getElementById('discountInput').value = discount;
  renderCatalog(document.getElementById('searchInput').value);
  goto('cart');
}

async function discardHeld(id) {
  setStatus('Удаление...');
  try {
    await api('deleteHeld', { id });
    state.held = state.held.filter(h => h.ID !== id);
    updateHeldChip();
    renderReport();
    renderHeld();
    setStatus('Удалено');
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

document.getElementById('heldList').addEventListener('click', e => {
  const resumeId = e.target.closest('[data-resume]')?.dataset.resume;
  const discardId = e.target.closest('[data-discard]')?.dataset.discard;
  if (discardId) { discardHeld(discardId); return; }
  if (resumeId) resumeHeld(resumeId);
});

// ---- Payment ----
function resetProviderChips() {
  cardProvider = 'Тинькофф'; mixProvider = 'Тинькофф';
  document.querySelectorAll('#cardProviders .provider-chip').forEach(b => b.classList.toggle('active', b.dataset.provider === 'Тинькофф'));
  document.querySelectorAll('#mixProviders .provider-chip').forEach(b => b.classList.toggle('active', b.dataset.provider === 'Тинькофф'));
}

function openPay() {
  const ids = Object.keys(cart);
  const subtotal = ids.reduce((s, id) => s + cart[id].qty * cart[id].price, 0);
  const total = Math.max(0, subtotal - discount);
  document.getElementById('payTotal').textContent = money(total);
  document.getElementById('cashInput').value = total.toFixed(2);
  document.getElementById('mixCash').value = (total / 2).toFixed(2);
  document.getElementById('mixCard').value = (total - Number((total / 2).toFixed(2))).toFixed(2);
  document.getElementById('cardComment').value = '';
  document.getElementById('mixComment').value = '';
  resetProviderChips();
  updateChange();
}

function updateChange() {
  const total = parseFloat(document.getElementById('payTotal').textContent.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
  const given = Number(document.getElementById('cashInput').value) || 0;
  const change = Math.max(0, given - total);
  document.getElementById('changeRow').innerHTML = 'Сдача: <b>' + money(change) + '</b>';
}
document.getElementById('cashInput').addEventListener('input', updateChange);

document.getElementById('cardProviders').addEventListener('click', e => {
  const btn = e.target.closest('.provider-chip');
  if (!btn) return;
  cardProvider = btn.dataset.provider;
  document.querySelectorAll('#cardProviders .provider-chip').forEach(b => b.classList.toggle('active', b === btn));
});
document.getElementById('mixProviders').addEventListener('click', e => {
  const btn = e.target.closest('.provider-chip');
  if (!btn) return;
  mixProvider = btn.dataset.provider;
  document.querySelectorAll('#mixProviders .provider-chip').forEach(b => b.classList.toggle('active', b === btn));
});

async function completeSale(method) {
  const ids = Object.keys(cart);
  if (!ids.length) return;
  const subtotal = ids.reduce((s, id) => s + cart[id].qty * cart[id].price, 0);
  const total = Math.max(0, subtotal - discount);

  let cashAmount = 0, cardAmount = 0, provider = '', comment = '';
  if (method === 'cash') {
    cashAmount = total;
  } else if (method === 'card') {
    cardAmount = total;
    provider = cardProvider;
    comment = document.getElementById('cardComment').value.trim();
  } else {
    cashAmount = Number(document.getElementById('mixCash').value) || 0;
    cardAmount = Number(document.getElementById('mixCard').value) || 0;
    provider = mixProvider;
    comment = document.getElementById('mixComment').value.trim();
  }

  const items = ids.map(id => ({ productId: id, name: productName(id), qty: cart[id].qty, price: cart[id].price }));
  const payload = { items, discount, cashAmount, cardAmount, provider, comment };
  if (resumingHeldId) payload.heldId = resumingHeldId;

  setStatus('Проведение...');
  try {
    const sale = await api('addSale', payload);
    const heldId = resumingHeldId;
    applyLocalSaleEffects(sale, items, heldId);

    const methodText = method === 'cash' ? 'Наличными'
      : method === 'card' ? (provider + (comment ? ' · ' + comment : ''))
      : ('Смешанная — нал. + ' + provider + (comment ? ' · ' + comment : ''));
    document.getElementById('successAmt').textContent = money(sale.Total);
    document.getElementById('successMethod').textContent = methodText;
    goto('success');
    setStatus('Готово');
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

function applyLocalSaleEffects(sale, items, heldId) {
  items.forEach(it => {
    const p = state.products.find(x => x.ID === it.productId);
    if (p) p.Quantity = Number(p.Quantity) - Number(it.qty);
  });
  if (heldId) state.held = state.held.filter(h => h.ID !== heldId);
  state.sales.push(sale);
  cart = {}; discount = 0; resumingHeldId = null;
  document.getElementById('discountInput').value = 0;
  updateHeldChip();
  renderHistory();
  renderReport();
}

const payButtons = document.querySelectorAll('[data-pay]');
payButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    payButtons.forEach(b => b.disabled = true);
    try {
      await completeSale(btn.dataset.pay);
    } finally {
      payButtons.forEach(b => b.disabled = false);
    }
  });
});

document.getElementById('newSaleBtn').addEventListener('click', () => {
  renderCatalog(document.getElementById('searchInput').value);
  goto('catalog');
});

// ---- Report (Отчёт, today only, resets automatically) ----
function renderReport() {
  const todaysSales = state.sales.filter(s => isToday(s.Date));
  const revenue = todaysSales.reduce((s, x) => s + Number(x.Total || 0), 0);
  const cash = todaysSales.reduce((s, x) => s + Number(x.CashAmount || 0), 0);
  const card = todaysSales.reduce((s, x) => s + Number(x.CardAmount || 0), 0);

  document.getElementById('reportDate').textContent = 'Сегодня, ' + new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('repRevenue').textContent = money(revenue);
  document.getElementById('repCash').textContent = 'Нал. ' + money(cash);
  document.getElementById('repCard').textContent = 'Безнал. ' + money(card);
  document.getElementById('repSales').textContent = todaysSales.length + ' · ' + money(revenue);

  // Running cash-on-hand balance, unlike "Выручка сегодня" this never resets:
  // all-time cash from sales + every Внесение через кассу − every Выплата через
  // кассу. Deliberately excludes other Payments categories (e.g. Аренда entered
  // from the admin site) since those aren't cash physically moved through this
  // till.
  const allCashFromSales = state.sales.reduce((s, x) => s + Number(x.CashAmount || 0), 0);
  const cashIn = state.payments.filter(p => p.Type === 'income' && p.Category === 'Внесение').reduce((s, p) => s + Number(p.Amount || 0), 0);
  const cashOut = state.payments.filter(p => p.Type === 'expense' && p.Category === 'Выплата').reduce((s, p) => s + Number(p.Amount || 0), 0);
  document.getElementById('repCashBalance').textContent = money(allCashFromSales + cashIn - cashOut);

  const pendingSum = state.held.reduce((s, h) => s + heldSum(h), 0);
  document.getElementById('repPending').textContent = state.held.length + ' · ' + money(pendingSum);
  document.getElementById('repTotal').textContent = money(revenue);

  renderMovements();
}

function renderMovements() {
  const todays = state.payments.filter(p => isToday(p.Date)).slice().reverse();
  const list = document.getElementById('movementsList');
  list.innerHTML = todays.map(p => {
    const isIn = p.Type === 'income';
    const label = p.Category + (p.Comment ? ' — ' + p.Comment : '');
    return `<div class="movement-item">
      <div class="mi-icon ${isIn ? 'in' : 'out'}">${isIn ? '↓' : '↑'}</div>
      <div class="mi-info"><div class="mi-comment">${escapeHtml(label)}</div><div class="mi-time">${formatTime(p.Date)}</div></div>
      <div class="mi-amt ${isIn ? 'in' : 'out'}">${isIn ? '+' : '−'}${money(p.Amount)}</div>
    </div>`;
  }).join('') || '<div class="movement-empty">Сегодня внесений и выплат не было</div>';
}

function openCashSheet(type) {
  cashSheetType = type;
  document.getElementById('cashSheetTitle').textContent = type === 'in' ? 'Внесение денег' : 'Выплата денег';
  document.getElementById('cashSheetAmount').value = '';
  document.getElementById('cashSheetComment').value = '';
  document.getElementById('cashSheetBackdrop').classList.add('open');
}
function closeCashSheet() { document.getElementById('cashSheetBackdrop').classList.remove('open'); }

async function saveCashMovement() {
  const amount = Number(document.getElementById('cashSheetAmount').value) || 0;
  const comment = document.getElementById('cashSheetComment').value.trim();
  if (!amount) return;
  // Close right away instead of waiting for the server: a slow response
  // (Apps Script cold start) left the sheet sitting open looking stuck,
  // which is what led someone to back out and retry, saving it twice.
  closeCashSheet();
  setStatus('Сохранение...');
  try {
    const type = cashSheetType === 'in' ? 'income' : 'expense';
    const category = cashSheetType === 'in' ? 'Внесение' : 'Выплата';
    const payment = await api('addPayment', { type, category, amount, comment });
    state.payments.push(payment);
    renderReport();
    setStatus('Сохранено');
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

document.getElementById('cashInBtn').addEventListener('click', () => openCashSheet('in'));
document.getElementById('cashOutBtn').addEventListener('click', () => openCashSheet('out'));
guardClick(document.getElementById('cashSheetSaveBtn'), saveCashMovement);
document.getElementById('cashSheetBackdrop').addEventListener('click', e => {
  if (e.target.id === 'cashSheetBackdrop') closeCashSheet();
});

// ---- History (today only, read-only) ----
function saleMethodLabel(s) {
  const cash = Number(s.CashAmount) || 0, card = Number(s.CardAmount) || 0;
  if (cash > 0 && card > 0) return 'Смешанная — нал. + ' + (s.Provider || '') + (s.Comment ? ' · ' + s.Comment : '');
  if (card > 0) return (s.Provider || 'Безналичными') + (s.Comment ? ' · ' + s.Comment : '');
  return 'Наличными';
}

function renderHistory() {
  const todaysSales = state.sales.filter(s => isToday(s.Date)).slice().reverse();
  const list = document.getElementById('historyList');
  list.innerHTML = todaysSales.map(s => {
    const count = (s.Items || []).reduce((sum, i) => sum + Number(i.qty), 0);
    return `<div class="history-item" data-open-sale="${s.ID}">
      <div class="hs-icon">✓</div>
      <div class="hs-info"><div class="hs-title">${count} тов. · ${escapeHtml(saleMethodLabel(s))}</div><div class="hs-sub">${formatTime(s.Date)}</div></div>
      <div class="hs-sum">${money(s.Total)}</div>
    </div>`;
  }).join('') || '<div style="text-align:center;color:var(--muted);padding:30px 0;font-size:13px;">Сегодня продаж ещё не было</div>';
}

function openSaleDetail(id) {
  const s = state.sales.find(x => x.ID === id);
  if (!s) return;
  const subtotal = (s.Items || []).reduce((sum, i) => sum + Number(i.qty) * Number(i.price), 0);
  document.getElementById('saleDetailTime').textContent = 'Сегодня, ' + formatTime(s.Date);
  document.getElementById('saleDetailMethod').textContent = saleMethodLabel(s);
  document.getElementById('saleDetailItems').innerHTML = (s.Items || []).map(it => `
    <div class="sd-item">
      <div class="sd-name">${escapeHtml(it.name)}</div>
      <div class="sd-line"><span>${it.qty} × ${money(it.price)}</span><span>${money(it.qty * it.price)}</span></div>
    </div>
  `).join('');
  document.getElementById('saleDetailSubtotal').textContent = money(subtotal);
  document.getElementById('saleDetailDiscount').textContent = money(s.Discount || 0);
  document.getElementById('saleDetailTotal').textContent = money(s.Total);
  document.getElementById('saleDetailBackdrop').classList.add('open');
}
function closeSaleDetail() { document.getElementById('saleDetailBackdrop').classList.remove('open'); }

document.getElementById('historyList').addEventListener('click', e => {
  const id = e.target.closest('[data-open-sale]')?.dataset.openSale;
  if (id) openSaleDetail(id);
});
document.getElementById('saleDetailCloseBtn').addEventListener('click', closeSaleDetail);
document.getElementById('saleDetailBackdrop').addEventListener('click', e => {
  if (e.target.id === 'saleDetailBackdrop') closeSaleDetail();
});

// ---- Init ----
if (!CONFIG.API_URL || CONFIG.API_URL.startsWith('PASTE_')) {
  setStatus('Укажите API_URL в config.js', true);
} else {
  // Apps Script's first request after being idle ("cold start") can be slow
  // enough to exhaust api()'s own retries. One extra automatic retry a few
  // seconds later covers that without making the seller reload the page.
  loadAll().then(() => { if (!state.products.length) setTimeout(() => loadAll(), 3000); });
  setInterval(() => loadAll(true), 3 * 60 * 1000);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
