const state = { products: [], contacts: [], orders: [], inventories: [], sales: [], payments: [] };

const statusEl = document.getElementById('status');

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
      return json.data;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' error' : '');
}

// Disables the button for the duration of the handler so a fast double/triple
// click (or an impatient re-click while a request is in flight) can't submit
// the same document more than once.
function guardClick(id, handler) {
  const btn = document.getElementById(id);
  btn.addEventListener('click', async (e) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await handler(e);
    } finally {
      btn.disabled = false;
    }
  });
}

const createButtonIds = ['addProductBtn', 'addContactBtn', 'addOrderBtn', 'addSaleBtn'];
function setCreateButtonsEnabled(enabled) {
  createButtonIds.forEach(id => { document.getElementById(id).disabled = !enabled; });
}

async function loadAll() {
  setStatus('Загрузка...');
  setCreateButtonsEnabled(false);
  try {
    const data = await api('getAll');
    state.products = data.products;
    state.contacts = data.contacts;
    state.orders = data.orders;
    state.inventories = data.inventories || [];
    state.sales = data.sales || [];
    state.payments = data.payments || [];
    renderProducts();
    renderContacts();
    renderOrders();
    renderInventories();
    renderStock();
    renderSales();
    renderPayments();
    setStatus('Обновлено: ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  } finally {
    setCreateButtonsEnabled(true);
  }
}

// ---- Tabs ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

document.querySelectorAll('.subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subtab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.subtab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('sub-' + btn.dataset.subtab).classList.add('active');
  });
});

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// ---- Products ----
function renderProducts() {
  const body = document.getElementById('productsBody');
  body.innerHTML = state.products.map(p => `
    <tr>
      <td>${escapeHtml(p.Name)}</td>
      <td>${escapeHtml(p.Article)}</td>
      <td>${escapeHtml(p.Code)}</td>
      <td>${escapeHtml(p.Group)}</td>
      <td>${escapeHtml(p.Unit)}</td>
      <td>${formatMoney(p.CostPrice)}</td>
      <td>${formatMoney(p.MinPrice)}</td>
      <td>${formatMoney(p.Price)}</td>
      <td class="${Number(p.Quantity) <= 0 ? 'low-stock' : ''}">${p.Quantity}</td>
      <td class="actions">
        <button class="btn" data-edit-product="${p.ID}">Изменить</button>
        <button class="btn danger" data-delete-product="${p.ID}">Удалить</button>
      </td>
    </tr>
  `).join('');
}

function fillProductForm(p) {
  document.getElementById('productId').value = p.ID || '';
  document.getElementById('productName').value = p.Name || '';
  document.getElementById('productGroup').value = p.Group || '';
  document.getElementById('productArticle').value = p.Article || '';
  document.getElementById('productCode').value = p.Code || '';
  document.getElementById('productUnit').value = p.Unit || 'шт';
  document.getElementById('productMinPrice').value = p.MinPrice || 0;
  document.getElementById('productCostPrice').value = p.CostPrice || 0;
  document.getElementById('productPrice').value = p.Price || 0;
  document.getElementById('productQuantity').value = p.Quantity || 0;
}

document.getElementById('addProductBtn').addEventListener('click', () => {
  document.getElementById('productModalTitle').textContent = 'Новый товар';
  fillProductForm({});
  openModal('productModal');
});

document.getElementById('productsBody').addEventListener('click', async (e) => {
  const editId = e.target.dataset.editProduct;
  const delId = e.target.dataset.deleteProduct;
  if (editId) {
    const p = state.products.find(x => x.ID === editId);
    document.getElementById('productModalTitle').textContent = 'Изменить товар';
    fillProductForm(p);
    openModal('productModal');
  } else if (delId) {
    if (!confirm('Удалить товар?')) return;
    await api('deleteProduct', { id: delId });
    await loadAll();
  }
});

guardClick('saveProductBtn', async () => {
  const id = document.getElementById('productId').value;
  const costPriceInput = document.getElementById('productCostPrice');
  const payload = {
    id,
    name: document.getElementById('productName').value.trim(),
    group: document.getElementById('productGroup').value.trim(),
    article: document.getElementById('productArticle').value.trim(),
    code: document.getElementById('productCode').value.trim(),
    unit: document.getElementById('productUnit').value.trim(),
    minPrice: document.getElementById('productMinPrice').value,
    costPrice: costPriceInput.value,
    price: document.getElementById('productPrice').value,
    quantity: document.getElementById('productQuantity').value
  };
  if (!payload.name) { alert('Укажите название'); return; }
  if (costPriceInput.value === '') { alert('Укажите закупочную цену'); costPriceInput.focus(); return; }
  await api(id ? 'updateProduct' : 'addProduct', payload);
  closeModal('productModal');
  await loadAll();
});

// ---- Contacts ----
const typeLabels = { client: 'Клиент', supplier: 'Поставщик' };

