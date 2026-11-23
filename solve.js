// Fast drop-in for makefun-site 1.0.0 — byte-exact answers, built for speed.
// Same pipeline as the reference (index.js): readSources, frontMatter, permalinks,
// markdown, collections, tags, layouts, report. Every rule is the reference's;
// only the implementation is faster: index-based scanners instead of split+regex,
// bulk inline rendering instead of per-character escaping, flat template scopes
// instead of scope-chain walks, and cached slugify.

import { parseTemplate, TemplateError } from './template.js';

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
export function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const slugCache = new Map();
/** The slug of `text` (reference rule), cached per build. */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter
const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]\\]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(s, a, b) {
  for (let i = a; i < b; i++) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Index-based: no split of the whole text.
 */
export function parseFrontMatter(text) {
  // First line must be exactly '---'.
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (firstEnd !== 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-') return { error: 'no front matter' };
  // Find the closing '---' line.
  let pos = firstEnd + 1;
  let close = -1;
  let closeLineStart = -1;
  let lineNo = 1;
  let closeLineNo = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text[pos] === '-' && text[pos + 1] === '-' && text[pos + 2] === '-') {
      close = end;
      closeLineStart = pos;
      closeLineNo = lineNo;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Parse the lines between (line numbers counted from 1 at the opening '---').
  pos = firstEnd + 1;
  let ln = 1;
  while (pos < closeLineStart) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? closeLineStart : nl;
    ln++;
    const line = text.slice(pos, end);
    if (line !== '' && !isBlankLine(text, pos, end) && line.charCodeAt(0) !== 35) {
      // Must be "key: value": key of [a-z_]+, ':', then ' ' + value or nothing.
      const colon = line.indexOf(':');
      if (colon <= 0) return { error: `line ${ln} is not "key: value"` };
      let ok = true;
      for (let i = 0; i < colon; i++) {
        const c = line.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || c === 95)) { ok = false; break; }
      }
      if (!ok) return { error: `line ${ln} is not "key: value"` };
      const key = line.slice(0, colon);
      let raw;
      if (colon + 1 === line.length) raw = '';
      else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
      else return { error: `line ${ln} is not "key: value"` };
      // Trailing spaces/tabs dropped.
      let r = raw.length;
      while (r > 0) { const c = raw.charCodeAt(r - 1); if (c !== 32 && c !== 9) break; r--; }
      raw = raw.slice(0, r);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1 || nl >= closeLineStart) break;
    pos = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(close + 1) };
}

