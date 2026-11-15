'use strict';

/* Admin shell: page tabs, save/publish, image picker.
 * The actual editing happens inside the preview iframe (editor.js), which
 * registers itself here via window.CMSAdmin. Both run on the same origin. */

const $ = (id) => document.getElementById(id);

const el = {
  pages: $('pages'), state: $('state'), hint: $('hint'),
  save: $('btn-save'), publish: $('btn-publish'), discard: $('btn-discard'),
  preview: $('preview'), toast: $('toast'),
  picker: $('picker'), thumbs: $('picker-thumbs'), search: $('picker-search'),
  pickerFile: $('picker-file'), pickerClose: $('picker-close'),
  dialog: $('dialog'), dialogTitle: $('dialog-title'),
  dialogBody: $('dialog-body'), dialogActions: $('dialog-actions'),
};

let state = { pages: [], git: null };
let currentPage = 'index.html';
let editor = null;          // set by the iframe
let dirty = false;
let images = [];
let pickerResolve = null;

/* ---------- plumbing ---------- */

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({ error: 'Unlesbare Antwort vom Server' }));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(message, isError) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', !!isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, isError ? 7000 : 3000);
}

/* ---------- header state ---------- */

function renderPages() {
  el.pages.replaceChildren(...state.pages.map((p) => {
    const b = document.createElement('button');
    b.textContent = p.title;
    b.setAttribute('aria-current', String(p.file === currentPage));
    b.addEventListener('click', () => goToPage(p.file));
    return b;
  }));
}

function renderState() {
  const git = state.git;
  if (dirty) {
    el.state.className = 'state dirty';
    el.state.textContent = 'Nicht gespeicherte Änderungen';
  } else if (git && git.pending) {
    const n = git.changedCount + git.unpushedCommits;
    el.state.className = 'state dirty';
    el.state.textContent = `${n} Änderung${n === 1 ? '' : 'en'} noch nicht veröffentlicht`;
  } else {
    el.state.className = 'state clean';
    el.state.textContent = 'Alles veröffentlicht';
  }
  el.save.disabled = !dirty;
  el.discard.disabled = !(dirty || (git && git.pending));
}

async function refreshState() {
  state = await api('/api/state');
  renderPages();
  renderState();
}

function goToPage(file) {
  if (dirty && !confirm('Es gibt nicht gespeicherte Änderungen. Seite trotzdem wechseln?')) return;
  currentPage = file;
  dirty = false;
  editor = null;
  el.preview.src = `/preview/${file}`;
  renderPages();
  renderState();
}

/* ---------- image picker ---------- */

async function loadImages() {
  images = (await api('/api/images')).images;
}

function renderThumbs(filter) {
  const q = (filter || '').toLowerCase();
  const list = images.filter((i) => !q || i.name.toLowerCase().includes(q));
  el.thumbs.replaceChildren(...list.map((img) => {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.title = `${img.name} · ${Math.round(img.bytes / 1024)} KB`;

    const im = document.createElement('img');
    im.src = '/' + img.path;
    im.loading = 'lazy';
    im.alt = '';

    const cap = document.createElement('span');
    cap.textContent = img.name;

    b.append(im, cap);
    b.addEventListener('click', () => closePicker(img.path));
    return b;
  }));
  if (!list.length) {
    const p = document.createElement('p');
    p.textContent = 'Keine passenden Bilder gefunden.';
    p.style.color = 'var(--muted)';
    el.thumbs.replaceChildren(p);
  }
}

/** Opened by the editor; resolves to a path like "assets/img/foo.jpg" or null. */
async function openPicker() {
  el.picker.hidden = false;
  el.search.value = '';
  el.thumbs.textContent = 'Lade…';
  await loadImages();
  renderThumbs('');
  el.search.focus();
  return new Promise((resolve) => { pickerResolve = resolve; });
}

function closePicker(value) {
  el.picker.hidden = true;
  const done = pickerResolve;
  pickerResolve = null;
  if (done) done(value || null);
}