function renderContacts() {
  const body = document.getElementById('contactsBody');
  body.innerHTML = state.contacts.map(c => `
    <tr>
      <td>${escapeHtml(c.Name)}</td>
      <td>${typeLabels[c.Type] || c.Type}</td>
      <td>${escapeHtml(c.Phone)}</td>
      <td>${escapeHtml(c.Email)}</td>
      <td>${escapeHtml(c.Address)}</td>
      <td class="actions">
        <button class="btn" data-edit-contact="${c.ID}">Изменить</button>
        <button class="btn danger" data-delete-contact="${c.ID}">Удалить</button>
      </td>
    </tr>
  `).join('');
  const select = document.getElementById('orderContact');
  select.innerHTML = state.contacts.map(c => `<option value="${c.ID}">${escapeHtml(c.Name)}</option>`).join('');
}

document.getElementById('addContactBtn').addEventListener('click', () => {
  document.getElementById('contactModalTitle').textContent = 'Новый контрагент';
  document.getElementById('contactId').value = '';
  document.getElementById('contactName').value = '';
  document.getElementById('contactType').value = 'client';
  document.getElementById('contactPhone').value = '';
  document.getElementById('contactEmail').value = '';
  document.getElementById('contactAddress').value = '';
  openModal('contactModal');
});

document.getElementById('contactsBody').addEventListener('click', async (e) => {
  const editId = e.target.dataset.editContact;
  const delId = e.target.dataset.deleteContact;
  if (editId) {
    const c = state.contacts.find(x => x.ID === editId);
    document.getElementById('contactModalTitle').textContent = 'Изменить контрагента';
    document.getElementById('contactId').value = c.ID;
    document.getElementById('contactName').value = c.Name;
    document.getElementById('contactType').value = c.Type;
    document.getElementById('contactPhone').value = c.Phone;
    document.getElementById('contactEmail').value = c.Email;
    document.getElementById('contactAddress').value = c.Address;
    openModal('contactModal');
  } else if (delId) {
    if (!confirm('Удалить контрагента?')) return;
    await api('deleteContact', { id: delId });
    await loadAll();
  }
});

guardClick('saveContactBtn', async () => {
  const id = document.getElementById('contactId').value;
  const payload = {
    id,
    name: document.getElementById('contactName').value.trim(),
    type: document.getElementById('contactType').value,
    phone: document.getElementById('contactPhone').value.trim(),
    email: document.getElementById('contactEmail').value.trim(),
    address: document.getElementById('contactAddress').value.trim()
  };
  if (!payload.name) { alert('Укажите имя/название'); return; }
  await api(id ? 'updateContact' : 'addContact', payload);
  closeModal('contactModal');
  await loadAll();
});

