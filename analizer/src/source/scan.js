/**
 * Un lettore lessicale minimo per JavaScript: distingue codice, stringhe,
 * template, commenti e regex. Basta per due cose che le espressioni regolari
 * da sole sbagliano — trovare la graffa che chiude un blocco, e riformattare
 * un file minificato — senza dipendere da un parser esterno.
 */

const REGEX_PREV = new Set([...'(,=:[!&|?{};+-*%<>~^', '']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof', 'yield', 'await']);

/**
 * Percorre `src` da `start` e chiama `onCode(i, ch)` per ogni carattere di
 * codice vero (fuori da stringhe, commenti e regex). Se `onCode` restituisce
 * un numero, la scansione si ferma e lo restituisce.
 */
export function walk(src, start, onCode) {
  let i = start;
  let lastSig = '';      // ultimo carattere significativo di codice
  let lastWord = '';
  const n = src.length;
  const tplStack = [];   // profondita' delle graffe dentro ${ } dei template
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { i = skipString(src, i, c); lastSig = c; lastWord = ''; continue; }
    if (c === '`') { const r = skipTemplate(src, i, tplStack); i = r; lastSig = '`'; lastWord = ''; continue; }
    if (c === '}' && tplStack.length && tplStack[tplStack.length - 1] === 0) {
      tplStack.pop();
      i = skipTemplate(src, i, tplStack, true);
      lastSig = '`';
      continue;
    }
    if (c === '/' && (REGEX_PREV.has(lastSig) || REGEX_KEYWORDS.has(lastWord))) {
      i = skipRegex(src, i);
      lastSig = '/';
      lastWord = '';
      continue;
    }
    if (tplStack.length) {
      if (c === '{') tplStack[tplStack.length - 1] += 1;
      else if (c === '}') tplStack[tplStack.length - 1] -= 1;
    }
    const r = onCode(i, c);
    if (typeof r === 'number') return r;
    if (/[A-Za-z0-9_$]/.test(c)) {
      lastWord = /[A-Za-z0-9_$]/.test(src[i - 1] ?? '') ? lastWord + c : c;
      lastSig = c;
    } else if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
    i += 1;
  }
  return -1;
}

function skipString(src, i, q) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === q || src[j] === '\n') return j + 1;
    j += 1;
  }
  return j;
}

/** Salta un template fino al backtick finale o fino a un `${` (che apre codice). */
function skipTemplate(src, i, stack, resume = false) {
  let j = resume ? i + 1 : i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === '`') return j + 1;
    if (src[j] === '$' && src[j + 1] === '{') { stack.push(0); return j + 2; }
    j += 1;
  }
  return j;
}

function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return j;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j += 1; while (/[a-z]/i.test(src[j] ?? '')) j += 1; return j; }
    j += 1;
  }
  return j;
}

/** Indice della graffa che chiude quella aperta in `open` (o -1). */
export function matchBrace(src, open) {
  let depth = 0;
  return walk(src, open, (i, c) => {
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i; }
    return undefined;
  });
}

/** Il blocco `{...}` che segue `from`, testo compreso. */
export function blockAfter(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  const close = matchBrace(src, open);
  return close < 0 ? null : { open, close, text: src.slice(open, close + 1) };
}

/**
 * Riformatta un file minificato: un'istruzione per riga, rientri secondo le
 * graffe. Non e' un pretty-printer completo — non tocca le espressioni — ma
 * rende leggibile e cercabile per riga un bundle da 50 KB su una riga sola.
 */
export function beautify(src) {
  const out = [];
  let line = '';
  let depth = 0;
  let paren = 0;
  let last = 0;
  const flush = () => {
    const t = line.trim();
    if (t) out.push(`${'  '.repeat(Math.max(0, depth))}${t}`);
    line = '';
  };
  walk(src, 0, (i, c) => {
    line += src.slice(last, i);
    last = i + 1;
    if (c === '\n') { flush(); return undefined; }
    if (c === '(') paren += 1;
    else if (c === ')') paren = Math.max(0, paren - 1);
    if (c === '{') { line += c; flush(); depth += 1; return undefined; }
    if (c === '}') { flush(); depth = Math.max(0, depth - 1); line = c; const nx = src[i + 1]; if (nx !== ',' && nx !== ';' && nx !== ')' && nx !== '.' && nx !== '(') flush(); return undefined; }
    if (c === ';' && paren === 0) { line += c; flush(); return undefined; }
    line += c;
    return undefined;
  });
  line += src.slice(last);
  flush();
  return `${out.join('\n')}\n`;
}

/** Numero di riga (1-based) di un offset. */
export function lineOf(src, index, cache) {
  let starts = cache?.starts;
  if (!starts) {
    starts = [0];
    for (let i = 0; i < src.length; i += 1) if (src.charCodeAt(i) === 10) starts.push(i + 1);
    if (cache) cache.starts = starts;
  }
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