/** Downscale in the browser so the repository does not fill up with 6 MB photos. */
function shrink(file, maxSide = 2000, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale === 1 && file.size < 900 * 1024) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
        reader.readAsDataURL(file);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      resolve(canvas.toDataURL(type, quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}

async function uploadFile(file) {
  try {
    toast('Bild wird verkleinert und gespeichert…');
    const dataUrl = await shrink(file);
    const saved = await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, dataUrl }),
    });
    await loadImages();
    toast(`„${saved.name}" hinzugefügt`);
    closePicker(saved.path);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- save & publish ---------- */

async function save() {
  if (!editor) return;
  const ops = editor.collectOps();
  if (!Object.keys(ops).length) {
    dirty = false;
    renderState();
    toast('Keine Änderungen zu speichern');
    return;
  }
  el.save.disabled = true;
  try {
    const result = await api('/api/save', {
      method: 'POST',
      body: JSON.stringify({ page: currentPage, regions: ops }),
    });
    state.git = result.git;
    dirty = false;
    editor.markSaved();
    renderState();
    const extra = result.alsoTouched && result.alsoTouched.length
      ? ` (auch auf ${result.alsoTouched.length} weiteren Seiten)` : '';
    toast(`Gespeichert${extra}`);
  } catch (err) {
    toast(`Nicht gespeichert: ${err.message}`, true);
    renderState();
  }
}

function dialog(title, bodyNodes, actions) {
  el.dialogTitle.textContent = title;
  el.dialogBody.replaceChildren(...bodyNodes);
  el.dialogActions.replaceChildren(...actions);
  el.dialog.hidden = false;
}
const closeDialog = () => { el.dialog.hidden = true; finishFocus(null); };

/* ---------- image section (object-position) ---------- */

let focusResolve = null;
function finishFocus(value) {
  const done = focusResolve;
  focusResolve = null;
  if (done) done(value);
}

function parsePosition(text) {
  const words = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  const parts = String(text || '').trim().split(/\s+/).map((t) =>
    t in words ? words[t] : (/%$/.test(t) ? parseFloat(t) : NaN));
  const clamp = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50);
  return [clamp(parts[0]), clamp(parts.length > 1 ? parts[1] : 50)];
}

const MAX_ZOOM = 4;

/**
 * Opened by the editor. `frameAspect` is width/height of the slot the image
 * is shown in; `current` is { pos: "30% 65%", zoom: 1.5 }. Resolves to a new
 * { pos, zoom }, or null when cancelled.
 *
 * The page shows the result as object-position: pos; transform-origin: pos;
 * scale: zoom. With origin and position equal, the visible part of the image
 * is exactly the frame drawn here: a fraction fw/zoom wide, starting at
 * pos * (1 - fw/zoom) — the same formula as plain object-position.
 */
