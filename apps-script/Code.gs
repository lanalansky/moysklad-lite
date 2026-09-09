// Google Apps Script backend for MoySkladLite.
// Deploy: open your Google Sheet -> Extensions -> Apps Script -> paste this file -> Deploy as Web App (Execute as: Me, Who has access: Anyone).

var PRODUCTS_HEADERS = ['ID', 'Name', 'SKU', 'Unit', 'Price', 'Quantity', 'Category'];
var CONTACTS_HEADERS = ['ID', 'Name', 'Type', 'Phone', 'Email', 'Address'];
var ORDERS_HEADERS = ['ID', 'Date', 'ContactID', 'ContactName', 'Type', 'Status', 'ItemsJSON', 'Total'];

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
  return { products: products, contacts: contacts, orders: orders };
}

// ---- Products ----
function addProduct(p) {
  var sheet = productsSheet();
  var obj = {
    ID: newId(), Name: p.name, SKU: p.sku || '', Unit: p.unit || 'шт',
    Price: Number(p.price) || 0, Quantity: Number(p.quantity) || 0, Category: p.category || ''
  };
  sheet.appendRow(PRODUCTS_HEADERS.map(function (h) { return obj[h]; }));
  return obj;
}

function updateProduct(p) {
  var sheet = productsSheet();
  var row = findRowById(sheet, p.id);
  if (row === -1) throw new Error('Товар не найден');
  var obj = {
    ID: p.id, Name: p.name, SKU: p.sku || '', Unit: p.unit || 'шт',
    Price: Number(p.price) || 0, Quantity: Number(p.quantity) || 0, Category: p.category || ''
  };
  setRowByHeaders(sheet, PRODUCTS_HEADERS, row, obj);
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

// ---- Orders ----
function applyStockDelta(items, sign, type) {
  var sheet = productsSheet();
  items.forEach(function (item) {
    var row = findRowById(sheet, item.productId);
    if (row === -1) return;
    var colIdx = PRODUCTS_HEADERS.indexOf('Quantity') + 1;
    var cell = sheet.getRange(row, colIdx);
    var delta = (type === 'purchase' ? 1 : -1) * sign * Number(item.qty);
    cell.setValue(Number(cell.getValue()) + delta);
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
  applyStockDelta(items, 1, obj.Type);
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
  applyStockDelta(items, -1, type);
  sheet.deleteRow(row);
  return { id: o.orderId };
}
