/**
 * Purchase-order cart regression tests:
 * requested quantity, cart state transitions, completed history, and image rotation.
 */
const { boot, tick, click, isVisible } = require('./harness');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n         -> ' + detail : '')); }
}

async function main() {
  const h = await boot().ready();
  const { window, doc } = h;
  const ev = (code) => window.eval(code);

  console.log('\n=== Purchase order cart ===');
  ev(`(function(){
    var unit=state.units[0], cat=state.catalog[0];
    cat.image='data:image/jpeg;base64,AAA'; cat.supplierId=state.suppliers[0].id; cat.orderQty=4;
    currentUnitId=unit.id; addItemToUnit(cat.id,2);
    window.__orderTest={unitId:unit.id,catId:cat.id};
  })()`);
  await tick(window, 280);
  const ids = ev(`(function(){var u=state.units.find(function(x){return x.id===window.__orderTest.unitId});var i=u.items.find(function(x){return x.catalogId===window.__orderTest.catId});return {unitId:u.id,itemId:i.id};})()`);

  check('item details include requested supplier quantity', !!doc.getElementById('itemEditOrderQty'));
  check('catalog default requested quantity reaches item details', doc.getElementById('itemEditOrderQty').value === '4');
  doc.getElementById('itemEditOrderQty').value = '7';
  click(doc, 'btnAddCurrentItemToCart');
  await tick(window, 30);

  const first = ev(`state.orderCart[0] && ({quantity:state.orderCart[0].quantity,status:state.orderCart[0].status,unitId:state.orderCart[0].unitId,itemId:state.orderCart[0].itemId})`);
  check('add-to-cart stores one line for the inventory item', ev('state.orderCart.length') === 1 && first.unitId === ids.unitId && first.itemId === ids.itemId);
  check('cart stores requested quantity', first.quantity === 7, JSON.stringify(first));
  check('new cart line starts as shortage', first.status === 'shortage', first.status);
  check('button is rendered over the item image', !!doc.querySelector('.placed-item .order-add-btn'));
  check('top navigation badge reflects the cart', doc.getElementById('orderCartBadge').textContent === '1');

  click(doc, 'btnOrderCart');
  await tick(window, 20);
  check('order cart opens', isVisible(doc.getElementById('orderCartModal')));
  check('cart displays Arabic shortage status', /نقص/.test(doc.getElementById('orderCartList').textContent));

  // wa.me counts as initiated after its prepared conversation is opened.
  ev(`state.settings.whatsapp.connected=true; state.settings.whatsapp.clinicNumber='0790000000'; state.settings.whatsapp.apiMode='wa_me'; state.settings.whatsapp.requireConfirm=false;`);
  click(doc, 'btnSendOrderCartWhatsapp');
  await tick(window, 50);
  check('WhatsApp send changes status to ordered', ev(`state.orderCart[0].status`) === 'ordered');
  check('cart displays Arabic ordered status', /تم الطلب/.test(doc.getElementById('orderCartList').textContent));

  const delivered = doc.querySelector('#orderCartList .delivered');
  check('delivered button becomes enabled after ordering', delivered && !delivered.disabled);
  delivered.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(window, 30);
  check('delivered removes the material from the active cart', ev('state.orderCart.length') === 0);
  check('delivered records a completed order', ev(`state.orderHistory.length===1 && state.orderHistory[0].status==='completed' && state.orderHistory[0].quantity===7`));
  check('completed order appears in history', /مكتمل/.test(doc.getElementById('orderHistoryList').textContent));

  console.log('\n=== Per-item image rotation ===');
  // close cart, open item details again and rotate right.
  click(doc, 'btnCloseOrderCart');
  ev(`openItemEdit('${ids.unitId}','${ids.itemId}')`);
  await tick(window, 20);
  click(doc, 'btnRotateItemRight');
  check('rotation preview advances by 90 degrees', doc.getElementById('itemRotationValue').textContent === '90°');
  click(doc, 'btnSaveItemEdit');
  await tick(window, 50);
  check('rotation is persisted on the inventory item', ev(`state.units.find(function(u){return u.id==='${ids.unitId}'}).items.find(function(i){return i.id==='${ids.itemId}'}).rotation`) === 90);
  const rotatedRatio = ev(`(function(){var i=state.units.find(function(u){return u.id==='${ids.unitId}'}).items.find(function(i){return i.id==='${ids.itemId}'});return i.w/i.h;})()`);
  check('a quarter turn re-shapes the card to the rotated photo', Math.abs(rotatedRatio - 0.3) < 0.01, String(rotatedRatio));
  const shell = doc.querySelector('.placed-item .item-image-shell');
  check('rotated item is rendered with a quarter-turn image shell', shell && shell.classList.contains('quarter-turn') && /90deg/.test(shell.getAttribute('style') || ''));

  const realErrors = h.errors.filter((e) => !/Not implemented|Could not parse CSS|fetch/i.test(e));
  check('no unexpected runtime errors', realErrors.length === 0, realErrors.join('\n'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