// ---- Orders (заказы поставщикам) ----
function renderOrders() {
  const body = document.getElementById('ordersBody');
  body.innerHTML = state.orders.slice().reverse().map(o => `
    <tr>
      <td>${formatDate(o.Date)}</td>
      <td>${escapeHtml(o.ContactName)}</td>
      <td>${escapeHtml(o.Status)}</td>
      <td>${formatMoney(o.Total)}</td>
      <td class="actions">
        <button class="btn danger" data-delete-order="${o.ID}">Удалить</button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('ordersBody').addEventListener('click', async (e) => {
  const delId = e.target.dataset.deleteOrder;
  if (delId) {
    if (!confirm('Удалить заказ? Остатки на складе будут возвращены.')) return;
    await api('deleteOrder', { orderId: delId });
    await loadAll();
  }
});

document.getElementById('addOrderBtn').addEventListener('click', () => {
  document.querySelectorAll('.item-product-suggestions').forEach(el => el.remove());
  document.getElementById('orderItemsBody').innerHTML = '';
  document.getElementById('orderDelivery').value = 0;
  addOrderItemRow();
  updateOrderTotal();
  openModal('orderModal');
});

// Shared factory for a table row with a searchable product picker (used by
// both Orders and Sales item tables). priceFn picks the default price to fill
// in when a product is selected (cost price for purchases, sale price for sales).
function createProductPickerRow(containerId, priceFn, onChange) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="item-product-cell">
      <input type="hidden" class="item-product-id">
      <input type="text" class="item-product-search" placeholder="Название, код или артикул…" autocomplete="off">
    </td>
    <td><input type="number" class="item-qty" value="1" min="0.01" step="0.01"></td>
    <td><input type="number" class="item-price" value="0" min="0" step="0.01"></td>
    <td class="item-sum">0</td>
    <td class="actions"><button class="btn danger" data-remove-item>×</button></td>
  `;
  document.getElementById(containerId).appendChild(row);

  const idInput = row.querySelector('.item-product-id');
  const searchInput = row.querySelector('.item-product-search');
  const priceInput = row.querySelector('.item-price');

  function updateRowSum() {
    const qty = Number(row.querySelector('.item-qty').value) || 0;
    const price = Number(priceInput.value) || 0;
    row.querySelector('.item-sum').textContent = formatMoney(qty * price);
    onChange();
  }

  // Rendered on <body>, not inside the table, so it can't get clipped or
  // painted under later siblings by the table's own stacking context.
  const suggestBox = document.createElement('div');
  suggestBox.className = 'picker-suggestions item-product-suggestions';
  suggestBox.hidden = true;
  document.body.appendChild(suggestBox);

  function positionSuggestBox() {
    const rect = searchInput.getBoundingClientRect();
    suggestBox.style.position = 'fixed';
    suggestBox.style.top = (rect.bottom + 4) + 'px';
    suggestBox.style.left = rect.left + 'px';
    suggestBox.style.width = rect.width + 'px';
  }

  function showProductSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (!q) { suggestBox.hidden = true; return; }
    positionSuggestBox();
    const matches = state.products.filter(p =>
      String(p.Name || '').toLowerCase().includes(q) ||
      String(p.Code || '').toLowerCase().includes(q) ||
      String(p.Article || '').toLowerCase().includes(q)
    ).slice(0, 10);
    if (!matches.length) {
      suggestBox.innerHTML = '<div class="picker-suggestion" style="color:var(--muted);">Не найдено</div>';
      suggestBox.hidden = false;
      return;
    }
    suggestBox.innerHTML = matches.map((p, i) => `
      <div class="picker-suggestion" data-idx="${i}">
        <span>${escapeHtml(p.Name)}</span>
        <span class="kind">${escapeHtml(p.Code || p.Article || '')} · ост. ${p.Quantity}</span>
      </div>
    `).join('');
    suggestBox.hidden = false;
    suggestBox.querySelectorAll('.picker-suggestion[data-idx]').forEach((el, i) => {
      el.addEventListener('click', () => {
        const p = matches[i];
        idInput.value = p.ID;
        searchInput.value = p.Name;
        suggestBox.hidden = true;
        priceInput.value = priceFn(p) || 0;
        updateRowSum();
      });
    });
  }

  searchInput.addEventListener('input', () => showProductSuggestions(searchInput.value));
  searchInput.addEventListener('focus', () => { if (searchInput.value) showProductSuggestions(searchInput.value); });
  document.addEventListener('click', (e) => {
    if (!row.contains(e.target) && !suggestBox.contains(e.target)) suggestBox.hidden = true;
  });

  row.querySelector('.item-qty').addEventListener('input', updateRowSum);
  priceInput.addEventListener('input', updateRowSum);
  row.querySelector('[data-remove-item]').addEventListener('click', () => {
    row.remove();
    suggestBox.remove();
    onChange();
  });
}

function addOrderItemRow() {
  createProductPickerRow('orderItemsBody', p => p.CostPrice, updateOrderTotal);
}

function updateOrderTotal() {
  const rows = document.querySelectorAll('#orderItemsBody tr');
  let subtotal = 0;
  rows.forEach(row => {
    const qty = Number(row.querySelector('.item-qty')?.value) || 0;
    const price = Number(row.querySelector('.item-price')?.value) || 0;
    subtotal += qty * price;
  });
  const delivery = Number(document.getElementById('orderDelivery').value) || 0;
  document.getElementById('orderSubtotal').textContent = formatMoney(subtotal);
  document.getElementById('orderDeliveryTotal').textContent = formatMoney(delivery);
  document.getElementById('orderTotal').textContent = formatMoney(subtotal + delivery);
}

document.getElementById('addOrderItemBtn').addEventListener('click', addOrderItemRow);
document.getElementById('orderDelivery').addEventListener('input', updateOrderTotal);

guardClick('saveOrderBtn', async () => {
  const rows = document.querySelectorAll('#orderItemsBody tr');
  const items = Array.from(rows).map(row => ({
    productId: row.querySelector('.item-product-id').value,
    qty: Number(row.querySelector('.item-qty').value),
    price: Number(row.querySelector('.item-price').value)
  })).filter(i => i.productId && i.qty > 0);
  if (items.length === 0) { alert('Добавьте хотя бы одну позицию'); return; }
  const payload = {
    contactId: document.getElementById('orderContact').value,
    type: 'purchase',
    delivery: Number(document.getElementById('orderDelivery').value) || 0,
    items
  };
  await api('addOrder', payload);
  closeModal('orderModal');
  await loadAll();
});

