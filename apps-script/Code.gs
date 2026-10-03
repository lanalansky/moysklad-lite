// Google Apps Script backend for MoySkladLite.
// Deploy: open your Google Sheet -> Extensions -> Apps Script -> paste this file -> Deploy as Web App (Execute as: Me, Who has access: Anyone).

var PRODUCTS_HEADERS = ['ID', 'Name', 'Group', 'Article', 'Code', 'Unit', 'MinPrice', 'CostPrice', 'Price', 'Quantity', 'Weight', 'Volume'];
var CONTACTS_HEADERS = ['ID', 'Name', 'Type', 'Phone', 'Email', 'Address'];
var ORDERS_HEADERS = ['ID', 'Date', 'ContactID', 'ContactName', 'Type', 'Status', 'ItemsJSON', 'Delivery', 'Total'];
var MOVEMENTS_HEADERS = ['ID', 'Date', 'ProductId', 'ProductName', 'Delta', 'Type', 'RefId', 'RefLabel'];
var INVENTORIES_HEADERS = ['ID', 'Date', 'Comment', 'Status', 'ItemsJSON'];
var SALES_HEADERS = ['ID', 'Date', 'ItemsJSON', 'CashAmount', 'CardAmount', 'Discount', 'Total', 'Comment', 'Provider'];
var PAYMENTS_HEADERS = ['ID', 'Date', 'Type', 'Category', 'Amount', 'Comment', 'RefId', 'RefLabel'];
var HELD_HEADERS = ['ID', 'Date', 'ItemsJSON', 'Discount'];
var SERVICES_HEADERS = ['ID', 'Name', 'Code', 'Unit', 'Price'];
var REPACK_RECIPES_HEADERS = ['ID', 'BoxProductId', 'PieceProductId', 'PackSize'];

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
function archivedProductsSheet() { return getSheet('ArchivedProducts', PRODUCTS_HEADERS); }
function contactsSheet() { return getSheet('Contacts', CONTACTS_HEADERS); }
function ordersSheet() { return getSheet('Orders', ORDERS_HEADERS); }
function movementsSheet() { return getSheet('Movements', MOVEMENTS_HEADERS); }
function inventoriesSheet() { return getSheet('Inventories', INVENTORIES_HEADERS); }
function salesSheet() {
  var sheet = getSheet('Sales', SALES_HEADERS);
  // Migration: sheets created before the Provider column existed only have 8
  // columns. Add the 9th header in place rather than rewriting SALES_HEADERS
  // positions, so old rows stay aligned with their existing columns.
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (headerRow.indexOf('Provider') === -1) {
    sheet.getRange(1, headerRow.length + 1).setValue('Provider');
  }
  return sheet;
}
function paymentsSheet() { return getSheet('Payments', PAYMENTS_HEADERS); }
function heldSheet() { return getSheet('Held', HELD_HEADERS); }
function servicesSheet() { return getSheet('Services', SERVICES_HEADERS); }
function repackRecipesSheet() { return getSheet('RepackRecipes', REPACK_RECIPES_HEADERS); }

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

// ---- Idempotency (retried writes must not create a second record) ----
// The client generates one key per logical call (addSale, addOrder, etc.) and
// resends the same key on every retry of that call. doPost() checks the key
// before dispatching to the handler and replays the first call's stored
// result instead of re-running it, so a dropped response that the client
// treats as a failure can't turn into a duplicate sale/order/payment/etc.
// This lives in doPost rather than in each handler because doPost already
// holds the script-wide lock for the whole request, so there's no race
// between a check and a write even if two retries land back to back.
var IDEMPOTENCY_HEADERS = ['Key', 'Date', 'ResultJSON'];
function idempotencyKeysSheet() { return getSheet('IdempotencyKeys', IDEMPOTENCY_HEADERS); }

