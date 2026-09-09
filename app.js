const state = { products: [], contacts: [], orders: [] };

const statusEl = document.getElementById('status');

async function api(action, payload) {
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload: payload || {} })
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Unknown API error');
  return json.data;
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' error' : '');
}

async function loadAll() {
  setStatus('Загрузка...');
  try {
    const data = await api('getAll');
    state.products = data.products;
    state.contacts = data.contacts;
    state.orders = data.orders;
    renderProducts();
    renderContacts();
    renderOrders();
    setStatus('Обновлено: ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Ошибка: ' + err.message, true);
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

document.getElementById('saveProductBtn').addEventListener('click', async () => {
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

document.getElementById('saveContactBtn').addEventListener('click', async () => {
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

// ---- Orders ----
const orderTypeLabels = { sale: 'Продажа', purchase: 'Закупка' };

function renderOrders() {
  const body = document.getElementById('ordersBody');
  body.innerHTML = state.orders.slice().reverse().map(o => `
    <tr>
      <td>${formatDate(o.Date)}</td>
      <td>${escapeHtml(o.ContactName)}</td>
      <td>${orderTypeLabels[o.Type] || o.Type}</td>
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
  document.getElementById('orderItemsBody').innerHTML = '';
  document.getElementById('orderType').value = 'sale';
  updateOrderTotal();
  addOrderItemRow();
  openModal('orderModal');
});

function addOrderItemRow() {
  const row = document.createElement('tr');
  const options = state.products.map(p => `<option value="${p.ID}" data-price="${p.Price}">${escapeHtml(p.Name)}</option>`).join('');
  row.innerHTML = `
    <td><select class="item-product">${options}</select></td>
    <td><input type="number" class="item-qty" value="1" min="0.01" step="0.01"></td>
    <td><input type="number" class="item-price" value="0" min="0" step="0.01"></td>
    <td class="item-sum">0</td>
    <td class="actions"><button class="btn danger" data-remove-item>×</button></td>
  `;
  document.getElementById('orderItemsBody').appendChild(row);
  const productSelect = row.querySelector('.item-product');
  const priceInput = row.querySelector('.item-price');
  const setPriceFromProduct = () => {
    const opt = productSelect.options[productSelect.selectedIndex];
    priceInput.value = opt ? opt.dataset.price : 0;
    updateRowSum(row);
  };
  productSelect.addEventListener('change', setPriceFromProduct);
  row.querySelector('.item-qty').addEventListener('input', () => updateRowSum(row));
  priceInput.addEventListener('input', () => updateRowSum(row));
  row.querySelector('[data-remove-item]').addEventListener('click', () => { row.remove(); updateOrderTotal(); });
  setPriceFromProduct();
}

function updateRowSum(row) {
  const qty = Number(row.querySelector('.item-qty').value) || 0;
  const price = Number(row.querySelector('.item-price').value) || 0;
  row.querySelector('.item-sum').textContent = formatMoney(qty * price);
  updateOrderTotal();
}

function updateOrderTotal() {
  const rows = document.querySelectorAll('#orderItemsBody tr');
  let total = 0;
  rows.forEach(row => {
    const qty = Number(row.querySelector('.item-qty')?.value) || 0;
    const price = Number(row.querySelector('.item-price')?.value) || 0;
    total += qty * price;
  });
  document.getElementById('orderTotal').textContent = formatMoney(total);
}

document.getElementById('addOrderItemBtn').addEventListener('click', addOrderItemRow);

document.getElementById('saveOrderBtn').addEventListener('click', async () => {
  const rows = document.querySelectorAll('#orderItemsBody tr');
  const items = Array.from(rows).map(row => ({
    productId: row.querySelector('.item-product').value,
    qty: Number(row.querySelector('.item-qty').value),
    price: Number(row.querySelector('.item-price').value)
  })).filter(i => i.productId && i.qty > 0);
  if (items.length === 0) { alert('Добавьте хотя бы одну позицию'); return; }
  const payload = {
    contactId: document.getElementById('orderContact').value,
    type: document.getElementById('orderType').value,
    items
  };
  await api('addOrder', payload);
  closeModal('orderModal');
  await loadAll();
});

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
  loadAll();
}