// ---- Warehouse: shared product/group picker ----
function initPicker(prefix, onAdd, onRemove) {
  const chips = document.getElementById(prefix + 'PickerChips');
  const search = document.getElementById(prefix + 'PickerSearch');
  const suggestions = document.getElementById(prefix + 'PickerSuggestions');
  let selected = [];

  function render() {
    chips.querySelectorAll('.picker-chip').forEach(c => c.remove());
    selected.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'picker-chip';
      chip.innerHTML = `<span class="kind">${item.type === 'group' ? 'Группа' : 'Товар'}</span> ${escapeHtml(item.label)} <span class="x">×</span>`;
      chip.querySelector('.x').addEventListener('click', (e) => {
        e.stopPropagation();
        selected = selected.filter(s => s !== item);
        render();
        if (onRemove) onRemove(item);
      });
      chips.insertBefore(chip, search);
    });
  }

  function showSuggestions(query) {
    const q = query.trim().toLowerCase();
    const groups = [...new Set(state.products.map(p => p.Group).filter(Boolean))]
      .filter(g => !selected.some(s => s.type === 'group' && s.id === g))
      .filter(g => !q || g.toLowerCase().includes(q))
      .slice(0, 8)
      .map(g => ({ type: 'group', id: g, label: g }));
    const products = state.products
      .filter(p => !selected.some(s => s.type === 'product' && s.id === p.ID))
      .filter(p => !q || String(p.Name || '').toLowerCase().includes(q) || String(p.Code || '').toLowerCase().includes(q) || String(p.Article || '').toLowerCase().includes(q))
      .slice(0, 8)
      .map(p => ({ type: 'product', id: p.ID, label: p.Name }));
    const items = groups.concat(products);
    if (!items.length) { suggestions.hidden = true; return; }
    suggestions.innerHTML = items.map((it, i) => `<div class="picker-suggestion" data-idx="${i}"><span>${escapeHtml(it.label)}</span><span class="kind">${it.type === 'group' ? 'группа' : 'товар'}</span></div>`).join('');
    suggestions.hidden = false;
    suggestions.querySelectorAll('.picker-suggestion').forEach((el, i) => {
      el.addEventListener('click', () => {
        selected.push(items[i]);
        search.value = '';
        suggestions.hidden = true;
        render();
        if (onAdd) onAdd(items[i]);
      });
    });
  }

  search.addEventListener('focus', () => showSuggestions(search.value));
  search.addEventListener('input', () => showSuggestions(search.value));
  document.addEventListener('click', (e) => {
    if (!chips.parentElement.contains(e.target)) suggestions.hidden = true;
  });

  return {
    getSelected: () => selected,
    clear: () => { selected = []; render(); }
  };
}

const turnoverPicker = initPicker('turnover');
const stockPicker = initPicker('stock', () => renderStock(), () => renderStock());

document.querySelectorAll('#turnoverNoMovementSwitch .switch-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('#turnoverNoMovementSwitch .switch-opt').forEach(o => o.classList.remove('on'));
    opt.classList.add('on');
  });
});