// ---------------------------------------------------------------- markdown
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline (reference rule); bulk scan instead of per-character escaping. */
export function inline(s, env) {
  const re = /[\\`*\[&<>"']/g;
  let out = '';
  let i = 0;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const at = m.index;
    if (at < i) continue;
    if (at > last) out += s.slice(last, at).replace(ESC_RE, (c) => ESCAPES[c]);
    const c = s[at];
    if (c === '\\') {
      if (at + 1 < s.length && ESCAPABLE.has(s[at + 1])) {
        out += ESCAPES[s[at + 1]] ?? s[at + 1];
        i = at + 2;
      } else {
        out += '\\';
        i = at + 1;
      }
    } else if (c === '`') {
      const j = s.indexOf('`', at + 1);
      if (j > at + 1) {
        out += `<code>${s.slice(at + 1, j).replace(ESC_RE, (x) => ESCAPES[x])}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i = at + 1;
      }
    } else if (c === '*') {
      if (s[at + 1] === '*') {
        const j = findUnescaped(s, '**', at + 2);
        if (j > at + 2) {
          out += `<strong>${inline(s.slice(at + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i = at + 2;
        }
      } else {
        const j = findSingleStar(s, at + 1);
        if (j > at + 1) {
          out += `<em>${inline(s.slice(at + 1, j), env)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i = at + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', at + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(at + 1, k), env)}</a>`;
        i = mm + 1;
      } else {
        out += '[';
        i = at + 1;
      }
    } else {
      out += ESCAPES[c];
      i = at + 1;
    }
    last = i;
    re.lastIndex = i;
  }
  if (last < s.length) out += s.slice(last).replace(ESC_RE, (c) => ESCAPES[c]);
  return out;
}

const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

function lineIsBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}
function fenceOpenOf(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return null; j++; }
  return lang;
}
function fenceCloseOf(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}
function headingOfLine(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}
function hrOf(line) {
  if (line.length < 3) return false;
  const p = (line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) ||
    (line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42);
  if (!p) return false;
  for (let j = 3; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}
function endsParagraph(line) {
  return lineIsBlank(line) || fenceOpenOf(line) !== null || headingOfLine(line) !== null || hrOf(line);
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt (reference rule).
 * Single fused pass over the source; no token array, no split, no per-line regex.
 */
export function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let i = 0;
  while (i < n) {
    let e = src.indexOf('\n', i);
    if (e === -1) e = n;
    const line = src.slice(i, e);
    const next = e + 1;
    if (lineIsBlank(line)) { i = next; continue; }
    const fenceLang = fenceOpenOf(line);
    if (fenceLang !== null) {
      const body = [];
      i = next;
      while (i < n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(i, e2);
        if (fenceCloseOf(l2)) { i = e2 + 1; break; }
        body.push(l2);
        i = e2 + 1;
        if (i >= n) break;
      }
      if (i >= n && body.length > 0) { /* fence runs to the end */ }
      const cls = fenceLang === '' ? '' : ` class="language-${escapeHtml(fenceLang)}"`;
      const fenced = body.length === 0 ? '' : body.join('\n') + '\n';
      blocks.push(`<pre><code${cls}>${escapeHtml(fenced)}</code></pre>`);
      continue;
    }
    const heading = headingOfLine(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i = next;
      continue;
    }
    if (hrOf(line)) {
      blocks.push('<hr>');
      i = next;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(i, e2);
        if (l2.charCodeAt(0) !== 62) break;
        body.push(l2.charCodeAt(1) === 32 ? l2.slice(2) : l2.slice(1));
        i = e2 + 1;
        if (i >= n) break;
      }
      const lines = body.map(trimLine).filter((l) => l !== '');
      blocks.push(lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(lines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // List?
    let isOrdered = false;
    let start = 1;
    let firstText = null;
    {
      const c0 = line.charCodeAt(0);
      if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
        firstText = line.slice(2);
      } else {
        let d = 0;
        while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
        if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
          isOrdered = true;
          start = Number(line.slice(0, d));
          firstText = line.slice(d + 2);
        }
      }
    }
    if (firstText !== null) {
      const items = [[trimLine(firstText)]];
      i = next;
      while (i < n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(i, e2);
        let mText = null;
        let mOrd = false;
        if (isOrdered) {
          let d = 0;
          while (d < l2.length && l2.charCodeAt(d) >= 48 && l2.charCodeAt(d) <= 57) d++;
          if (d >= 1 && d <= 9 && l2.charCodeAt(d) === 46 && l2.charCodeAt(d + 1) === 32) { mOrd = true; mText = l2.slice(d + 2); }
        } else {
          const c0 = l2.charCodeAt(0);
          if ((c0 === 45 || c0 === 42) && l2.charCodeAt(1) === 32) mText = l2.slice(2);
        }
        if (mText !== null) {
          items.push([trimLine(mText)]);
          i = e2 + 1;
          continue;
        }
        // Continued line: 2+ spaces then a non-space, non-tab.
        let sp = 0;
        while (sp < l2.length && l2.charCodeAt(sp) === 32) sp++;
        if (sp >= 2 && sp < l2.length && l2.charCodeAt(sp) !== 9) {
          items[items.length - 1].push(trimLine(l2));
          i = e2 + 1;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    // Paragraph.
    const body = [trimLine(line)];
    i = next;
    while (i < n) {
      let e2 = src.indexOf('\n', i);
      if (e2 === -1) e2 = n;
      const l2 = src.slice(i, e2);
      if (endsParagraph(l2)) break;
      body.push(trimLine(l2));
      i = e2 + 1;
    }
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates
const INCLUDE_DEPTH = 8;

function lookup(vars, path) {
  if (!Object.hasOwn(vars, path[0])) return undefined;
  let v = vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered with flat scopes (each loop copies the visible names plus its
 * own bindings — the same names the reference's scope chain would find) into `out`.
 */
export function renderNodes(nodes, vars, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(vars, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(vars, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(vars, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, vars, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(vars, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const v2 = Object.create(null);
          Object.assign(v2, vars);
          v2[n.name] = xs[k];
          v2.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, v2, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, vars, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the pipeline
const WS_TABLE = new Uint8Array(0x10000);
for (const c of [32, 9, 10, 13, 11, 12, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

function tags(b) {
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, vars, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site, tags: allTags, recent,
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { site, tags: allTags, recent, tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

export const PIPELINE = Object.freeze([readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report]);

/** One site's output tree: path -> text. */
export function build(input) {
  slugCache.clear();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
