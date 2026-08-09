'use strict';

/* Runs inside the preview iframe, in place of the site's own main.js.
 *
 * It makes marked regions editable in the real page, and on save diffs the
 * live DOM against a pristine snapshot to produce the smallest possible set
 * of operations for the server. Nothing the editor adds to the page ever
 * reaches the saved file: all chrome lives in a separate overlay layer and
 * the few attributes added inline are stripped before diffing. */

(function () {
  const PAGE = window.__CMS_PAGE__ || 'index.html';
  const admin = window.parent && window.parent.CMSAdmin;
  if (!admin) return;

  /* Elements whose direct children can be added, removed and reordered. */
  const LIST_SELECTORS = ['[data-cms-kind="list"]', '.exhibitions > li > .gallery'];
  /* Text that can be edited inside a list item. */
  const ITEM_TEXT = 'h2, h3, .year, .venue, figcaption, p';
  /* Only these attributes carry content; everything else is layout. */
  const CONTENT_ATTRS = ['src', 'href', 'alt', 'title', 'data-caption', 'data-cat', 'loading'];
  const STRIP_ATTRS = ['contenteditable', 'spellcheck', 'data-cms-oi', 'data-cms-hot'];

  // Editor chrome is never content: keep it out of every child walk.
  const kids = (el) => Array.prototype.filter.call(el.children, (c) => !c.classList.contains('cms-ui'));
  const isList = (el) => el.nodeType === 1 && LIST_SELECTORS.some((s) => el.matches(s));
  const regions = () => Array.prototype.slice.call(document.querySelectorAll('[data-cms]'));

  let touched = false;
  const markDirty = () => { touched = true; admin.setDirty(); };

  /* ---------- snapshots ---------- */

  function cleanClone(el) {
    const copy = el.cloneNode(true);
    const all = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll('*')));
    for (const node of all) {
      for (const a of STRIP_ATTRS) node.removeAttribute && node.removeAttribute(a);
    }
    for (const junk of copy.querySelectorAll('.cms-ui')) junk.remove();

    // "is-active" tracks whichever slide is on screen, which is a viewing
    // state, not content. Pin it to the first slide so browsing the slideshow
    // never registers as a change.
    for (const list of listsIn(copy, '[data-cms="startseite-slider"]')) {
      kids(list).forEach((slide, i) => slide.classList.toggle('is-active', i === 0));
    }
    return copy;
  }

  function listsIn(el, selector) {
    const found = [];
    if (el.matches && el.matches(selector)) found.push(el);
    if (el.querySelectorAll) found.push(...el.querySelectorAll(selector));
    return found;
  }

  /** Store a pristine copy of every region and re-index the live list items. */
  function snapshot() {
    for (const region of regions()) {
      region.__orig = cleanClone(region);
      indexItems(region);
    }
  }

  /* Runs only when the live DOM matches what is on disk, so an item's current
   * position *is* its index in the file — assign unconditionally, or a second
   * save after a reorder would work from stale indices. */
  function indexItems(root) {
    for (const list of listsIn(root, LIST_SELECTORS.join(','))) {
      kids(list).forEach((item, i) => item.setAttribute('data-cms-oi', String(i)));
    }
  }

  /* ---------- diffing ---------- */

  const hasText = (el) =>
    Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
  const isLeaf = (el) => el.children.length === 0 || hasText(el);

  /** innerHTML with editor artefacts removed and b/i normalised to strong/em. */
  function innerHtmlOf(el) {
    const copy = cleanClone(el);
    for (const b of copy.querySelectorAll('b')) swapTag(b, 'strong');
    for (const i of copy.querySelectorAll('i')) swapTag(i, 'em');
    for (const span of copy.querySelectorAll('span[style], font')) unwrap(span);
    return copy.innerHTML;
  }

  function swapTag(el, name) {
    const next = document.createElement(name);
    while (el.firstChild) next.appendChild(el.firstChild);
    el.replaceWith(next);
  }
  function unwrap(el) {
    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
    el.remove();
  }

  function attrOps(cur, orig, path) {
    const ops = [];
    for (const name of CONTENT_ATTRS) {
      const a = cur.getAttribute(name);
      const b = orig.getAttribute(name);
      if (a === b) continue;
      if (a === null) continue;                    // never remove attributes
      ops.push({ op: 'setAttr', path, name, value: a });
    }
    return ops;
  }

  /** Recursive diff of one element against its pristine counterpart. */
  function diffElement(cur, orig, path) {
    let ops = attrOps(cur, orig, path);

    if (isList(cur)) {
      const items = itemSpec(cur, orig);
      if (items) ops.push({ op: 'setItems', path, items });
      return ops;
    }

    const a = kids(cur);
    const b = kids(orig);

    if (isLeaf(cur) || isLeaf(orig) || a.length !== b.length) {
      if (innerHtmlOf(cur) !== innerHtmlOf(orig)) {
        ops.push({ op: 'setInner', path, html: innerHtmlOf(cur) });
      }
      return ops;
    }

    for (let i = 0; i < a.length; i++) {
      ops = ops.concat(diffElement(a[i], b[i], path.concat(i)));
    }
    return ops;
  }

  /**
   * Build the item list for a list element, or null when nothing changed.
   * Each entry points at the index of the original item it came from, so the
   * server can reuse that item's exact source text.
   */
  function itemSpec(list, origList) {
    const live = kids(list);
    const originals = kids(origList);
    const isSlider = list.matches('[data-cms="startseite-slider"]');

    let structural = live.length !== originals.length;
    const entries = live.map((item, i) => {
      const oi = parseInt(item.getAttribute('data-cms-oi'), 10);
      const source = originals[oi];
      if (!source) return null;
      if (oi !== i) structural = true;

      let edits = diffElement(item, source, []);
      if (isSlider) {
        // Keep "is-active" on the first slide only, whatever the order is.
        const want = i === 0 ? 'slide is-active' : 'slide';
        if (source.getAttribute('class') !== want) {
          edits = edits.concat([{ op: 'setAttr', path: [], name: 'class', value: want }]);
        }
      }
      return { ref: oi, edits };
    });

    if (entries.some((e) => e === null)) return null;
    if (!structural && entries.every((e) => !e.edits.length)) return null;
    return entries;
  }

  function collectOps() {
    const out = {};
    for (const region of regions()) {
      if (!region.__orig) continue;
      const id = region.getAttribute('data-cms');
      const ops = isList(region)
        ? (function () { const s = itemSpec(region, region.__orig); return s ? [{ op: 'setItems', path: [], items: s }] : []; })()
        : diffElement(region, region.__orig, []);
      if (ops.length) out[id] = ops;
    }
    return out;
  }

  /* ---------- overlay chrome ---------- */

  const layer = document.createElement('div');
  layer.className = 'cms-ui cms-layer';
  document.body.appendChild(layer);

  function makeButton(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cms-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  const bar = document.createElement('div');
  bar.className = 'cms-ui cms-bar';
  bar.hidden = true;
  layer.appendChild(bar);

  let barTarget = null;
  let barAnchor = null;
  let hideTimer = null;

  function placeBar(target) {
    const r = target.getBoundingClientRect();
    bar.hidden = false;
    const top = r.top < 42 ? r.top + 6 : r.top - 34;
    bar.style.top = `${Math.max(4, top)}px`;
    bar.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - bar.offsetWidth - 8))}px`;
  }

  /** `anchor` identifies the hovered thing; rebuilding only on change stops flicker. */
  function showBarFor(anchor, target, build) {
    clearTimeout(hideTimer);
    if (barAnchor === anchor && !bar.hidden) { placeBar(target); return; }
    barAnchor = anchor;
    barTarget = target;
    bar.replaceChildren(...build());
    placeBar(target);
  }

  function hideBarSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      bar.hidden = true;
      barTarget = null;
      barAnchor = null;
    }, 260);
  }

  bar.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  bar.addEventListener('mouseleave', hideBarSoon);
  window.addEventListener('scroll', () => { if (barTarget) placeBar(barTarget); }, true);
  window.addEventListener('resize', () => { if (barTarget) placeBar(barTarget); });

  /* ---------- image swapping ---------- */

  async function swapImage(img) {
    const chosen = await admin.pickImage();
    if (!chosen) return;
    img.setAttribute('src', chosen);
    const link = img.closest('a[data-lightbox], a.item');
    if (link && link.hasAttribute('href')) link.setAttribute('href', chosen);
    markDirty();
  }

  function editAlt(img) {
    const current = img.getAttribute('alt') || '';
    const next = window.prompt('Bildbeschreibung (wird von Vorlesesoftware genutzt):', current);
    if (next === null || next === current) return;
    img.setAttribute('alt', next);
    const link = img.closest('a[data-lightbox]');
    if (link && link.hasAttribute('data-caption')) link.setAttribute('data-caption', next);
    markDirty();
  }

  /* ---------- list item controls ---------- */

  function reindexAfterStructuralChange() {
    markDirty();
    bar.hidden = true;
    barTarget = null;
    barAnchor = null;
  }

  function itemButtons(item, list) {
    const siblings = kids(list);
    const at = siblings.indexOf(item);
    const buttons = [];

    buttons.push(makeButton('↑', 'Nach vorne schieben', () => {
      if (at > 0) { list.insertBefore(item, siblings[at - 1]); reindexAfterStructuralChange(); }
    }));
    buttons.push(makeButton('↓', 'Nach hinten schieben', () => {
      if (at < siblings.length - 1) { list.insertBefore(siblings[at + 1], item); reindexAfterStructuralChange(); }
    }));
    buttons.push(makeButton('⧉', 'Kopie einfügen', () => {
      const copy = item.cloneNode(true);
      item.after(copy);
      wireItem(copy);
      reindexAfterStructuralChange();
    }));

    const cat = item.getAttribute('data-cat');
    if (cat !== null) buttons.push(categorySelect(item));

    buttons.push(makeButton('✕', 'Löschen', () => {
      if (kids(list).length <= 1) {
        admin.toast('Der letzte Eintrag kann nicht gelöscht werden.', true);
        return;
      }
      if (!window.confirm('Diesen Eintrag wirklich löschen?')) return;
      item.remove();
      reindexAfterStructuralChange();
    }));

    return buttons;
  }

  function categorySelect(item) {
    const wrap = document.createElement('select');
    wrap.className = 'cms-select';
    wrap.title = 'Kategorie';
    const cats = Array.prototype.map.call(
      document.querySelectorAll('.filters .filter'),
      (b) => b.getAttribute('data-filter')
    ).filter((c) => c && c !== 'all');
    for (const c of cats) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      if (c === item.getAttribute('data-cat')) o.selected = true;
      wrap.appendChild(o);
    }
    wrap.addEventListener('change', () => { item.setAttribute('data-cat', wrap.value); markDirty(); });
    wrap.addEventListener('click', (e) => e.stopPropagation());
    return wrap;
  }

  function addItemButton(list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cms-ui cms-add';
    btn.textContent = '+ Eintrag hinzufügen';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const last = kids(list).pop();
      if (!last) return;
      const copy = last.cloneNode(true);
      list.insertBefore(copy, btn);
      wireItem(copy);
      markDirty();
      copy.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const img = copy.querySelector('img');
      if (img) await swapImage(img);
    });
    list.appendChild(btn);
  }

  /* ---------- text editing ---------- */

  function makeEditable(el, singleLine) {
    if (el.getAttribute('contenteditable') === 'true') return;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');

    el.addEventListener('input', markDirty);
    el.addEventListener('focus', () => {
      admin.hint(singleLine ? 'Text ändern — Enter beendet die Eingabe.' : 'Text ändern. Strg+B fett, Strg+I kursiv.');
    });
    el.addEventListener('blur', () => admin.hint(null));

    el.addEventListener('keydown', (e) => {
      if (singleLine && e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });

    // Paste as plain text so nothing from Word or a website leaks into the page.
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, singleLine ? text.replace(/\s+/g, ' ') : text);
    });
  }

  /* ---------- wiring ---------- */

  /* A clone keeps its data-cms-oi, which is exactly what the server needs:
   * both copies are built from the same original source text. */
  function wireItem(item) {
    for (const t of item.querySelectorAll(ITEM_TEXT)) makeEditable(t, !t.matches('p'));
    item.setAttribute('data-cms-hot', '1');
  }

  function setup() {
    document.documentElement.classList.add('cms-editing');
    snapshot();

    for (const region of regions()) {
      const kind = region.getAttribute('data-cms-kind') || 'rich';

      if (kind === 'text') makeEditable(region, true);
      else if (kind === 'rich') makeEditable(region, false);

      if (isList(region)) {
        for (const item of kids(region)) wireItem(item);
        addItemButton(region);
      }

      for (const nested of region.querySelectorAll(LIST_SELECTORS.join(','))) {
        for (const item of kids(nested)) wireItem(item);
        addItemButton(nested);
      }
    }

    // hover chrome: one bar carrying whatever applies to the hovered thing
    document.addEventListener('mouseover', (e) => {
      if (!e.target.closest) return;
      const img = e.target.closest('[data-cms] img');
      const item = e.target.closest('[data-cms-hot]');
      const inList = item && item.parentElement && isList(item.parentElement);

      if (!img && !inList) {
        if (!bar.contains(e.target)) hideBarSoon();
        return;
      }

      showBarFor(item || img, item || img, () => {
        const buttons = [];
        if (img) {
          buttons.push(makeButton('Bild tauschen', 'Anderes Bild wählen oder hochladen', () => swapImage(img)));
          buttons.push(makeButton('Beschreibung', 'Bildbeschreibung bearbeiten', () => editAlt(img)));
        }
        if (inList) buttons.push(...itemButtons(item, item.parentElement));
        return buttons;
      });
    });

    // keep clicks inside the page from navigating away
    document.addEventListener('click', (e) => {
      const link = e.target.closest && e.target.closest('a[href]');
      if (!link || bar.contains(link)) return;
      const href = link.getAttribute('href') || '';
      e.preventDefault();
      const page = /^([a-z0-9_-]+\.html)(#.*)?$/i.exec(href);
      if (page) {
        parentGoTo(page[1]);
      } else if (href.startsWith('#')) {
        const t = document.getElementById(href.slice(1));
        if (t) t.scrollIntoView({ behavior: 'smooth' });
      }
    }, true);

    wireSlider();
    wireFilters();

    const year = document.getElementById('year');
    if (year) year.textContent = new Date().getFullYear();

    admin.register({ collectOps, markSaved: () => { snapshot(); touched = false; }, page: PAGE });
    admin.pageChanged(PAGE);
  }

  function parentGoTo(file) {
    if (touched && !window.confirm('Es gibt nicht gespeicherte Änderungen. Seite trotzdem wechseln?')) return;
    touched = false;
    window.location.href = `/preview/${file}`;
  }

  /* The site's slider normally auto-rotates; here it only steps on demand so
   * every slide can be reached and edited. */
  function wireSlider() {
    const slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
    const dotsWrap = document.querySelector('.slider-dots');
    if (!slides.length) return;

    let current = Math.max(0, slides.findIndex((s) => s.classList.contains('is-active')));

    const paint = () => {
      slides.forEach((s, i) => s.classList.toggle('is-active', i === current));
      if (!dotsWrap) return;
      dotsWrap.replaceChildren(...slides.map((_, i) => {
        const d = document.createElement('button');
        d.className = i === current ? 'is-active' : '';
        d.setAttribute('aria-label', `Bild ${i + 1}`);
        d.addEventListener('click', () => { current = i; paint(); });
        return d;
      }));
    };

    const go = (delta) => { current = (current + delta + slides.length) % slides.length; paint(); };
    const prev = document.querySelector('.slider-arrow.prev');
    const next = document.querySelector('.slider-arrow.next');
    if (prev) prev.addEventListener('click', (e) => { e.preventDefault(); go(-1); });
    if (next) next.addEventListener('click', (e) => { e.preventDefault(); go(1); });
    paint();
  }

  function wireFilters() {
    const filters = Array.prototype.slice.call(document.querySelectorAll('.filter'));
    const items = Array.prototype.slice.call(document.querySelectorAll('.grid .item'));
    for (const btn of filters) {
      btn.addEventListener('click', () => {
        filters.forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const cat = btn.getAttribute('data-filter');
        items.forEach((it) => it.classList.toggle('is-hidden', cat !== 'all' && it.getAttribute('data-cat') !== cat));
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