// ---- Warehouse: Обороты ----
async function showTurnover() {
  const from = document.getElementById('turnoverFrom').value;
  const to = document.getElementById('turnoverTo').value;
  const sel = turnoverPicker.getSelected();
  const productIds = sel.filter(s => s.type === 'product').map(s => s.id);
  const groups = sel.filter(s => s.type === 'group').map(s => s.id);
  const includeNoMovement = document.querySelector('#turnoverNoMovementSwitch .switch-opt.on').dataset.val === '1';
  setStatus('Загрузка...');
  try {
    const rows = await api('getTurnover', {
      dateFrom: from ? new Date(from + 'T00:00:00').toISOString() : null,
      dateTo: to ? new Date(to + 'T23:59:59').toISOString() : new Date().toISOString(),
      productIds, groups, includeNoMovement
    });
    renderTurnoverRows(rows);
    setStatus('Обновлено: ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

function renderTurnoverRows(rows) {
  const groupsMap = {};
  rows.forEach(r => { (groupsMap[r.Group || 'Без группы'] = groupsMap[r.Group || 'Без группы'] || []).push(r); });
  const totals = { startQty: 0, startSum: 0, inQty: 0, inSum: 0, outQty: 0, outSum: 0, endQty: 0, endSum: 0 };
  let html = '';
  Object.keys(groupsMap).forEach(g => {
    html += `<tr class="cat-row"><td colspan="11">${escapeHtml(g)}</td></tr>`;
    groupsMap[g].forEach(r => {
      totals.startQty += r.StartQty; totals.startSum += r.StartSum;
      totals.inQty += r.InQty; totals.inSum += r.InSum;
      totals.outQty += r.OutQty; totals.outSum += r.OutSum;
      totals.endQty += r.EndQty; totals.endSum += r.EndSum;
      html += `<tr>
        <td>${escapeHtml(r.Name)}</td><td>${escapeHtml(r.Code)}</td><td>${escapeHtml(r.Unit)}</td>
        <td>${r.StartQty}</td><td>${formatMoney(r.StartSum)}</td>
        <td class="in-cell">${r.InQty}</td><td class="in-cell">${formatMoney(r.InSum)}</td>
        <td class="out-cell">${r.OutQty}</td><td class="out-cell">${formatMoney(r.OutSum)}</td>
        <td>${r.EndQty}</td><td>${formatMoney(r.EndSum)}</td>
      </tr>`;
    });
  });
  document.getElementById('turnoverBody').innerHTML = html || '<tr><td colspan="11" style="text-align:center;color:var(--muted);">Нет данных за период</td></tr>';
  document.getElementById('turnoverTotals').innerHTML = rows.length ? `<td colspan="3">Итого</td><td>${totals.startQty}</td><td>${formatMoney(totals.startSum)}</td><td>${totals.inQty}</td><td>${formatMoney(totals.inSum)}</td><td>${totals.outQty}</td><td>${formatMoney(totals.outSum)}</td><td>${totals.endQty}</td><td>${formatMoney(totals.endSum)}</td>` : '';
}

document.getElementById('turnoverShowBtn').addEventListener('click', showTurnover);

// ---- Warehouse: Остатки ----
let stockSnapshot = null;

async function showStock() {
  const asOfInput = document.getElementById('stockAsOf').value;
  setStatus('Загрузка...');
  try {
    stockSnapshot = asOfInput ? await api('getStockAsOf', { asOf: new Date(asOfInput).toISOString() }) : null;
    renderStock();
    setStatus('Обновлено: ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

function renderStock() {
  const products = stockSnapshot || state.products;
  const sel = stockPicker.getSelected();
  const productIds = sel.filter(s => s.type === 'product').map(s => s.id);
  const groups = sel.filter(s => s.type === 'group').map(s => s.id);
  const stockFilter = document.getElementById('stockFilterSelect').value;

  let filtered = products;
  if (productIds.length || groups.length) {
    filtered = filtered.filter(p => productIds.includes(p.ID) || groups.includes(p.Group));
  }
  if (stockFilter === 'nonzero') filtered = filtered.filter(p => Number(p.Quantity) !== 0);
  if (stockFilter === 'zero') filtered = filtered.filter(p => Number(p.Quantity) === 0);

  const groupsMap = {};
  filtered.forEach(p => { (groupsMap[p.Group || 'Без группы'] = groupsMap[p.Group || 'Без группы'] || []).push(p); });
  const totals = { qty: 0, costSum: 0, saleSum: 0 };
  let html = '';
  Object.keys(groupsMap).forEach(g => {
    html += `<tr class="stock-table-cat"><td colspan="8">${escapeHtml(g)}</td></tr>`;
    groupsMap[g].forEach(p => {
      const costSum = Number(p.Quantity) * Number(p.CostPrice || 0);
      const saleSum = Number(p.Quantity) * Number(p.Price || 0);
      totals.qty += Number(p.Quantity); totals.costSum += costSum; totals.saleSum += saleSum;
      html += `<tr>
        <td>${escapeHtml(p.Name)}</td><td>${escapeHtml(p.Code)}</td>
        <td class="${Number(p.Quantity) <= 0 ? 'low-stock' : ''}">${p.Quantity}</td><td>${escapeHtml(p.Unit)}</td>
        <td>${formatMoney(p.CostPrice)}</td><td>${formatMoney(costSum)}</td>
        <td>${formatMoney(p.Price)}</td><td>${formatMoney(saleSum)}</td>
      </tr>`;
    });
  });
  document.getElementById('stockBody').innerHTML = html || '<tr><td colspan="8" style="text-align:center;color:var(--muted);">Нет товаров</td></tr>';
  document.getElementById('stockTotals').innerHTML = filtered.length ? `<td colspan="2">Итого (${filtered.length})</td><td>${totals.qty}</td><td></td><td></td><td>${formatMoney(totals.costSum)}</td><td></td><td>${formatMoney(totals.saleSum)}</td>` : '';
}

document.getElementById('stockShowBtn').addEventListener('click', showStock);
document.getElementById('stockFilterSelect').addEventListener('change', renderStock);

// ---- Warehouse: Инвентаризации ----
let countItems = [];

function addSingleCountItem(productId) {
  if (countItems.some(r => r.productId === productId)) return;
  const p = state.products.find(x => x.ID === productId);
  if (!p) return;
  countItems.push({ productId: p.ID, name: p.Name, code: p.Code, unit: p.Unit, systemQty: Number(p.Quantity), actualQty: Number(p.Quantity) });
}

const inventoryPicker = initPicker('inventory', (item) => {
  if (item.type === 'product') {
    addSingleCountItem(item.id);
  } else {
    state.products.filter(p => p.Group === item.id).forEach(p => addSingleCountItem(p.ID));
  }
  renderCountItems();
});

function renderCountItems() {
  const body = document.getElementById('inventoryItemsBody');
  body.innerHTML = countItems.map((it, i) => {
    const diff = it.actualQty - it.systemQty;
    const diffClass = diff === 0 ? 'diff-zero' : (diff < 0 ? 'diff-neg' : 'diff-pos');
    const diffText = diff === 0 ? '0' : (diff > 0 ? '+' + diff : String(diff));
    return `<tr>
      <td>${escapeHtml(it.name)}</td><td>${escapeHtml(it.code)}</td><td>${escapeHtml(it.unit)}</td>
      <td>${it.systemQty}</td>
      <td><input type="number" class="actual-input" data-idx="${i}" value="${it.actualQty}"></td>
      <td class="diff-cell ${diffClass}">${diffText}</td>
      <td class="actions"><button class="btn danger" data-remove-count-item="${i}">×</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--muted);">Добавьте товары или группу выше</td></tr>';
}

document.getElementById('inventoryItemsBody').addEventListener('input', (e) => {
  if (!e.target.classList.contains('actual-input')) return;
  const idx = Number(e.target.dataset.idx);
  countItems[idx].actualQty = Number(e.target.value) || 0;
  const diff = countItems[idx].actualQty - countItems[idx].systemQty;
  const cell = e.target.closest('tr').querySelector('.diff-cell');
  cell.className = 'diff-cell ' + (diff === 0 ? 'diff-zero' : (diff < 0 ? 'diff-neg' : 'diff-pos'));
  cell.textContent = diff === 0 ? '0' : (diff > 0 ? '+' + diff : String(diff));
});

document.getElementById('inventoryItemsBody').addEventListener('click', (e) => {
  const idx = e.target.dataset.removeCountItem;
  if (idx !== undefined) { countItems.splice(Number(idx), 1); renderCountItems(); }
});

async function saveInventory(status) {
  if (!countItems.length) { alert('Добавьте хотя бы один товар'); return; }
  const payload = {
    comment: document.getElementById('inventoryComment').value.trim(),
    status,
    items: countItems.map(it => ({ productId: it.productId, name: it.name, code: it.code, unit: it.unit, systemQty: it.systemQty, actualQty: it.actualQty }))
  };
  await api('addInventory', payload);
  countItems = [];
  document.getElementById('inventoryComment').value = '';
  renderCountItems();
  inventoryPicker.clear();
  await loadAll();
}

guardClick('inventoryDraftBtn', () => saveInventory('draft'));
guardClick('inventoryFinalizeBtn', () => saveInventory('done'));

function renderInventories() {
  const body = document.getElementById('inventoriesBody');
  body.innerHTML = state.inventories.slice().reverse().map(inv => `
    <tr>
      <td>${formatDate(inv.Date)}</td>
      <td><span class="status-pill ${inv.Status === 'done' ? 'done' : 'draft'}">${inv.Status === 'done' ? 'Проведена' : 'Черновик'}</span></td>
      <td>${escapeHtml(inv.Comment)}</td>
      <td>${(inv.Items || []).length}</td>
      <td class="actions"><button class="btn danger" data-delete-inventory="${inv.ID}">Удалить</button></td>
    </tr>
  `).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);">Пока нет инвентаризаций</td></tr>';
}

document.getElementById('inventoriesBody').addEventListener('click', async (e) => {
  const delId = e.target.dataset.deleteInventory;
  if (delId) {
    if (!confirm('Удалить инвентаризацию? Если она проведена, остатки будут возвращены.')) return;
    await api('deleteInventory', { id: delId });
    await loadAll();
  }
});

renderCountItems();

// Defaults for warehouse date filters
(function setWarehouseDefaults() {
  const pad = n => String(n).padStart(2, '0');
  const toDateVal = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const toDatetimeVal = d => toDateVal(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  document.getElementById('turnoverFrom').value = toDateVal(monthAgo);
  document.getElementById('turnoverTo').value = toDateVal(now);
  document.getElementById('stockAsOf').value = toDatetimeVal(now);
  document.getElementById('salesFrom').value = toDateVal(monthAgo);
  document.getElementById('salesTo').value = toDateVal(now);
  document.getElementById('paymentsFrom').value = toDateVal(monthAgo);
  document.getElementById('paymentsTo').value = toDateVal(now);
  document.getElementById('pnlFrom').value = toDateVal(monthAgo);
  document.getElementById('pnlTo').value = toDateVal(now);
})();

// ---- Sales (продажи) ----
function renderSales() {
  const body = document.getElementById('salesBody');
  const sales = state.sales.slice().reverse();
  body.innerHTML = sales.map(s => `
    <tr>
      <td>${formatDate(s.Date)}</td>
      <td>${(s.Items || []).length}</td>
      <td>${formatMoney(s.CashAmount)}</td>
      <td>${formatMoney(s.CardAmount)}</td>
      <td>${formatMoney(s.Discount)}</td>
      <td>${formatMoney(s.Total)}</td>
      <td>${escapeHtml(s.Comment)}</td>
      <td class="actions"><button class="btn danger" data-delete-sale="${s.ID}">Удалить</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--muted);">Пока нет продаж</td></tr>';
  const totals = sales.reduce((acc, s) => {
    acc.cash += Number(s.CashAmount) || 0;
    acc.card += Number(s.CardAmount) || 0;
    acc.discount += Number(s.Discount) || 0;
    acc.total += Number(s.Total) || 0;
    return acc;
  }, { cash: 0, card: 0, discount: 0, total: 0 });
  document.getElementById('salesTotals').innerHTML = sales.length
    ? `<td colspan="2">Итого</td><td>${formatMoney(totals.cash)}</td><td>${formatMoney(totals.card)}</td><td>${formatMoney(totals.discount)}</td><td>${formatMoney(totals.total)}</td><td colspan="2"></td>`
    : '';
}

document.getElementById('salesBody').addEventListener('click', async (e) => {
  const delId = e.target.dataset.deleteSale;
  if (delId) {
    if (!confirm('Удалить продажу? Остатки на складе будут возвращены.')) return;
    await api('deleteSale', { id: delId });
    await loadAll();
  }
});

document.getElementById('salesShowBtn').addEventListener('click', renderSales);

function addSaleItemRow() {
  createProductPickerRow('saleItemsBody', p => p.Price, updateSaleTotal);
}

function updateSaleTotal() {
  const rows = document.querySelectorAll('#saleItemsBody tr');
  let subtotal = 0;
  rows.forEach(row => {
    const qty = Number(row.querySelector('.item-qty')?.value) || 0;
    const price = Number(row.querySelector('.item-price')?.value) || 0;
    subtotal += qty * price;
  });
  const discount = Number(document.getElementById('saleDiscount').value) || 0;
  const total = Math.max(0, subtotal - discount);
  document.getElementById('saleSubtotal').textContent = formatMoney(subtotal);
  document.getElementById('saleDiscountTotal').textContent = formatMoney(discount);
  document.getElementById('saleTotal').textContent = formatMoney(total);
  document.getElementById('saleCash').value = total.toFixed(2);
  document.getElementById('saleCard').value = '0.00';
}

document.getElementById('addSaleItemBtn').addEventListener('click', addSaleItemRow);
document.getElementById('saleDiscount').addEventListener('input', updateSaleTotal);

// Keep cash + card in sync with the total: editing one adjusts the other.
document.getElementById('saleCash').addEventListener('input', () => {
  const total = Number(document.getElementById('saleTotal').textContent.replace(/\s/g, '').replace(',', '.')) || 0;
  const cash = Number(document.getElementById('saleCash').value) || 0;
  document.getElementById('saleCard').value = Math.max(0, total - cash).toFixed(2);
});
document.getElementById('saleCard').addEventListener('input', () => {
  const total = Number(document.getElementById('saleTotal').textContent.replace(/\s/g, '').replace(',', '.')) || 0;
  const card = Number(document.getElementById('saleCard').value) || 0;
  document.getElementById('saleCash').value = Math.max(0, total - card).toFixed(2);
});

document.getElementById('addSaleBtn').addEventListener('click', () => {
  document.querySelectorAll('#saleItemsBody .item-product-suggestions').forEach(el => el.remove());
  document.getElementById('saleItemsBody').innerHTML = '';
  document.getElementById('saleDiscount').value = 0;
  document.getElementById('saleComment').value = '';
  addSaleItemRow();
  updateSaleTotal();
  openModal('saleModal');
});

guardClick('saveSaleBtn', async () => {
  const rows = document.querySelectorAll('#saleItemsBody tr');
  const items = Array.from(rows).map(row => {
    const productId = row.querySelector('.item-product-id').value;
    const product = state.products.find(p => p.ID === productId);
    return {
      productId,
      name: product ? product.Name : '',
      qty: Number(row.querySelector('.item-qty').value),
      price: Number(row.querySelector('.item-price').value)
    };
  }).filter(i => i.productId && i.qty > 0);
  if (items.length === 0) { alert('Добавьте хотя бы одну позицию'); return; }
  const payload = {
    items,
    discount: Number(document.getElementById('saleDiscount').value) || 0,
    cashAmount: Number(document.getElementById('saleCash').value) || 0,
    cardAmount: Number(document.getElementById('saleCard').value) || 0,
    comment: document.getElementById('saleComment').value.trim()
  };
  await api('addSale', payload);
  closeModal('saleModal');
  await loadAll();
});

// ---- Payments (касса) ----
const paymentTypeLabels = { income: 'Приход', expense: 'Расход' };

function renderPayments() {
  const from = document.getElementById('paymentsFrom').value;
  const to = document.getElementById('paymentsTo').value;
  const fromDate = from ? new Date(from + 'T00:00:00') : null;
  const toDate = to ? new Date(to + 'T23:59:59') : null;
  const filtered = state.payments.filter(p => {
    const d = new Date(p.Date);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });
  const sorted = filtered.slice().reverse();
  const body = document.getElementById('paymentsBody');
  body.innerHTML = sorted.map(p => `
    <tr>
      <td>${formatDate(p.Date)}</td>
      <td><span class="pill ${p.Type === 'income' ? 'in' : 'out'}">${paymentTypeLabels[p.Type] || p.Type}</span></td>
      <td>${escapeHtml(p.Category)}</td>
      <td class="${p.Type === 'income' ? 'amt-in' : 'amt-out'}">${formatMoney(p.Amount)}</td>
      <td>${escapeHtml(p.Comment)}</td>
      <td class="actions">${p.RefId ? '' : `<button class="btn danger" data-delete-payment="${p.ID}">Удалить</button>`}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted);">Нет платежей за период</td></tr>';

  const totals = filtered.reduce((acc, p) => {
    if (p.Type === 'income') acc.income += Number(p.Amount) || 0;
    else acc.expense += Number(p.Amount) || 0;
    return acc;
  }, { income: 0, expense: 0 });
  document.getElementById('paymentsIncomeTotal').textContent = formatMoney(totals.income);
  document.getElementById('paymentsExpenseTotal').textContent = formatMoney(totals.expense);
  document.getElementById('paymentsNetTotal').textContent = formatMoney(totals.income - totals.expense);

  const categories = [...new Set(state.payments.map(p => p.Category).filter(Boolean))];
  document.getElementById('paymentCategoryList').innerHTML = categories.map(c => `<option value="${escapeHtml(c)}">`).join('');
}

document.getElementById('paymentsShowBtn').addEventListener('click', renderPayments);

document.getElementById('paymentsBody').addEventListener('click', async (e) => {
  const delId = e.target.dataset.deletePayment;
  if (delId) {
    if (!confirm('Удалить платёж?')) return;
    await api('deletePayment', { id: delId });
    await loadAll();
  }
});

function openPaymentModal(type) {
  document.getElementById('paymentModalTitle').textContent = type === 'income' ? 'Приход' : 'Расход';
  document.getElementById('paymentType').value = type;
  document.getElementById('paymentCategory').value = '';
  document.getElementById('paymentAmount').value = 0;
  document.getElementById('paymentComment').value = '';
  openModal('paymentModal');
}

document.getElementById('addIncomeBtn').addEventListener('click', () => openPaymentModal('income'));
document.getElementById('addExpenseBtn').addEventListener('click', () => openPaymentModal('expense'));

guardClick('savePaymentBtn', async () => {
  const payload = {
    type: document.getElementById('paymentType').value,
    category: document.getElementById('paymentCategory').value.trim(),
    amount: Number(document.getElementById('paymentAmount').value) || 0,
    comment: document.getElementById('paymentComment').value.trim()
  };
  if (!payload.category) { alert('Укажите статью'); return; }
  if (!payload.amount) { alert('Укажите сумму'); return; }
  await api('addPayment', payload);
  closeModal('paymentModal');
  await loadAll();
});

// ---- P&L (Прибыли и убытки) ----
async function showPnl() {
  const from = document.getElementById('pnlFrom').value;
  const to = document.getElementById('pnlTo').value;
  setStatus('Загрузка...');
  try {
    const data = await api('getPnl', {
      dateFrom: from ? new Date(from + 'T00:00:00').toISOString() : null,
      dateTo: to ? new Date(to + 'T23:59:59').toISOString() : new Date().toISOString()
    });
    renderPnl(data);
    setStatus('Обновлено: ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
  }
}

function renderPnl(data) {
  const expenseRows = data.expensesByCategory.map(e =>
    `<tr class="pnl-row-sub"><td>${escapeHtml(e.category)}</td><td>${formatMoney(e.amount)}</td></tr>`
  ).join('');
  const opProfitNegClass = data.operatingProfit < 0 ? ' pnl-row-neg' : '';
  const netProfitColor = data.netProfit < 0 ? ' style="color:#ff8a80;"' : '';
  document.getElementById('pnlTable').innerHTML = `
    <tr class="pnl-row-bold pnl-revenue"><td>Выручка (продажи)</td><td>${formatMoney(data.revenue)}</td></tr>
    <tr><td>Себестоимость проданного</td><td>${formatMoney(data.cogs)}</td></tr>
    <tr class="pnl-row-bold pnl-gross"><td>Валовая прибыль</td><td>${formatMoney(data.grossProfit)}</td></tr>
    <tr class="pnl-section-label"><td>Операционные расходы</td><td></td></tr>
    ${expenseRows}
    <tr class="pnl-row-bold pnl-operating"><td>Итого операционные расходы</td><td>${formatMoney(data.totalExpenses)}</td></tr>
    <tr class="pnl-row-bold pnl-operating${opProfitNegClass}"><td>Операционная прибыль</td><td>${formatMoney(data.operatingProfit)}</td></tr>
    <tr><td>Налоги и сборы</td><td>${formatMoney(data.taxes)}</td></tr>
    <tr class="pnl-row-bold pnl-net"><td>Чистая прибыль</td><td${netProfitColor}>${formatMoney(data.netProfit)}</td></tr>
  `;
}

document.getElementById('pnlShowBtn').addEventListener('click', showPnl);

// ---- Helpers ----
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function formatMoney(n) {
  return Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date)) return String(d);
  return date.toLocaleDateString('ru-RU') + ' ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

if (!CONFIG.API_URL || CONFIG.API_URL.startsWith('PASTE_')) {
  setStatus('Укажите API_URL в config.js (см. README.md)', true);
} else {
  loadAll().then(() => { showTurnover(); showPnl(); });
}