// Returns undefined when this key hasn't been seen before.
function findIdempotentResult(key) {
  var sheet = idempotencyKeysSheet();
  var row = findRowById(sheet, key);
  if (row === -1) return undefined;
  var json = sheet.getRange(row, IDEMPOTENCY_HEADERS.indexOf('ResultJSON') + 1).getValue();
  return JSON.parse(json);
}

function saveIdempotentResult(key, result) {
  var sheet = idempotencyKeysSheet();
  sheet.appendRow([key, new Date(), JSON.stringify(result === undefined ? null : result)]);
  pruneOldIdempotencyKeys(sheet);
}

// A day is far longer than any realistic retry window, so this can't prune a
// key before a legitimate retry would use it, while keeping the log from
// growing forever.
function pruneOldIdempotencyKeys(sheet) {
  var cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] !== '' && new Date(data[i][1]) < cutoff) sheet.deleteRow(i + 1);
  }
}

function doGet(e) {
  return jsonResponse({ ok: true, message: 'MoySkladLite API is running' });
}

// Actions that only read sheets (never append/setValue/deleteRow) don't need
// the script lock: they don't need mutual exclusion with each other, and this
// app tolerates a transient, momentarily-stale read. Keeping them off the
// lock stops a burst of getAll polling from queuing up behind every write
// (and behind every other getAll), which is what caused the 20-60s latency.
var READ_ONLY_ACTIONS = { getAll: 1, getTurnover: 1, getStockAsOf: 1, getPnl: 1, getMovementsLog: 1 };

