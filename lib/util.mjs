import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Error whose message is meant for the user verbatim (no stack trace). */
export class UserError extends Error {}

export const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/** Flatten a JSON:API resource into { id, type, ...attributes }. */
export const flat = (r) => (r ? { id: r.id, type: r.type, ...r.attributes } : null);

/** Build a JSON:API resource payload. rels: { name: [type, id] | [type, [ids]] | null }. */
export function payload(type, attributes, rels, id) {
  const out = { type };
  if (id) out.id = id;
  if (attributes) out.attributes = attributes;
  if (rels) {
    out.relationships = {};
    for (const [name, v] of Object.entries(rels)) {
      if (v === null) out.relationships[name] = { data: null };
      else if (Array.isArray(v[1])) out.relationships[name] = { data: v[1].map((i) => ({ type: v[0], id: i })) };
      else out.relationships[name] = { data: { type: v[0], id: v[1] } };
    }
  }
  return { data: out };
}

/** Drop undefined/null-free keys so PATCH bodies only carry what the user passed. */
export const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export const PLATFORMS = { ios: 'IOS', macos: 'MAC_OS', mac_os: 'MAC_OS', tvos: 'TV_OS', tv_os: 'TV_OS', visionos: 'VISION_OS', vision_os: 'VISION_OS' };
export function normPlatform(p) {
  if (!p) return undefined;
  const k = String(p).toLowerCase();
  return PLATFORMS[k] ?? String(p).toUpperCase();
}

export function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

/** Parse repeated "key=value" strings into an object with coerced values. */
export function parseKV(list) {
  const out = {};
  for (const item of [].concat(list ?? [])) {
    const i = String(item).indexOf('=');
    if (i < 1) throw new UserError(`Expected key=value, got "${item}"`);
    out[item.slice(0, i)] = coerce(item.slice(i + 1));
  }
  return out;
}

/** Read a value from --x or --x-file. */
export function textFlag(flags, name) {
  if (flags[name] !== undefined) return String(flags[name]);
  const f = flags[`${name}-file`];
  if (f) return fs.readFileSync(expandHome(f), 'utf8').replace(/\s+$/, '');
  return undefined;
}

export const csv = (v) => (v === undefined ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));

// ---------------------------------------------------------------- output

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (n) => (s) => (C ? `\x1b[${n}m${s}\x1b[0m` : String(s));
export const color = { red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), dim: paint(2), bold: paint(1) };

const cell = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Render rows as an aligned text table. cols: [header, key | (row)=>value]. */
export function table(rows, cols) {
  if (!rows.length) return color.dim('(none)');
  const data = rows.map((r) => cols.map(([, k]) => cell(typeof k === 'function' ? k(r) : r[k])));
  const widths = cols.map(([h], i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [color.bold(line(cols.map(([h]) => h))), ...data.map(line)].join('\n');
}

export function printKV(obj) {
  const keys = Object.keys(obj);
  const w = Math.max(...keys.map((k) => k.length));
  for (const k of keys) console.log(`${color.bold(k.padEnd(w))}  ${cell(obj[k])}`);
}

/** Print as JSON when --json was passed, otherwise via the human renderer. */
export function emit(ctx, data, human) {
  if (ctx.flags.json) console.log(JSON.stringify(data, null, 2));
  else human();
}

export const shortDate = (s) => (s ? String(s).replace('T', ' ').replace(/(\.\d+)?([+-]\d\d:\d\d|Z)$/, '') : '');

// ---------------------------------------------------------------- processes

/** Run a process, streaming output; resolves with exit code (rejects only on spawn error). */
export function run(cmd, args, { env, cwd, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    if (capture) {
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
    }
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out }));
  });
}

export async function runOrThrow(cmd, args, opts) {
  const { code, out } = await run(cmd, args, opts);
  if (code !== 0) throw new UserError(`${cmd} ${args[0] ?? ''} failed with exit code ${code}${out ? `\n${out.trim().split('\n').slice(-15).join('\n')}` : ''}`);
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
