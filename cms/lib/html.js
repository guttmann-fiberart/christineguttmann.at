'use strict';

/* Minimal HTML parser that keeps byte offsets for every node.
 *
 * The CMS never re-serialises a whole file: it locates the exact source range
 * of the thing that changed (an element's inner content, an attribute value,
 * a list item) and splices only those bytes. That keeps git diffs limited to
 * what the editor actually touched and leaves all hand-written formatting,
 * indentation and entities intact. */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Elements whose content is raw text, not markup.
const RAW = new Set(['script', 'style', 'textarea', 'title']);

// Tags that auto-close a previous sibling of the same kind.
const CLOSED_BY_SIBLING = { li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'] };

// A <p> is closed by any of these starting.
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

class ParseError extends Error {}

/* ---------- tokenizer ---------- */

function readAttrs(src, from, to) {
  const attrs = [];
  let i = from;
  while (i < to) {
    while (i < to && /[\s/]/.test(src[i])) i++;
    if (i >= to) break;

    const nameStart = i;
    while (i < to && !/[\s=/>]/.test(src[i])) i++;
    const name = src.slice(nameStart, i);
    if (!name) { i++; continue; }

    let j = i;
    while (j < to && /\s/.test(src[j])) j++;

    if (src[j] !== '=') {
      attrs.push({ name, value: '', valueStart: -1, valueEnd: -1, quote: '', nameStart, nameEnd: i });
      continue;
    }

    j++;
    while (j < to && /\s/.test(src[j])) j++;

    const q = src[j];
    if (q === '"' || q === "'") {
      const vs = j + 1;
      const ve = src.indexOf(q, vs);
      if (ve === -1 || ve > to) throw new ParseError(`Unterminated attribute value for "${name}"`);
      attrs.push({ name, value: src.slice(vs, ve), valueStart: vs, valueEnd: ve, quote: q, nameStart, nameEnd: i });
      i = ve + 1;
    } else {
      const vs = j;
      while (j < to && !/[\s>]/.test(src[j])) j++;
      attrs.push({ name, value: src.slice(vs, j), valueStart: vs, valueEnd: j, quote: '', nameStart, nameEnd: i });
      i = j;
    }
  }
  return attrs;
}

/** Find the '>' that ends an open tag, skipping quoted attribute values. */
function findTagEnd(src, from) {
  let i = from;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
    i++;
  }
  return -1;
}

/* ---------- parser ---------- */

/**
 * Parse `src` into a tree of nodes carrying source offsets.
 *
 * element: { type, name, attrs, tagStart, tagEnd, innerStart, innerEnd, nodeEnd, children, parent }
 *   tagStart   index of '<'
 *   tagEnd     index just past the open tag's '>'
 *   innerStart index of first inner byte (=== tagEnd), null for void elements
 *   innerEnd   index just past the last inner byte (start of '</name>')
 *   nodeEnd    index just past the close tag
 */
