'use strict';

/* Turns editor operations into byte-level splices against a page's source.
 *
 * Three operations cover everything the editor can do:
 *   setInner  { path, html }              replace an element's inner content
 *   setAttr   { path, name, value }       set one attribute value
 *   setItems  { items: [{ref|clone, edits}] }
 *                                         reorder / duplicate / delete the
 *                                         direct children of a list region
 *
 * `path` is a list of element-child indices relative to the region root, so
 * the browser can address nodes by walking the same indices over its DOM. */

const H = require('./html');

const FORBIDDEN_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base']);

class PatchError extends Error {}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Reject markup the editor should never produce. */
function assertSafeHtml(html, what) {
  const root = H.parse(html);
  H.walk(root, (el) => {
    if (FORBIDDEN_TAGS.has(el.name)) {
      throw new PatchError(`${what}: <${el.name}> is not allowed in page content`);
    }
    for (const a of el.attrs) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) throw new PatchError(`${what}: event handler "${a.name}" is not allowed`);
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(a.value)) {
        throw new PatchError(`${what}: javascript: URLs are not allowed`);
      }
    }
  });
}

/** Absolute source edit for one op, resolved against `base`. */
function opToEdit(src, base, op, label) {
  const target = H.resolvePath(base, op.path || []);
  if (!target) throw new PatchError(`${label}: path [${(op.path || []).join(',')}] does not exist`);

  if (op.op === 'setItems') {
    // Nested list (e.g. the photo gallery inside one exhibition).
    return buildItems(src, target, op.items || [], label);
  }

  if (op.op === 'setInner') {
    if (target.innerStart === null) throw new PatchError(`${label}: <${target.name}> cannot hold content`);
    const html = String(op.html ?? '');
    assertSafeHtml(html, label);
    return { start: target.innerStart, end: target.innerEnd, text: html };
  }

  if (op.op === 'setAttr') {
    const name = String(op.name || '');
    if (!/^[a-zA-Z][\w:-]*$/.test(name)) throw new PatchError(`${label}: bad attribute name "${name}"`);
    if (name.toLowerCase().startsWith('on')) throw new PatchError(`${label}: event handlers are not allowed`);
    const value = String(op.value ?? '');
    if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
      throw new PatchError(`${label}: javascript: URLs are not allowed`);
    }

    const existing = H.attr(target, name);
    if (existing && existing.valueStart !== -1) {
      return { start: existing.valueStart, end: existing.valueEnd, text: escapeAttr(value) };
    }
    if (existing) {
      // valueless attribute -> give it a value
      return { start: existing.nameStart, end: existing.nameEnd, text: `${name}="${escapeAttr(value)}"` };
    }
    // insert before the '>' of the open tag
    const selfClosing = src[target.tagEnd - 2] === '/';
    const at = target.tagEnd - (selfClosing ? 2 : 1);
    return { start: at, end: at, text: ` ${name}="${escapeAttr(value)}"` };
  }

  throw new PatchError(`${label}: unknown operation "${op.op}"`);
}

/** Rebuild a list region's inner content from item references. */
function buildItems(src, region, spec, label) {
  const originals = H.elementChildren(region);
  if (!originals.length) throw new PatchError(`${label}: list has no items to work from`);

  const eol = H.detectEol(src);
  const itemIndent = H.indentAt(src, originals[0].tagStart);
  const closeIndent = H.indentAt(src, region.innerEnd);

  const pieces = spec.map((entry, n) => {
    const idx = entry.ref !== undefined ? entry.ref : entry.clone;
    if (typeof idx !== 'number' || idx < 0 || idx >= originals.length) {
      throw new PatchError(`${label}: item ${n} references unknown index ${idx}`);
    }
    const item = originals[idx];
    let text = src.slice(item.tagStart, item.nodeEnd);

    const edits = (entry.edits || []).map((op, k) => {
      const e = opToEdit(src, item, op, `${label} item ${n}.${k}`);
      return { start: e.start - item.tagStart, end: e.end - item.tagStart, text: e.text };
    });
    if (edits.length) text = H.applyEdits(text, edits);
    return text;
  });

  const inner = eol + itemIndent + pieces.join(eol + itemIndent) + eol + closeIndent;
  return { start: region.innerStart, end: region.innerEnd, text: inner };
}

/**
 * Apply `regionOps` ({ regionId: [op, …] }) to `src`.
 * Returns the new source, or throws PatchError.
 */
function applyOps(src, regionOps) {
  const { regions } = H.findRegions(src);
  const byId = new Map(regions.map((r) => [r.id, r]));
  const edits = [];

  for (const [regionId, ops] of Object.entries(regionOps)) {
    const region = byId.get(regionId);
    if (!region) throw new PatchError(`unknown region "${regionId}"`);

    const topLevelItems = ops.filter((o) => o.op === 'setItems' && !(o.path || []).length);
    if (topLevelItems.length && ops.length > 1) {
      throw new PatchError(`${regionId}: a full setItems must be the only operation`);
    }

    for (const [k, op] of ops.entries()) {
      edits.push(opToEdit(src, region.node, op, `${regionId} op ${k}`));
    }
  }

  const out = H.applyEdits(src, edits);
  verify(src, out);
  return out;
}

/** Refuse to write anything that lost a region or stopped parsing cleanly. */
function verify(before, after) {
  let parsed;
  try {
    parsed = H.findRegions(after);
  } catch (err) {
    throw new PatchError(`result does not parse (${err.message})`);
  }

  const idsBefore = H.findRegions(before).regions.map((r) => r.id).sort();
  const idsAfter = parsed.regions.map((r) => r.id).sort();
  if (idsBefore.join('|') !== idsAfter.join('|')) {
    throw new PatchError('result is missing editable regions — write aborted');
  }

  for (const tag of ['</body>', '</html>']) {
    if (!after.includes(tag)) throw new PatchError(`result lost ${tag} — write aborted`);
  }

  H.walk(parsed.root, (el) => {
    if (el.innerStart === null) return;
    const tail = after.slice(el.innerEnd, el.nodeEnd);
    if (tail !== `</${el.name}>`) {
      throw new PatchError(`unbalanced <${el.name}> in result — write aborted`);
    }
  });
}

module.exports = { applyOps, assertSafeHtml, PatchError };