function pickFocus(src, frameAspect, current) {
  finishFocus(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.draggable = false;
    img.className = 'crop-img';
    img.alt = '';
    img.onerror = () => { toast('Bild konnte nicht geladen werden', true); resolve(null); };
    img.onload = () => {
      const imgAspect = img.naturalWidth / img.naturalHeight;
      // Part of the image the slot shows at zoom 1, as a fraction of its size.
      const fw = Math.min(1, frameAspect / imgAspect);
      const fh = Math.min(1, imgAspect / frameAspect);
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

      // State: zoom and the frame's centre, in image fractions.
      let zoom = clamp(Number(current && current.zoom) || 1, 1, MAX_ZOOM);
      const [px0, py0] = parsePosition(current && current.pos);
      let cx = (px0 / 100) * (1 - fw / zoom) + fw / zoom / 2;
      let cy = (py0 / 100) * (1 - fh / zoom) + fh / zoom / 2;

      const size = () => [fw / zoom, fh / zoom];
      const position = () => {
        const [w, h] = size();
        return [w < 1 ? ((cx - w / 2) / (1 - w)) * 100 : 50, h < 1 ? ((cy - h / 2) / (1 - h)) * 100 : 50];
      };

      const stage = document.createElement('div');
      stage.className = 'crop-stage';
      const frame = document.createElement('div');
      frame.className = 'crop-frame';
      const handle = document.createElement('div');
      handle.className = 'crop-handle';
      handle.title = 'Ziehen zum Vergrößern oder Verkleinern';
      frame.appendChild(handle);
      stage.append(img, frame);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '1';
      slider.max = String(MAX_ZOOM);
      slider.step = '0.01';
      const zoomLabel = document.createElement('span');
      const zoomRow = document.createElement('label');
      zoomRow.className = 'crop-zoom';
      zoomRow.append('Zoom', slider, zoomLabel);

      const paint = () => {
        const [w, h] = size();
        cx = clamp(cx, w / 2, 1 - w / 2);
        cy = clamp(cy, h / 2, 1 - h / 2);
        frame.style.width = `${w * 100}%`;
        frame.style.height = `${h * 100}%`;
        frame.style.left = `${(cx - w / 2) * 100}%`;
        frame.style.top = `${(cy - h / 2) * 100}%`;
        slider.value = String(zoom);
        zoomLabel.textContent = `${Math.round(zoom * 100)} %`;
      };

      const pointAt = (e) => {
        const r = stage.getBoundingClientRect();
        return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      };

      stage.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        stage.setPointerCapture(e.pointerId);
        const [ux, uy] = pointAt(e);
        const [w, h] = size();
        let move;

        if (e.target === handle) {
          // Resize from the bottom-right corner; the top-left corner stays put.
          const ax = cx - w / 2;
          const ay = cy - h / 2;
          move = (ev) => {
            const [mx, my] = pointAt(ev);
            const wide = Math.max(mx - ax, ((my - ay) * fw) / fh, 0.0001);
            zoom = clamp(fw / wide, 1, MAX_ZOOM);
            const [nw, nh] = size();
            cx = ax + nw / 2;
            cy = ay + nh / 2;
            paint();
          };
        } else {
          // Grab the frame where it was clicked; a click outside centres it there first.
          const inside = Math.abs(ux - cx) <= w / 2 && Math.abs(uy - cy) <= h / 2;
          if (!inside) { cx = ux; cy = uy; paint(); }
          const dx = cx - ux;
          const dy = cy - uy;
          move = (ev) => {
            const [mx, my] = pointAt(ev);
            cx = mx + dx;
            cy = my + dy;
            paint();
          };
        }

        const up = () => {
          stage.removeEventListener('pointermove', move);
          stage.removeEventListener('pointerup', up);
          stage.removeEventListener('pointercancel', up);
        };
        stage.addEventListener('pointermove', move);
        stage.addEventListener('pointerup', up);
        stage.addEventListener('pointercancel', up);
      });

      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        zoom = clamp(zoom * Math.exp(-e.deltaY * 0.0015), 1, MAX_ZOOM);
        paint();
      }, { passive: false });

      slider.addEventListener('input', () => { zoom = clamp(Number(slider.value), 1, MAX_ZOOM); paint(); });
      paint();

      focusResolve = resolve;
      dialog('Bildausschnitt wählen', [
        p('Rahmen verschieben, um den sichtbaren Teil zu wählen. Mit der Ecke unten rechts, dem Mausrad oder dem Regler hineinzoomen.'),
        stage,
        zoomRow,
      ], [
        button('Zurücksetzen', 'ghost', () => { zoom = 1; cx = 0.5; cy = 0.5; paint(); }),
        button('Abbrechen', '', closeDialog),
        button('Übernehmen', 'primary', () => {
          const [x, y] = position();
          finishFocus({ pos: `${Math.round(x)}% ${Math.round(y)}%`, zoom: Math.round(zoom * 100) / 100 });
          closeDialog();
        }),
      ]);
    };
    img.src = '/' + src.replace(/^\/+/, '');
  });
}

function p(text) { const n = document.createElement('p'); n.textContent = text; return n; }
function pre(text) { const n = document.createElement('pre'); n.textContent = text; return n; }
function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

