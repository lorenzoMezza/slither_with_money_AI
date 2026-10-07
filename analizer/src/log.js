const tty = process.stdout.isTTY;
const CODES = {
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, grey: 90, bold: 1,
};

export const color = (name, s) => (tty && CODES[name] ? `\x1b[${CODES[name]}m${s}\x1b[0m` : String(s));
export const bold = (s) => color('bold', s);

const time = () => new Date().toTimeString().slice(0, 8);

export const log = {
  raw: (s = '') => process.stdout.write(`${s}\n`),
  info: (s) => process.stdout.write(`${color('grey', time())} ${s}\n`),
  ok: (s) => process.stdout.write(`${color('grey', time())} ${color('green', '✓')} ${s}\n`),
  warn: (s) => process.stdout.write(`${color('grey', time())} ${color('yellow', '!')} ${s}\n`),
  error: (s) => process.stderr.write(`${color('grey', time())} ${color('red', '✗')} ${s}\n`),
  tag: (tag, s) => process.stdout.write(`${color('grey', time())} ${color('cyan', tag.padEnd(7))} ${s}\n`),
};

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function humanDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
