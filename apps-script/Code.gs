// Google Apps Script backend for MoySkladLite.
// Deploy: open your Google Sheet -> Extensions -> Apps Script -> paste this file -> Deploy as Web App (Execute as: Me, Who has access: Anyone).

var PRODUCTS_HEADERS = ['ID', 'Name', 'Group', 'Article', 'Code', 'Unit', 'MinPrice', 'CostPrice', 'Price', 'Quantity', 'Weight', 'Volume'];
var CONTACTS_HEADERS = ['ID', 'Name', 'Type', 'Phone', 'Email', 'Address'];
var ORDERS_HEADERS = ['ID', 'Date', 'ContactID', 'ContactName', 'Type', 'Status', 'ItemsJSON', 'Total'];
var MOVEMENTS_HEADERS = ['ID', 'Date', 'ProductId', 'ProductName', 'Delta', 'Type', 'RefId', 'RefLabel'];
var INVENTORIES_HEADERS = ['ID', 'Date', 'Comment', 'Status', 'ItemsJSON'];

function getSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function productsSheet() { return getSheet('Products', PRODUCTS_HEADERS); }
function contactsSheet() { return getSheet('Contacts', CONTACTS_HEADERS); }
function ordersSheet() { return getSheet('Orders', ORDERS_HEADERS); }
function movementsSheet() { return getSheet('Movements', MOVEMENTS_HEADERS); }
function inventoriesSheet() { return getSheet('Inventories', INVENTORIES_HEADERS); }

function sheetToObjects(sheet, headers) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var rows = data.slice(1);
  return rows.filter(function (r) { return r[0] !== '' && r[0] !== null; }).map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function findRowById(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) return i + 1;
  }
  return -1;
}

function setRowByHeaders(sheet, headers, rowIndex, obj) {
  var values = headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([values]);
}

