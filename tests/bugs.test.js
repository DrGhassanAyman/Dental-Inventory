/**
 * Regression tests for the two reported issues:
 *  1. a material dropped into a jar/cabinet must show its whole picture, and keep its
 *     aspect ratio when the card is resized
 *  2. exit / cancel buttons must actually close the window they live in
 *
 * Run: node tests/bugs.test.js
 */
const { boot, tick, click, isVisible } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n         -> ' + detail : '')); }
}

async function main() {
  const h = await boot().ready();
  const { doc, window } = h;
  const ev = (code) => window.eval(code); // top-level `let` bindings are not window props

  // window.eval returns the live object, so always snapshot the numbers we compare later
  const readItem = (unitId, catId) => ev(
    `(function(){var u=state.units.filter(function(x){return x.id==='${unitId}';})[0];
      var i=u.items.filter(function(i){return i.catalogId==='${catId}';})[0];
      return i?{id:i.id,x:i.x,y:i.y,w:i.w,h:i.h}:null;})()`);

  console.log('\n=== Issue 1: whole image + locked aspect ratio ===');
  const cssOf = (re) => [...doc.styleSheets]
    .flatMap((s) => { try { return [...s.cssRules]; } catch (e) { return []; } })
    .filter((r) => r.selectorText && re.test(r.selectorText))
    .map((r) => r.selectorText + '{' + r.style.cssText + '}')
    .join(' | ');

  const itemImgRule = cssOf(/placed-item\s+img\.item-img/);
  console.log('  ' + (itemImgRule || '(rule not found)'));
  check('item image uses object-fit:contain (whole picture, nothing cropped away)',
    /object-fit:\s*contain/.test(itemImgRule), itemImgRule);
  const overlayRule = cssOf(/placed-item\.has-image\s+\.item-overlay/);
  console.log('  ' + (overlayRule || '(has-image overlay rule not found)'));
  check('the label strip no longer paints an opaque sheet over the picture',
    !!overlayRule && /position:\s*absolute/.test(overlayRule) && !/flex:\s*1/.test(overlayRule),
    overlayRule);

  // drop a material that has a photo into a cabinet, then resize it
  ev(`(function(){
    var u = state.units.filter(function(x){return x.type!=='drawer';})[0] || state.units[0];
    state.catalog[0].image = 'data:image/jpeg;base64,AAA';
    currentUnitId = u.id;
    window.__t = {unitId:u.id, catId:state.catalog[0].id};
    openUnit(u.id);
  })()`);
  await tick(window, 30);
  ev(`addItemToUnit(window.__t.catId, 5)`);
  await tick(window, 300);

  const t = ev('window.__t');
  check('item was placed into the unit', !!readItem(t.unitId, t.catId));
  await tick(window, 30); // let the photo "load" so fitItemToImage can run

  // the harness pretends every photo is 800x400 (aspect 2.0) and the unit is 1000x600,
  // so the card must end up with w%/h% = 2.0 * 600/1000 = 1.2
  const a = readItem(t.unitId, t.catId);
  console.log(`  new card: w=${a.w.toFixed(2)}% h=${a.h.toFixed(2)}%  (w/h=${(a.w / a.h).toFixed(4)}, expected 1.2000)`);
  check('a new card is shaped like its photo (no cropping, no stretching)',
    Math.abs(a.w / a.h - 1.2) < 0.01, `got ${(a.w / a.h).toFixed(4)}`);
  const ratio0 = a.w / a.h;

  const card = doc.querySelector('.placed-item');
  const handle = card && card.querySelector('.resize-handle');
  check('placed item rendered with a resize handle', !!handle);

  const drag = async (dx, dy) => {
    handle.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    doc.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientX: dx, clientY: dy }));
    doc.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));
    await tick(window, 20);
    return readItem(t.unitId, t.catId);
  };

  // grow it with a deliberately lopsided drag (200px right, 20px down)
  const b = await drag(200, 20);
  console.log(`  grow : w=${a.w.toFixed(2)}→${b.w.toFixed(2)}  h=${a.h.toFixed(2)}→${b.h.toFixed(2)}  ratio ${ratio0.toFixed(4)}→${(b.w / b.h).toFixed(4)}`);
  check('aspect ratio is preserved while growing', Math.abs(b.w / b.h - ratio0) / ratio0 < 0.01,
    `ratio drifted from ${ratio0.toFixed(4)} to ${(b.w / b.h).toFixed(4)}`);
  check('the card actually grew (resize still works)', b.w > a.w + 1 && b.h > a.h + 1);
  check('the grown card stays inside the unit',
    b.x + b.w <= 100.001 && b.y + b.h <= 100.001 && b.w >= 12 && b.h >= 12);

  // shrink it
  const c = await drag(-90, -10);
  console.log(`  shrink: w=${b.w.toFixed(2)}→${c.w.toFixed(2)}  h=${b.h.toFixed(2)}→${c.h.toFixed(2)}  ratio →${(c.w / c.h).toFixed(4)}`);
  check('aspect ratio is preserved while shrinking', Math.abs(c.w / c.h - ratio0) / ratio0 < 0.01,
    `${(c.w / c.h).toFixed(4)} vs ${ratio0.toFixed(4)}`);
  check('the card actually shrank', c.w < b.w - 1 && c.h < b.h - 1);
  check('the shrunk card never drops below the minimum size', c.w >= 12 && c.h >= 12,
    `w=${c.w.toFixed(2)} h=${c.h.toFixed(2)}`);

  // a wild drag far outside the unit must stay clamped
  const d = await drag(5000, 5000);
  check('an over-drag stays clamped inside the unit and keeps the ratio',
    d.x + d.w <= 100.001 && d.y + d.h <= 100.001 && Math.abs(d.w / d.h - ratio0) / ratio0 < 0.01,
    `x=${d.x.toFixed(2)} y=${d.y.toFixed(2)} w=${d.w.toFixed(2)} h=${d.h.toFixed(2)}`);

  // swapping the photo re-shapes the card to the new proportions
  window.__imgW = 300; window.__imgH = 600; // portrait photo → aspect 0.5 → w/h must be 0.5 * 600/1000 = 0.30
  ev(`state.catalog[0].image='data:image/jpeg;base64,BBB'; refitItemsForCatalog(window.__t.catId);`);
  await tick(window, 40);
  const e2 = readItem(t.unitId, t.catId);
  console.log(`  after photo swap: w=${e2.w.toFixed(2)}% h=${e2.h.toFixed(2)}%  (w/h=${(e2.w / e2.h).toFixed(4)}, expected 0.3000)`);
  check('changing the photo re-shapes the card to the new proportions',
    Math.abs(e2.w / e2.h - 0.3) < 0.01, `got ${(e2.w / e2.h).toFixed(4)}`);
  check('the re-shaped card stays inside the unit',
    e2.x + e2.w <= 100.001 && e2.y + e2.h <= 100.001 && e2.w >= 12 && e2.h >= 12);
  const ratio2 = e2.w / e2.h;
  const f2 = await drag(120, 5);
  check('the new proportions are also locked while resizing',
    Math.abs(f2.w / f2.h - ratio2) / ratio2 < 0.01,
    `${(f2.w / f2.h).toFixed(4)} vs ${ratio2.toFixed(4)}`);
  window.__imgW = 800; window.__imgH = 400; // restore for the later scenarios

  console.log('\n=== Issue 2: exit / cancel buttons must close their window ===');

  // A: item edit window — the one that auto-opens right after you add a material
  ev(`openItemEdit('${t.unitId}','${d.id}')`);
  await tick(window, 30);
  check('item edit window opened', isVisible(doc.getElementById('itemEditModal')));
  for (const id of ['btnCancelItemEdit', 'btnExitItemEdit', 'btnCloseItemEdit']) {
    const btn = doc.getElementById(id);
    check(`item edit window has a ${id} button`, !!btn);
    if (!btn) continue;
    if (doc.getElementById('itemEditModal').classList.contains('hidden')) {
      ev(`openItemEdit('${t.unitId}','${d.id}')`);
      await tick(window, 20);
    }
    click(doc, id);
    await tick(window, 20);
    check(`clicking ${id} closes the item edit window`, !isVisible(doc.getElementById('itemEditModal')));
  }

  // B: materials window
  click(doc, 'btnMaterials');
  await tick(window, 30);
  check('materials window opened', isVisible(doc.getElementById('materialsModal')));
  doc.getElementById('matName').value = 'مادة اختبار';
  click(doc, 'btnSaveMat');
  await tick(window, 30);
  check('material was saved', ev(`state.catalog.some(function(c){return c.name==='مادة اختبار';})`));
  const toastTxt = [...doc.querySelectorAll('#toastContainer .toast')].map((n) => n.textContent).join(' ');
  console.log('  toast after save: ' + (toastTxt.trim() || '(none)'));
  check('saving a material shows a visible confirmation toast', /تم إضافة المادة/.test(toastTxt), toastTxt);
  click(doc, 'btnCancelMat');
  await tick(window, 20);
  check('clicking إلغاء closes the materials window', !isVisible(doc.getElementById('materialsModal')),
    'it only reset the form and left the window open');
  check('إلغاء also cleared the form', doc.getElementById('matName').value === '');
  click(doc, 'btnMaterials');
  await tick(window, 20);
  click(doc, 'btnExitMaterials');
  await tick(window, 20);
  check('clicking 🚪 خروج closes the materials window', !isVisible(doc.getElementById('materialsModal')));

  // C: suppliers window
  click(doc, 'btnSuppliers');
  await tick(window, 30);
  check('suppliers window opened', isVisible(doc.getElementById('suppliersModal')));
  click(doc, 'btnCancelSup');
  await tick(window, 20);
  check('clicking إلغاء closes the suppliers window', !isVisible(doc.getElementById('suppliersModal')));
  click(doc, 'btnSuppliers');
  await tick(window, 20);
  click(doc, 'btnExitSuppliers');
  await tick(window, 20);
  check('clicking 🚪 خروج closes the suppliers window', !isVisible(doc.getElementById('suppliersModal')));

  // D: quantity window
  doc.getElementById('qtyModal').classList.remove('hidden');
  click(doc, 'btnCancelQty');
  await tick(window, 20);
  check('clicking إلغاء closes the quantity window', !isVisible(doc.getElementById('qtyModal')));

  // E: Escape closes only the front-most window, not the whole stack
  ev(`openUnit('${t.unitId}')`);
  await tick(window, 20);
  ev(`openItemEdit('${t.unitId}','${d.id}')`);
  await tick(window, 20);
  check('unit + item edit windows are both open',
    isVisible(doc.getElementById('unitModal')) && isVisible(doc.getElementById('itemEditModal')));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(window, 20);
  check('Escape closes only the front window (item edit)',
    !isVisible(doc.getElementById('itemEditModal')) && isVisible(doc.getElementById('unitModal')));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(window, 20);
  check('a second Escape closes the window underneath (unit)', !isVisible(doc.getElementById('unitModal')));

  console.log('\n=== Audit: close control per window ===');
  [...doc.querySelectorAll('.modal')].forEach((m) => {
    const closers = [...m.querySelectorAll('button')].filter((b) =>
      /خروج|إغلاق|إلغاء|✕/.test(b.textContent || '') || /close|cancel|exit/i.test(b.id || ''));
    const wired = closers.filter((b) => {
      const wasHidden = m.classList.contains('hidden');
      m.classList.remove('hidden');
      b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      const closed = m.classList.contains('hidden');
      if (wasHidden) m.classList.add('hidden');
      return closed;
    });
    check(`#${m.id}: ${closers.length} close-looking button(s), ${wired.length} actually close it`,
      closers.length > 0 && wired.length > 0,
      JSON.stringify(closers.map((b) => (b.id || '(no id)') + ':"' + (b.textContent || '').trim() + '"')));
  });

  console.log('\n=== Audit: clicking every button is safe ===');
  [...doc.querySelectorAll('button[id]')].forEach((b) => {
    const modal = b.closest('.modal');
    const restore = modal ? modal.className : null;
    if (modal) modal.classList.remove('hidden');
    try { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); }
    catch (err) { console.log('  threw: ' + b.id + ' -> ' + err.message); }
    if (modal) modal.className = restore;
  });
  await tick(window, 30);

  console.log('\n=== runtime errors ===');
  const realErrors = h.errors.filter((e) => !/Not implemented|Could not parse CSS|fetch/i.test(e));
  check('no unexpected runtime errors', realErrors.length === 0, realErrors.join('\n'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
