// SVG path data -> absolute M/L/C/Z (export.js pathSegs). Runs in plain Node: export.js only touches the DOM when measuring.
import fs from 'node:fs';

globalThis.window = globalThis;
(0, eval)(fs.readFileSync(new URL('../ppt/export.js', import.meta.url), 'utf8'));
const { pathSegs } = window.PPTExport;

let pass = 0, total = 0;
const ok = (name, cond, info = '') => { total++; if (cond) pass++; else console.log(`FAIL ${name} ${info}`); };
const near = (a, b) => a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s.length === b[i].length && s.slice(1).every((v, j) => Math.abs(v - b[i][j + 1]) < 1e-6));
const t = (name, got, want) => ok(name, near(got, want), JSON.stringify(got));

try {
  t('absolute and relative lines', pathSegs('M10 10 h20 v10 l-5 5 H0 Z'), [['M', 10, 10], ['L', 30, 10], ['L', 30, 20], ['L', 25, 25], ['L', 0, 25], ['Z']]);
  t('implicit lineto after moveto', pathSegs('m1 1 2 0 0 2z'), [['M', 1, 1], ['L', 3, 1], ['L', 3, 3], ['Z']]);
  t('after Z the pen is back at the subpath start', pathSegs('M5 5 L9 5 Z l1 1'), [['M', 5, 5], ['L', 9, 5], ['Z'], ['L', 6, 6]]);
  t('quadratic becomes cubic', pathSegs('M0 0 Q3 3 6 0'), [['M', 0, 0], ['C', 2, 2, 4, 2, 6, 0]]);
  t('smooth cubic reflects the last control point', pathSegs('M0 0 C1 1 2 1 3 0 S5 -1 6 0'), [['M', 0, 0], ['C', 1, 1, 2, 1, 3, 0], ['C', 4, -1, 5, -1, 6, 0]]);
  t('compact numbers', pathSegs('M.5.5L1e1-2'), [['M', 0.5, 0.5], ['L', 10, -2]]);
  const arc = pathSegs('M0 0 A10 10 0 0 1 20 0'); // a half circle of radius 10
  ok('arc splits into ≤90° cubics', arc.length === 3 && arc.slice(1).every((s) => s[0] === 'C'), JSON.stringify(arc));
  ok('arc ends at its end point', arc.length === 3 && Math.abs(arc[2][5] - 20) < 1e-6 && Math.abs(arc[2][6]) < 1e-6, JSON.stringify(arc));
  ok('arc passes through the circle top', arc.length === 3 && Math.abs(arc[1][5] - 10) < 1e-6 && Math.abs(Math.abs(arc[1][6]) - 10) < 1e-6, JSON.stringify(arc));
  t('zero-radius arc is a line', pathSegs('M0 0 A0 5 0 0 1 4 4'), [['M', 0, 0], ['L', 4, 4]]);
  t('garbage stops parsing, keeps what came before', pathSegs('M0 0 L5 5 X 9 9'), [['M', 0, 0], ['L', 5, 5]]);
  t('empty', pathSegs(''), []);
} catch (e) { ok('script ran to the end', false, e.stack); }
console.log(`${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