function newId() { return Utilities.getUuid(); }

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return jsonResponse({ ok: true, message: 'MoySkladLite API is running' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var payload = body.payload || {};
    var result;
    switch (action) {
      case 'getAll': result = getAll(); break;
      case 'addProduct': result = addProduct(payload); break;
      case 'updateProduct': result = updateProduct(payload); break;
      case 'deleteProduct': result = deleteProduct(payload); break;
      case 'adjustStock': result = adjustStock(payload); break;
      case 'addContact': result = addContact(payload); break;
      case 'updateContact': result = updateContact(payload); break;
      case 'deleteContact': result = deleteContact(payload); break;
      case 'addOrder': result = addOrder(payload); break;
      case 'updateOrderStatus': result = updateOrderStatus(payload); break;
      case 'deleteOrder': result = deleteOrder(payload); break;
      case 'getTurnover': result = getTurnover(payload); break;
      case 'getStockAsOf': result = getStockAsOf(payload); break;
      case 'addInventory': result = addInventory(payload); break;
      case 'deleteInventory': result = deleteInventory(payload); break;
      default: throw new Error('Unknown action: ' + action);
    }
    return jsonResponse({ ok: true, data: result });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function getAll() {
  var products = sheetToObjects(productsSheet(), PRODUCTS_HEADERS);
  var contacts = sheetToObjects(contactsSheet(), CONTACTS_HEADERS);
  var orders = sheetToObjects(ordersSheet(), ORDERS_HEADERS).map(function (o) {
    o.Items = JSON.parse(o.ItemsJSON || '[]');
    return o;
  });
  var inventories = sheetToObjects(inventoriesSheet(), INVENTORIES_HEADERS).map(function (inv) {
    inv.Items = JSON.parse(inv.ItemsJSON || '[]');
    return inv;
  });
  return { products: products, contacts: contacts, orders: orders, inventories: inventories };
}

// ---- Products ----
function productFromPayload(p, id) {
  return {
    ID: id, Name: p.name, Group: p.group || '', Article: p.article || '', Code: p.code || '',
    Unit: p.unit || 'шт', MinPrice: Number(p.minPrice) || 0, CostPrice: Number(p.costPrice) || 0,
    Price: Number(p.price) || 0, Quantity: Number(p.quantity) || 0,
    Weight: Number(p.weight) || 0, Volume: Number(p.volume) || 0
  };
}

function addProduct(p) {
  var sheet = productsSheet();
  var obj = productFromPayload(p, newId());
  sheet.appendRow(PRODUCTS_HEADERS.map(function (h) { return obj[h]; }));
  if (obj.Quantity) logMovement(obj.ID, obj.Name, obj.Quantity, 'correction', '', 'Начальный остаток');
  return obj;
}

function updateProduct(p) {
  var sheet = productsSheet();
  var row = findRowById(sheet, p.id);
  if (row === -1) throw new Error('Товар не найден');
  var qtyCol = PRODUCTS_HEADERS.indexOf('Quantity') + 1;
  var oldQty = Number(sheet.getRange(row, qtyCol).getValue());
  var obj = productFromPayload(p, p.id);
  setRowByHeaders(sheet, PRODUCTS_HEADERS, row, obj);
  var diff = Number(obj.Quantity) - oldQty;
  if (diff) logMovement(p.id, obj.Name, diff, 'correction', '', 'Изменение в карточке товара');
  return obj;
}

function deleteProduct(p) {
  var sheet = productsSheet();
  var row = findRowById(sheet, p.id);
  if (row === -1) throw new Error('Товар не найден');
  sheet.deleteRow(row);
  return { id: p.id };
}

function adjustStock(p) {
  var sheet = productsSheet();
  var row = findRowById(sheet, p.productId);
  if (row === -1) throw new Error('Товар не найден');
  var colIdx = PRODUCTS_HEADERS.indexOf('Quantity') + 1;
  var cell = sheet.getRange(row, colIdx);
  var newQty = Number(cell.getValue()) + Number(p.delta);
  cell.setValue(newQty);
  var nameCol = PRODUCTS_HEADERS.indexOf('Name') + 1;
  logMovement(p.productId, sheet.getRange(row, nameCol).getValue(), Number(p.delta), 'adjustment', '', 'Ручная корректировка');
  return { productId: p.productId, quantity: newQty };
}

// ---- Contacts ----
function addContact(c) {
  var sheet = contactsSheet();
  var obj = { ID: newId(), Name: c.name, Type: c.type || 'client', Phone: c.phone || '', Email: c.email || '', Address: c.address || '' };
  sheet.appendRow(CONTACTS_HEADERS.map(function (h) { return obj[h]; }));
  return obj;
}

function updateContact(c) {
  var sheet = contactsSheet();
  var row = findRowById(sheet, c.id);
  if (row === -1) throw new Error('Контрагент не найден');
  var obj = { ID: c.id, Name: c.name, Type: c.type || 'client', Phone: c.phone || '', Email: c.email || '', Address: c.address || '' };
  setRowByHeaders(sheet, CONTACTS_HEADERS, row, obj);
  return obj;
}

function deleteContact(c) {
  var sheet = contactsSheet();
  var row = findRowById(sheet, c.id);
  if (row === -1) throw new Error('Контрагент не найден');
  sheet.deleteRow(row);
  return { id: c.id };
}

// ---- Movements (stock history, used by Обороты and Остатки on-date) ----
function logMovement(productId, productName, delta, type, refId, refLabel) {
  if (!delta) return;
  var sheet = movementsSheet();
  sheet.appendRow([newId(), new Date(), productId, productName, delta, type, refId || '', refLabel || '']);
}

function movementsByProduct() {
  var movements = sheetToObjects(movementsSheet(), MOVEMENTS_HEADERS);
  var byProduct = {};
  movements.forEach(function (m) {
    (byProduct[m.ProductId] = byProduct[m.ProductId] || []).push(m);
  });
  return byProduct;
}

// Reconstructs each product's quantity at an exact moment in time by rolling back
// every movement that happened after that moment.
function getStockAsOf(payload) {
  var asOf = payload.asOf ? new Date(payload.asOf) : new Date();
  var products = sheetToObjects(productsSheet(), PRODUCTS_HEADERS);
  var byProduct = movementsByProduct();
  return products.map(function (p) {
    var ms = byProduct[p.ID] || [];
    var futureSum = 0;
    ms.forEach(function (m) {
      if (new Date(m.Date) > asOf) futureSum += Number(m.Delta);
    });
    var copy = {};
    PRODUCTS_HEADERS.forEach(function (h) { copy[h] = p[h]; });
    copy.Quantity = Number(p.Quantity) - futureSum;
    return copy;
  });
}

function getTurnover(payload) {
  var dateFrom = payload.dateFrom ? new Date(payload.dateFrom) : null;
  var dateTo = payload.dateTo ? new Date(payload.dateTo) : new Date();
  var includeNoMovement = !!payload.includeNoMovement;
  var productIds = payload.productIds || [];
  var groups = payload.groups || [];

  var products = sheetToObjects(productsSheet(), PRODUCTS_HEADERS);
  var scopedProducts = products;
  if (productIds.length || groups.length) {
    var idSet = {};
    productIds.forEach(function (id) { idSet[id] = true; });
    products.forEach(function (p) { if (groups.indexOf(p.Group) !== -1) idSet[p.ID] = true; });
    scopedProducts = products.filter(function (p) { return idSet[p.ID]; });
  }

  var byProduct = movementsByProduct();
  var rows = [];
  scopedProducts.forEach(function (p) {
    var ms = byProduct[p.ID] || [];
    var futureSum = 0, inQty = 0, outQty = 0;
    ms.forEach(function (m) {
      var d = new Date(m.Date);
      var delta = Number(m.Delta);
      if (d > dateTo) { futureSum += delta; return; }
      if (dateFrom && d < dateFrom) return;
      if (delta > 0) inQty += delta; else outQty += -delta;
    });
    if (!includeNoMovement && inQty === 0 && outQty === 0) return;
    var endQty = Number(p.Quantity) - futureSum;
    var startQty = endQty - inQty + outQty;
    var cost = Number(p.CostPrice) || 0;
    rows.push({
      ID: p.ID, Name: p.Name, Code: p.Code, Unit: p.Unit, Group: p.Group,
      StartQty: startQty, StartSum: startQty * cost,
      InQty: inQty, InSum: inQty * cost,
      OutQty: outQty, OutSum: outQty * cost,
      EndQty: endQty, EndSum: endQty * cost
    });
  });
  return rows;
}

// ---- Inventory counts ----
function addInventory(payload) {
  var items = (payload.items || []).map(function (it) {
    var systemQty = Number(it.systemQty) || 0;
    var actualQty = Number(it.actualQty) || 0;
    return {
      productId: it.productId, name: it.name, code: it.code, unit: it.unit,
      systemQty: systemQty, actualQty: actualQty, diff: actualQty - systemQty
    };
  });
  var obj = {
    ID: newId(), Date: new Date(), Comment: payload.comment || '',
    Status: payload.status === 'done' ? 'done' : 'draft', ItemsJSON: JSON.stringify(items)
  };
  var sheet = inventoriesSheet();
  sheet.appendRow(INVENTORIES_HEADERS.map(function (h) { return obj[h]; }));
  if (obj.Status === 'done') applyInventoryDiffs(items, obj.ID);
  obj.Items = items;
  return obj;
}

function applyInventoryDiffs(items, inventoryId) {
  var sheet = productsSheet();
  var qtyCol = PRODUCTS_HEADERS.indexOf('Quantity') + 1;
  items.forEach(function (it) {
    if (!it.diff) return;
    var row = findRowById(sheet, it.productId);
    if (row === -1) return;
    var cell = sheet.getRange(row, qtyCol);
    cell.setValue(Number(cell.getValue()) + it.diff);
    logMovement(it.productId, it.name, it.diff, 'inventory', inventoryId, 'Инвентаризация');
  });
}

function deleteInventory(payload) {
  var sheet = inventoriesSheet();
  var row = findRowById(sheet, payload.id);
  if (row === -1) throw new Error('Инвентаризация не найдена');
  var data = sheet.getRange(row, 1, 1, INVENTORIES_HEADERS.length).getValues()[0];
  var status = data[INVENTORIES_HEADERS.indexOf('Status')];
  var items = JSON.parse(data[INVENTORIES_HEADERS.indexOf('ItemsJSON')] || '[]');
  if (status === 'done') {
    var reversed = items.map(function (it) { return { productId: it.productId, name: it.name, diff: -it.diff }; });
    applyInventoryDiffs(reversed, payload.id);
  }
  sheet.deleteRow(row);
  return { id: payload.id };
}

// ---- Orders ----
function applyStockDelta(items, sign, type, refId, refLabel) {
  var sheet = productsSheet();
  var qtyCol = PRODUCTS_HEADERS.indexOf('Quantity') + 1;
  var nameCol = PRODUCTS_HEADERS.indexOf('Name') + 1;
  items.forEach(function (item) {
    var row = findRowById(sheet, item.productId);
    if (row === -1) return;
    var qtyCell = sheet.getRange(row, qtyCol);
    var delta = (type === 'purchase' ? 1 : -1) * sign * Number(item.qty);
    qtyCell.setValue(Number(qtyCell.getValue()) + delta);
    var productName = sheet.getRange(row, nameCol).getValue();
    logMovement(item.productId, productName, delta, type === 'purchase' ? 'purchase' : 'sale', refId, refLabel);
  });
}

function addOrder(o) {
  var sheet = ordersSheet();
  var contact = null;
  if (o.contactId) {
    var contacts = sheetToObjects(contactsSheet(), CONTACTS_HEADERS);
    contact = contacts.filter(function (c) { return String(c.ID) === String(o.contactId); })[0];
  }
  var items = o.items || [];
  var total = items.reduce(function (sum, i) { return sum + Number(i.qty) * Number(i.price); }, 0);
  var obj = {
    ID: newId(), Date: new Date(), ContactID: o.contactId || '', ContactName: contact ? contact.Name : '',
    Type: o.type || 'sale', Status: o.status || 'completed', ItemsJSON: JSON.stringify(items), Total: total
  };
  sheet.appendRow(ORDERS_HEADERS.map(function (h) { return obj[h]; }));
  var refLabel = (obj.Type === 'purchase' ? 'Закупка' : 'Продажа') + (contact ? ' — ' + contact.Name : '');
  applyStockDelta(items, 1, obj.Type, obj.ID, refLabel);
  obj.Items = items;
  return obj;
}

function updateOrderStatus(o) {
  var sheet = ordersSheet();
  var row = findRowById(sheet, o.orderId);
  if (row === -1) throw new Error('Заказ не найден');
  var colIdx = ORDERS_HEADERS.indexOf('Status') + 1;
  sheet.getRange(row, colIdx).setValue(o.status);
  return { orderId: o.orderId, status: o.status };
}

function deleteOrder(o) {
  var sheet = ordersSheet();
  var row = findRowById(sheet, o.orderId);
  if (row === -1) throw new Error('Заказ не найден');
  var data = sheet.getRange(row, 1, 1, ORDERS_HEADERS.length).getValues()[0];
  var itemsJSON = data[ORDERS_HEADERS.indexOf('ItemsJSON')];
  var type = data[ORDERS_HEADERS.indexOf('Type')];
  var items = JSON.parse(itemsJSON || '[]');
  applyStockDelta(items, -1, type, o.orderId, 'Удаление заказа');
  sheet.deleteRow(row);
  return { id: o.orderId };
}

// ---- One-off legacy import from "Лист2" (МойСклад stock export) ----
function importLegacyStock() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName('Лист2');
  var data = src.getDataRange().getValues();
  var sheet = productsSheet();

  sheet.clear();
  sheet.appendRow(PRODUCTS_HEADERS);
  sheet.setFrozenRows(1);

  var currentCategory = '';
  var rows = [];
  for (var i = 2; i < data.length; i++) {
    var row = data[i];
    var stock = row[7];
    if (stock === '' || stock === null) {
      var cat = [row[0], row[1], row[2], row[3]].filter(function (v) { return v !== '' && v !== null; }).join('').trim();
      if (cat) currentCategory = cat;
      continue;
    }
    var name = String(row[2] || '').trim();
    if (!name) continue;
    var code = String(row[0] || '').trim();
    var article = String(row[1] || '').trim();
    var unit = String(row[3] || '').trim();
    var costPrice = row[8];
    var salePrice = row[10];
    rows.push([
      Utilities.getUuid(),
      name,
      currentCategory,
      article,
      code,
      unit || 'шт',
      0,
      Number(costPrice) || 0,
      Number(salePrice) || 0,
      Number(stock) || 0,
      0,
      0
    ]);
  }
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, PRODUCTS_HEADERS.length).setValues(rows);
  }
  Logger.log('IMPORTED: ' + rows.length);
  return rows.length;
}