function dispatchAction(action, payload) {
  switch (action) {
    case 'getAll': return getAll();
    case 'addProduct': return addProduct(payload);
    case 'updateProduct': return updateProduct(payload);
    case 'deleteProduct': return deleteProduct(payload);
    case 'archiveProducts': return archiveProducts(payload);
    case 'adjustStock': return adjustStock(payload);
    case 'addContact': return addContact(payload);
    case 'updateContact': return updateContact(payload);
    case 'deleteContact': return deleteContact(payload);
    case 'addOrder': return addOrder(payload);
    case 'updateOrderStatus': return updateOrderStatus(payload);
    case 'completeOrder': return completeOrder(payload);
    case 'deleteOrder': return deleteOrder(payload);
    case 'getTurnover': return getTurnover(payload);
    case 'getMovementsLog': return getMovementsLog(payload);
    case 'getStockAsOf': return getStockAsOf(payload);
    case 'addInventory': return addInventory(payload);
    case 'deleteInventory': return deleteInventory(payload);
    case 'addSale': return addSale(payload);
    case 'editSale': return editSale(payload);
    case 'deleteSale': return deleteSale(payload);
    case 'addPayment': return addPayment(payload);
    case 'deletePayment': return deletePayment(payload);
    case 'addHeld': return addHeld(payload);
    case 'updateHeld': return updateHeld(payload);
    case 'deleteHeld': return deleteHeld(payload);
    case 'addService': return addService(payload);
    case 'updateService': return updateService(payload);
    case 'deleteService': return deleteService(payload);
    case 'addRepackRecipe': return addRepackRecipe(payload);
    case 'deleteRepackRecipe': return deleteRepackRecipe(payload);
    case 'repackExecute': return repackExecute(payload);
    case 'getPnl': return getPnl(payload);
    default: throw new Error('Unknown action: ' + action);
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var payload = body.payload || {};

    if (READ_ONLY_ACTIONS[action]) {
      return jsonResponse({ ok: true, data: dispatchAction(action, payload) });
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
      var idemKey = payload._idempotencyKey;
      if (idemKey) {
        var cached = findIdempotentResult(idemKey);
        if (cached !== undefined) return jsonResponse({ ok: true, data: cached });
      }
      var result = dispatchAction(action, payload);
      if (idemKey) saveIdempotentResult(idemKey, result);
      return jsonResponse({ ok: true, data: result });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
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
  var sales = sheetToObjects(salesSheet(), SALES_HEADERS).map(function (s) {
    s.Items = JSON.parse(s.ItemsJSON || '[]');
    return s;
  });
  var payments = sheetToObjects(paymentsSheet(), PAYMENTS_HEADERS);
  var held = sheetToObjects(heldSheet(), HELD_HEADERS).map(function (h) {
    h.Items = JSON.parse(h.ItemsJSON || '[]');
    return h;
  });
  var services = sheetToObjects(servicesSheet(), SERVICES_HEADERS);
  var repackRecipes = sheetToObjects(repackRecipesSheet(), REPACK_RECIPES_HEADERS);
  var repackHistory = getRepackHistory();
  return { products: products, contacts: contacts, orders: orders, inventories: inventories, sales: sales, payments: payments, held: held, services: services, repackRecipes: repackRecipes, repackHistory: repackHistory };
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

function archiveProducts(p) {
  var ids = p.ids || [];
  var sheet = productsSheet();
  var archive = archivedProductsSheet();
  var archived = [];
  ids.forEach(function (id) {
    var row = findRowById(sheet, id);
    if (row === -1) return;
    var values = sheet.getRange(row, 1, 1, PRODUCTS_HEADERS.length).getValues()[0];
    archive.appendRow(values);
    sheet.deleteRow(row);
    archived.push(id);
  });
  return { archived: archived };
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

// ---- Services (аренда, штрафы и пр. — продаются как товар, но без остатка на складе) ----
function addService(s) {
  var sheet = servicesSheet();
  var obj = { ID: newId(), Name: s.name, Code: s.code || '', Unit: s.unit || 'шт', Price: Number(s.price) || 0 };
  sheet.appendRow(SERVICES_HEADERS.map(function (h) { return obj[h]; }));
  return obj;
}

function updateService(s) {
  var sheet = servicesSheet();
  var row = findRowById(sheet, s.id);
  if (row === -1) throw new Error('Услуга не найдена');
  var obj = { ID: s.id, Name: s.name, Code: s.code || '', Unit: s.unit || 'шт', Price: Number(s.price) || 0 };
  setRowByHeaders(sheet, SERVICES_HEADERS, row, obj);
  return obj;
}

function deleteService(s) {
  var sheet = servicesSheet();
  var row = findRowById(sheet, s.id);
  if (row === -1) throw new Error('Услуга не найдена');
  sheet.deleteRow(row);
  return { id: s.id };
}

// ---- Repack recipes (break a box of N pieces into individually-sold units,
// e.g. a 20-pack of cartridges -> single поштучно cartridges of the same kind) ----
// A slow response over a bad connection can make the client's own retry
// logic re-send this same request, which would otherwise create duplicate
// cards for the same box/piece pair - so treat it as idempotent and just
// hand back the existing recipe instead of inserting a second row.
function addRepackRecipe(p) {
  var sheet = repackRecipesSheet();
  var existing = sheetToObjects(sheet, REPACK_RECIPES_HEADERS).filter(function (r) {
    return r.BoxProductId === p.boxProductId && r.PieceProductId === p.pieceProductId;
  })[0];
  if (existing) return existing;
  var obj = { ID: newId(), BoxProductId: p.boxProductId, PieceProductId: p.pieceProductId, PackSize: Number(p.packSize) || 1 };
  sheet.appendRow(REPACK_RECIPES_HEADERS.map(function (h) { return obj[h]; }));
  return obj;
}

function deleteRepackRecipe(p) {
  var sheet = repackRecipesSheet();
  var row = findRowById(sheet, p.id);
  if (row === -1) throw new Error('Пара пересорта не найдена');
  sheet.deleteRow(row);
  return { id: p.id };
}

// Converts boxCount boxes into pieces: decreases the box's stock, increases the
// piece's stock by boxCount*PackSize, and gives those new pieces the box's own
// already-landed CostPrice (which includes delivery) spread over PackSize,
// blended into the piece's existing stock the same weighted-average way a
// purchase order blends cost in applyStockDelta.
function repackExecute(p) {
  var recipeSheet = repackRecipesSheet();
  var recipeRow = findRowById(recipeSheet, p.recipeId);
  if (recipeRow === -1) throw new Error('Пара пересорта не найдена');
  var recipeData = recipeSheet.getRange(recipeRow, 1, 1, REPACK_RECIPES_HEADERS.length).getValues()[0];
  var recipe = {};
  REPACK_RECIPES_HEADERS.forEach(function (h, i) { recipe[h] = recipeData[i]; });

  var boxCount = Number(p.boxCount) || 0;
  if (boxCount <= 0) throw new Error('Укажите количество коробов');
  var packSize = Number(recipe.PackSize) || 1;

  var productsSht = productsSheet();
  var qtyCol = PRODUCTS_HEADERS.indexOf('Quantity') + 1;
  var costCol = PRODUCTS_HEADERS.indexOf('CostPrice') + 1;
  var nameCol = PRODUCTS_HEADERS.indexOf('Name') + 1;

  var boxRow = findRowById(productsSht, recipe.BoxProductId);
  if (boxRow === -1) throw new Error('Товар-короб не найден');
  var pieceRow = findRowById(productsSht, recipe.PieceProductId);
  if (pieceRow === -1) throw new Error('Поштучный товар не найден');

  var boxQty = Number(productsSht.getRange(boxRow, qtyCol).getValue());
  if (boxQty < boxCount) throw new Error('На складе недостаточно коробов (доступно: ' + boxQty + ')');
  var boxCost = Number(productsSht.getRange(boxRow, costCol).getValue()) || 0;
  var boxName = productsSht.getRange(boxRow, nameCol).getValue();

  var pieceQty = Number(productsSht.getRange(pieceRow, qtyCol).getValue());
  var pieceCost = Number(productsSht.getRange(pieceRow, costCol).getValue()) || 0;
  var pieceName = productsSht.getRange(pieceRow, nameCol).getValue();

  var gainedQty = boxCount * packSize;
  var costPerPiece = boxCost / packSize;
  var newPieceQtyTotal = pieceQty + gainedQty;
  var newPieceCost = newPieceQtyTotal > 0
    ? ((pieceQty * pieceCost) + (gainedQty * costPerPiece)) / newPieceQtyTotal
    : costPerPiece;

  productsSht.getRange(boxRow, qtyCol).setValue(boxQty - boxCount);
  productsSht.getRange(pieceRow, qtyCol).setValue(newPieceQtyTotal);
  productsSht.getRange(pieceRow, costCol).setValue(newPieceCost);

  logMovement(recipe.BoxProductId, boxName, -boxCount, 'repack', recipe.ID, 'Пересорт → ' + pieceName);
  logMovement(recipe.PieceProductId, pieceName, gainedQty, 'repack', recipe.ID, 'Пересорт ← ' + boxName);

  return {
    box: { id: recipe.BoxProductId, quantity: boxQty - boxCount },
    piece: { id: recipe.PieceProductId, quantity: newPieceQtyTotal, costPrice: newPieceCost }
  };
}

// ---- Movements (stock history, used by Обороты and Остатки on-date) ----
function logMovement(productId, productName, delta, type, refId, refLabel, date) {
  if (!delta) return;
  var sheet = movementsSheet();
  sheet.appendRow([newId(), date || new Date(), productId, productName, delta, type, refId || '', refLabel || '']);
}

function movementsByProduct() {
  var movements = sheetToObjects(movementsSheet(), MOVEMENTS_HEADERS);
  var byProduct = {};
  movements.forEach(function (m) {
    (byProduct[m.ProductId] = byProduct[m.ProductId] || []).push(m);
  });
  return byProduct;
}

// Full audit trail of every stock-affecting action (sale, purchase, repack,
// inventory count, manual correction/adjustment) - a human-readable version
// of the Movements sheet, scoped to a date range so it isn't pulled in full
// on every getAll(). Not bundled into getAll because it can grow large and
// most screens never need it.
function getMovementsLog(payload) {
  var dateFrom = payload.dateFrom ? new Date(payload.dateFrom) : null;
  var dateTo = payload.dateTo ? new Date(payload.dateTo) : new Date();
  var movements = sheetToObjects(movementsSheet(), MOVEMENTS_HEADERS).filter(function (m) {
    var d = new Date(m.Date);
    if (dateFrom && d < dateFrom) return false;
    if (d > dateTo) return false;
    return true;
  });
  movements.reverse();
  return movements;
}

// repackExecute() always logs exactly two 'repack' movements back to back
// (box out, then piece in) inside the same locked request, so consecutive
// pairs in sheet order are always one execution - no need to match them up
// by RefId (which is only the recipe's own id, shared by every run of it).
function getRepackHistory() {
  var movements = sheetToObjects(movementsSheet(), MOVEMENTS_HEADERS)
    .filter(function (m) { return m.Type === 'repack'; });
  var history = [];
  for (var i = 0; i + 1 < movements.length; i += 2) {
    var a = movements[i], b = movements[i + 1];
    var boxM = a.Delta < 0 ? a : b;
    var pieceM = a.Delta < 0 ? b : a;
    history.push({
      Date: boxM.Date, RecipeId: boxM.RefId,
      BoxProductId: boxM.ProductId, BoxProductName: boxM.ProductName, BoxDelta: boxM.Delta,
      PieceProductId: pieceM.ProductId, PieceProductName: pieceM.ProductName, PieceDelta: pieceM.Delta
    });
  }
  history.reverse();
  return history;
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
function applyStockDelta(items, sign, type, refId, refLabel, date) {
  var sheet = productsSheet();
  var qtyCol = PRODUCTS_HEADERS.indexOf('Quantity') + 1;
  var nameCol = PRODUCTS_HEADERS.indexOf('Name') + 1;
  var costCol = PRODUCTS_HEADERS.indexOf('CostPrice') + 1;
  items.forEach(function (item) {
    var row = findRowById(sheet, item.productId);
    if (row === -1) return;
    var qtyCell = sheet.getRange(row, qtyCol);
    var oldQty = Number(qtyCell.getValue());
    var delta = (type === 'purchase' ? 1 : -1) * sign * Number(item.qty);
    if (type === 'purchase' && sign === 1) {
      var costCell = sheet.getRange(row, costCol);
      var oldCost = Number(costCell.getValue());
      var purchaseQty = Number(item.qty);
      var purchasePrice = Number(item.landedPrice !== undefined ? item.landedPrice : item.price);
      var newQtyTotal = oldQty + purchaseQty;
      var newCost = newQtyTotal > 0 ? ((oldQty * oldCost) + (purchaseQty * purchasePrice)) / newQtyTotal : purchasePrice;
      costCell.setValue(newCost);
    }
    qtyCell.setValue(oldQty + delta);
    var productName = sheet.getRange(row, nameCol).getValue();
    logMovement(item.productId, productName, delta, type === 'purchase' ? 'purchase' : 'sale', refId, refLabel, date);
  });
}

// Distributes the order's total delivery cost across items proportionally to
// each line's share of the goods subtotal, so landed cost reflects true cost per unit.
function computeLandedItems(items, delivery) {
  var subtotal = items.reduce(function (sum, i) { return sum + Number(i.qty) * Number(i.price); }, 0);
  var deliveryTotal = Number(delivery) || 0;
  return items.map(function (i) {
    var qty = Number(i.qty), price = Number(i.price);
    var lineSum = qty * price;
    var share = subtotal > 0 ? (lineSum / subtotal) * deliveryTotal : (items.length ? deliveryTotal / items.length : 0);
    var landed = qty > 0 ? price + (share / qty) : price;
    return { productId: i.productId, qty: qty, price: price, landedPrice: landed };
  });
}

// A purchase order is logged as a 'draft' first (so placing the order with a
// supplier doesn't also silently change stock) and only moves inventory once
// completeOrder() marks it 'completed' - mirroring order vs. receiving in
// real МойСклад.
function addOrder(o) {
  var sheet = ordersSheet();
  var contact = null;
  if (o.contactId) {
    var contacts = sheetToObjects(contactsSheet(), CONTACTS_HEADERS);
    contact = contacts.filter(function (c) { return String(c.ID) === String(o.contactId); })[0];
  }
  var delivery = Number(o.delivery) || 0;
  var subtotal = (o.items || []).reduce(function (sum, i) { return sum + Number(i.qty) * Number(i.price); }, 0);
  var items = computeLandedItems(o.items || [], delivery);
  var docDate = o.date ? new Date(o.date) : new Date();
  var obj = {
    ID: newId(), Date: docDate, ContactID: o.contactId || '', ContactName: contact ? contact.Name : '',
    Type: o.type || 'purchase', Status: o.status || 'draft', ItemsJSON: JSON.stringify(items),
    Delivery: delivery, Total: subtotal + delivery
  };
  sheet.appendRow(ORDERS_HEADERS.map(function (h) { return obj[h]; }));
  if (obj.Status === 'completed') {
    var refLabel = (obj.Type === 'purchase' ? 'Закупка' : 'Продажа') + (contact ? ' — ' + contact.Name : '');
    applyStockDelta(items, 1, obj.Type, obj.ID, refLabel, docDate);
  }
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

// Marks a draft order as received: applies its stock/cost delta exactly once,
// then flips Status to 'completed'. Re-completing an already-completed order
// is a no-op so a retried request can't double-count stock.
function completeOrder(o) {
  var sheet = ordersSheet();
  var row = findRowById(sheet, o.orderId);
  if (row === -1) throw new Error('Заказ не найден');
  var data = sheet.getRange(row, 1, 1, ORDERS_HEADERS.length).getValues()[0];
  var order = {};
  ORDERS_HEADERS.forEach(function (h, i) { order[h] = data[i]; });
  if (order.Status === 'completed') return order;

  var items = JSON.parse(order.ItemsJSON || '[]');
  var refLabel = (order.Type === 'purchase' ? 'Закупка' : 'Продажа') + (order.ContactName ? ' — ' + order.ContactName : '');
  applyStockDelta(items, 1, order.Type, order.ID, refLabel);

  var statusCol = ORDERS_HEADERS.indexOf('Status') + 1;
  sheet.getRange(row, statusCol).setValue('completed');
  order.Status = 'completed';
  order.Items = items;
  return order;
}

function deleteOrder(o) {
  var sheet = ordersSheet();
  var row = findRowById(sheet, o.orderId);
  if (row === -1) throw new Error('Заказ не найден');
  var data = sheet.getRange(row, 1, 1, ORDERS_HEADERS.length).getValues()[0];
  var itemsJSON = data[ORDERS_HEADERS.indexOf('ItemsJSON')];
  var type = data[ORDERS_HEADERS.indexOf('Type')];
  var status = data[ORDERS_HEADERS.indexOf('Status')];
  var items = JSON.parse(itemsJSON || '[]');
  // A draft never touched stock, so deleting it shouldn't reverse anything.
  if (status === 'completed') {
    applyStockDelta(items, -1, type, o.orderId, 'Удаление заказа');
  }
  sheet.deleteRow(row);
  return { id: o.orderId };
}

// ---- Sales (розничные продажи) ----
function addSale(o) {
  var items = (o.items || []).map(function (i) {
    return { productId: i.productId, name: i.name, qty: Number(i.qty), price: Number(i.price) };
  });
  var subtotal = items.reduce(function (sum, i) { return sum + i.qty * i.price; }, 0);
  var discount = Number(o.discount) || 0;
  var cashAmount = Number(o.cashAmount) || 0;
  var cardAmount = Number(o.cardAmount) || 0;
  var docDate = o.date ? new Date(o.date) : new Date();
  var obj = {
    ID: newId(), Date: docDate, ItemsJSON: JSON.stringify(items),
    CashAmount: cashAmount, CardAmount: cardAmount, Discount: discount,
    Total: subtotal - discount, Comment: o.comment || '', Provider: o.provider || ''
  };
  var sheet = salesSheet();
  sheet.appendRow(SALES_HEADERS.map(function (h) { return obj[h]; }));
  applyStockDelta(items, 1, 'sale', obj.ID, 'Продажа', docDate);
  obj.Items = items;
  if (o.heldId) {
    var heldRow = findRowById(heldSheet(), o.heldId);
    if (heldRow !== -1) heldSheet().deleteRow(heldRow);
  }
  return obj;
}

// Corrects a mis-entered sale in place: reverses the old items' stock effect,
// applies the new items' stock effect, and overwrites the row, keeping the
// original ID and Date so it stays the same document in history.
function editSale(payload) {
  var sheet = salesSheet();
  var row = findRowById(sheet, payload.id);
  if (row === -1) throw new Error('Продажа не найдена');
  var data = sheet.getRange(row, 1, 1, SALES_HEADERS.length).getValues()[0];
  var oldItems = JSON.parse(data[SALES_HEADERS.indexOf('ItemsJSON')] || '[]');
  applyStockDelta(oldItems, -1, 'sale', payload.id, 'Корректировка продажи (отмена)');

  var items = (payload.items || []).map(function (i) {
    return { productId: i.productId, name: i.name, qty: Number(i.qty), price: Number(i.price) };
  });
  var subtotal = items.reduce(function (sum, i) { return sum + i.qty * i.price; }, 0);
  var discount = Number(payload.discount) || 0;
  var obj = {
    ID: payload.id,
    Date: data[SALES_HEADERS.indexOf('Date')],
    ItemsJSON: JSON.stringify(items),
    CashAmount: Number(payload.cashAmount) || 0,
    CardAmount: Number(payload.cardAmount) || 0,
    Discount: discount,
    Total: subtotal - discount,
    Comment: payload.comment || '',
    Provider: payload.provider || ''
  };
  setRowByHeaders(sheet, SALES_HEADERS, row, obj);
  applyStockDelta(items, 1, 'sale', payload.id, 'Корректировка продажи');
  obj.Items = items;
  return obj;
}

function deleteSale(payload) {
  var sheet = salesSheet();
  var row = findRowById(sheet, payload.id);
  if (row === -1) throw new Error('Продажа не найдена');
  var data = sheet.getRange(row, 1, 1, SALES_HEADERS.length).getValues()[0];
  var items = JSON.parse(data[SALES_HEADERS.indexOf('ItemsJSON')] || '[]');
  applyStockDelta(items, -1, 'sale', payload.id, 'Удаление продажи');
  sheet.deleteRow(row);
  return { id: payload.id };
}

// ---- Held (отложенные, неоплаченные чеки продавца) ----
function addHeld(payload) {
  var items = (payload.items || []).map(function (i) {
    return { productId: i.productId, name: i.name, qty: Number(i.qty), price: Number(i.price) };
  });
  var obj = { ID: newId(), Date: new Date(), ItemsJSON: JSON.stringify(items), Discount: Number(payload.discount) || 0 };
  heldSheet().appendRow(HELD_HEADERS.map(function (h) { return obj[h]; }));
  obj.Items = items;
  return obj;
}

function updateHeld(payload) {
  var sheet = heldSheet();
  var row = findRowById(sheet, payload.id);
  if (row === -1) throw new Error('Отложенный чек не найден');
  var items = (payload.items || []).map(function (i) {
    return { productId: i.productId, name: i.name, qty: Number(i.qty), price: Number(i.price) };
  });
  var obj = { ID: payload.id, Date: new Date(), ItemsJSON: JSON.stringify(items), Discount: Number(payload.discount) || 0 };
  setRowByHeaders(sheet, HELD_HEADERS, row, obj);
  obj.Items = items;
  return obj;
}

function deleteHeld(payload) {
  var sheet = heldSheet();
  var row = findRowById(sheet, payload.id);
  if (row === -1) throw new Error('Отложенный чек не найден');
  sheet.deleteRow(row);
  return { id: payload.id };
}

// ---- Payments (касса: прочие приходы/расходы, не связанные с закупкой товара) ----
function addPayment(p) {
  var obj = {
    ID: newId(), Date: p.date ? new Date(p.date) : new Date(), Type: p.type === 'income' ? 'income' : 'expense',
    Category: p.category || 'Прочее', Amount: Math.abs(Number(p.amount)) || 0,
    Comment: p.comment || '', RefId: p.refId || '', RefLabel: p.refLabel || ''
  };
  var sheet = paymentsSheet();
  sheet.appendRow(PAYMENTS_HEADERS.map(function (h) { return obj[h]; }));
  return obj;
}

function deletePayment(payload) {
  var sheet = paymentsSheet();
  var row = findRowById(sheet, payload.id);
  if (row === -1) throw new Error('Платёж не найден');
  sheet.deleteRow(row);
  return { id: payload.id };
}

// ---- Profit & Loss ----
function getPnl(payload) {
  var dateFrom = payload.dateFrom ? new Date(payload.dateFrom) : null;
  var dateTo = payload.dateTo ? new Date(payload.dateTo) : new Date();
  var inRange = function (d) {
    var dd = new Date(d);
    if (dateFrom && dd < dateFrom) return false;
    if (dd > dateTo) return false;
    return true;
  };

  var products = sheetToObjects(productsSheet(), PRODUCTS_HEADERS);
  var costById = {};
  products.forEach(function (p) { costById[p.ID] = Number(p.CostPrice) || 0; });

  var sales = sheetToObjects(salesSheet(), SALES_HEADERS).filter(function (s) { return inRange(s.Date); });
  var revenue = 0, cogs = 0;
  sales.forEach(function (s) {
    revenue += Number(s.Total);
    var items = JSON.parse(s.ItemsJSON || '[]');
    items.forEach(function (i) { cogs += Number(i.qty) * (costById[i.productId] || 0); });
  });
  var grossProfit = revenue - cogs;

  var TAX_CATEGORY = 'Налоги и сборы';
  // 'Выплата' is cash physically taken out of the till (partly already-earned
  // rent, partly the owner's own card top-up) - a cash-flow movement, not a
  // business expense, so it's excluded from operating costs here the same way
  // 'Внесение' is excluded from revenue.
  var payments = sheetToObjects(paymentsSheet(), PAYMENTS_HEADERS)
    .filter(function (p) { return p.Type === 'expense' && p.Category !== 'Выплата' && inRange(p.Date); });
  var byCategory = {};
  var taxes = 0;
  payments.forEach(function (p) {
    var amt = Number(p.Amount);
    if (p.Category === TAX_CATEGORY) { taxes += amt; return; }
    byCategory[p.Category] = (byCategory[p.Category] || 0) + amt;
  });
  var expensesByCategory = Object.keys(byCategory).map(function (cat) { return { category: cat, amount: byCategory[cat] }; });
  var totalExpenses = expensesByCategory.reduce(function (sum, e) { return sum + e.amount; }, 0);
  var operatingProfit = grossProfit - totalExpenses;
  var netProfit = operatingProfit - taxes;

  return {
    revenue: revenue, cogs: cogs, grossProfit: grossProfit,
    expensesByCategory: expensesByCategory, totalExpenses: totalExpenses,
    operatingProfit: operatingProfit, taxes: taxes, netProfit: netProfit
  };
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