function parse(src) {
  const root = { type: 'root', name: '#root', children: [], parent: null, innerStart: 0, innerEnd: src.length };
  const stack = [root];
  let i = 0;

  const top = () => stack[stack.length - 1];
  const addChild = (node) => { node.parent = top(); top().children.push(node); };

  // Close every open element down to `index`. Only the element that owns the
  // close tag gets the real nodeEnd; implicitly-closed ancestors end where the
  // close tag starts.
  const closeTo = (index, innerEnd, nodeEnd) => {
    for (let k = stack.length - 1; k >= index; k--) {
      stack[k].innerEnd = innerEnd;
      stack[k].nodeEnd = k === index ? nodeEnd : innerEnd;
    }
    stack.length = index;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (i < src.length) addChild({ type: 'text', start: i, end: src.length });
      break;
    }
    if (lt > i) addChild({ type: 'text', start: i, end: lt });

    // comment
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      const stop = e === -1 ? src.length : e + 3;
      addChild({ type: 'comment', start: lt, end: stop });
      i = stop;
      continue;
    }
    // doctype / processing instruction
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const e = src.indexOf('>', lt);
      const stop = e === -1 ? src.length : e + 1;
      addChild({ type: 'doctype', start: lt, end: stop });
      i = stop;
      continue;
    }
    // close tag
    if (src.startsWith('</', lt)) {
      const e = src.indexOf('>', lt);
      if (e === -1) throw new ParseError(`Unterminated close tag at ${lt}`);
      const name = src.slice(lt + 2, e).trim().toLowerCase();
      let found = -1;
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].name === name) { found = k; break; }
      }
      if (found !== -1) closeTo(found, lt, e + 1);
      i = e + 1;
      continue;
    }

    // open tag
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(src.slice(lt + 1, lt + 60));
    if (!nameMatch) {                     // a stray '<' in text
      addChild({ type: 'text', start: lt, end: lt + 1 });
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const gt = findTagEnd(src, lt + 1 + name.length);
    if (gt === -1) throw new ParseError(`Unterminated tag <${name}> at ${lt}`);

    const selfClosing = src[gt - 1] === '/';
    const attrs = readAttrs(src, lt + 1 + name.length, selfClosing ? gt - 1 : gt);

    // implicit closes
    if (top().name === 'p' && CLOSES_P.has(name)) closeTo(stack.length - 1, lt, lt);
    const sib = CLOSED_BY_SIBLING[top().name];
    if (sib && sib.includes(name)) closeTo(stack.length - 1, lt, lt);

    const node = {
      type: 'element',
      name,
      attrs,
      tagStart: lt,
      tagEnd: gt + 1,
      innerStart: null,
      innerEnd: null,
      nodeEnd: gt + 1,
      children: [],
      parent: null,
    };
    addChild(node);

    if (VOID.has(name) || selfClosing) { i = gt + 1; continue; }

    node.innerStart = gt + 1;

    if (RAW.has(name)) {
      const close = src.toLowerCase().indexOf(`</${name}`, gt + 1);
      const innerEnd = close === -1 ? src.length : close;
      if (innerEnd > gt + 1) node.children.push({ type: 'text', start: gt + 1, end: innerEnd, parent: node });
      node.innerEnd = innerEnd;
      const ce = close === -1 ? src.length : src.indexOf('>', close) + 1;
      node.nodeEnd = ce;
      i = ce;
      continue;
    }

    stack.push(node);
    i = gt + 1;
  }

  // anything still open runs to EOF
  closeTo(1, src.length, src.length);
  return root;
}

/* ---------- helpers ---------- */

function attr(node, name) {
  if (node.type !== 'element') return null;
  return node.attrs.find((a) => a.name.toLowerCase() === name) || null;
}

function attrValue(node, name) {
  const a = attr(node, name);
  return a ? a.value : null;
}

function elementChildren(node) {
  return (node.children || []).filter((c) => c.type === 'element');
}

function walk(node, fn) {
  for (const child of node.children || []) {
    if (child.type === 'element') {
      fn(child);
      walk(child, fn);
    }
  }
}

/** All elements carrying a data-cms="…" marker. */
function findRegions(src) {
  const root = parse(src);
  const regions = [];
  walk(root, (el) => {
    const id = attrValue(el, 'data-cms');
    if (id) {
      regions.push({
        id,
        kind: attrValue(el, 'data-cms-kind') || 'rich',
        label: attrValue(el, 'data-cms-label') || id,
        global: attr(el, 'data-cms-global') !== null,
        node: el,
      });
    }
  });
  return { root, regions };
}

/**
 * Resolve a path of element-child indices, starting at `node`.
 * The browser walks the same indices over its DOM, so both sides agree.
 */
function resolvePath(node, path) {
  let cur = node;
  for (const idx of path) {
    const kids = elementChildren(cur);
    if (idx < 0 || idx >= kids.length) return null;
    cur = kids[idx];
  }
  return cur;
}

/** Apply {start, end, text} splices to a string. */
function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].end > sorted[k - 1].start) {
      throw new ParseError('Overlapping edits — refusing to write');
    }
  }
  let out = src;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Indentation (spaces/tabs) of the line containing `index`. */
function indentAt(src, index) {
  const lineStart = src.lastIndexOf('\n', index - 1) + 1;
  const m = /^[ \t]*/.exec(src.slice(lineStart, index));
  return m ? m[0] : '';
}

function detectEol(src) {
  return src.includes('\r\n') ? '\r\n' : '\n';
}

module.exports = {
  parse, findRegions, resolvePath, applyEdits,
  attr, attrValue, elementChildren, walk,
  indentAt, detectEol, ParseError, VOID,
};