async function publish() {
  if (dirty) {
    await save();
    if (dirty) return;                       // save failed — stop here
  }

  const git = (state.git = await api('/api/git'));

  if (!git.hasRemote) {
    dialog('Noch nicht eingerichtet', [
      p('Diese Website ist noch mit keinem GitHub-Repository verbunden, deshalb kann sie nicht veröffentlicht werden.'),
      p('Das muss einmalig eingerichtet werden — siehe CMS-ANLEITUNG.md im Projektordner.'),
    ], [button('OK', 'primary', closeDialog)]);
    return;
  }

  if (!git.pending) {
    dialog('Nichts zu veröffentlichen', [p('Es gibt keine Änderungen seit der letzten Veröffentlichung.')],
      [button('OK', 'primary', closeDialog)]);
    return;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.value = 'Website aktualisiert';

  const list = document.createElement('ul');
  list.replaceChildren(...git.changedFiles.slice(0, 12).map((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    return li;
  }));
  if (git.changedFiles.length > 12) {
    const li = document.createElement('li');
    li.textContent = `… und ${git.changedFiles.length - 12} weitere`;
    list.appendChild(li);
  }

  dialog('Veröffentlichen', [
    p('Diese Änderungen gehen online:'),
    list,
    p('Kurze Beschreibung (optional):'),
    input,
  ], [
    button('Abbrechen', 'ghost', closeDialog),
    button('Jetzt veröffentlichen', 'publish', () => runPublish(input.value)),
  ]);
  input.focus();
  input.select();
}

async function runPublish(message) {
  const spinner = document.createElement('p');
  spinner.innerHTML = '<span class="spinner"></span>Wird veröffentlicht…';
  dialog('Veröffentlichen', [spinner, p('Das kann bei vielen Bildern eine Weile dauern.')], []);

  try {
    const result = await api('/api/publish', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    state.git = await api('/api/git');
    renderState();

    const body = [p('Die Änderungen sind auf GitHub. Die Website wird in ein bis zwei Minuten aktualisiert.')];
    if (state.git.remoteUrl) {
      const link = pagesUrl(state.git.remoteUrl);
      if (link) {
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = link;
        const wrap = document.createElement('p');
        wrap.append('Adresse: ', a);
        body.push(wrap);
      }
    }
    dialog('Veröffentlicht', body, [button('Fertig', 'primary', closeDialog)]);
  } catch (err) {
    dialog('Veröffentlichen fehlgeschlagen', [
      p('Die Änderungen sind lokal gespeichert, aber nicht online gegangen.'),
      pre(err.message),
      p('Bitte Sebastian Bescheid geben — die Arbeit ist nicht verloren.'),
    ], [button('Schließen', 'primary', closeDialog)]);
  }
}

function pagesUrl(remote) {
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (!m) return null;
  const [, owner, repo] = m;
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io`
    ? `https://${repo}`
    : `https://${owner}.github.io/${repo}/`;
}

async function discard() {
  dialog('Änderungen verwerfen?', [
    p('Alle Änderungen seit der letzten Veröffentlichung werden zurückgesetzt. Das lässt sich nicht rückgängig machen.'),
  ], [
    button('Abbrechen', 'ghost', closeDialog),
    button('Ja, verwerfen', 'publish', async () => {
      closeDialog();
      try {
        const result = await api('/api/discard', { method: 'POST' });
        state.git = result.git;
        dirty = false;
        el.preview.src = `/preview/${currentPage}`;
        renderState();
        toast('Änderungen verworfen');
      } catch (err) {
        toast(err.message, true);
      }
    }),
  ]);
}

/* ---------- API used by the editor inside the iframe ---------- */

window.CMSAdmin = {
  register(api) {
    editor = api;
    dirty = false;
    renderState();
  },
  /** The iframe navigated on its own (a link in the site's menu). */
  pageChanged(file) {
    if (file === currentPage) return;
    currentPage = file;
    dirty = false;
    renderPages();
    renderState();
  },
  setDirty() {
    if (dirty) return;
    dirty = true;
    renderState();
  },
  pickImage: openPicker,
  pickFocus,
  toast,
  hint(text) {
    el.hint.textContent = text || 'Klicke im Vorschaufenster auf einen Text oder ein Bild.';
  },
};

/* ---------- wiring ---------- */

el.save.addEventListener('click', save);
el.publish.addEventListener('click', publish);
el.discard.addEventListener('click', discard);
el.pickerClose.addEventListener('click', () => closePicker(null));
el.picker.addEventListener('click', (e) => { if (e.target === el.picker) closePicker(null); });
el.search.addEventListener('input', () => renderThumbs(el.search.value));
el.pickerFile.addEventListener('change', () => {
  const file = el.pickerFile.files[0];
  el.pickerFile.value = '';
  if (file) uploadFile(file);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  if (e.key === 'Escape') {
    if (!el.picker.hidden) closePicker(null);
    else if (!el.dialog.hidden) closeDialog();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

refreshState().catch((err) => toast(err.message, true));
