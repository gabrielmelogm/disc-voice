#!/usr/bin/env node
// Aplica uma versão em todos os manifestos do projeto e no README:
//   - package.json da raiz e dos workspaces (+ package-lock.json)
//   - tauri.conf.json dos apps
//   - Cargo.toml dos membros do workspace Rust (+ Cargo.lock)
//   - README.md (texto e badges do shields.io)
// A versão antiga é a do package.json da raiz. Edita por regex para manter a
// formatação e as quebras de linha (CRLF) de cada arquivo.
//
// Uso: node bump-version.mjs --version 0.1.0-alpha.1 [--dry-run]

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const argv = process.argv.slice(2);
const next = argv[argv.indexOf('--version') + 1];
const dryRun = argv.includes('--dry-run');
if (!argv.includes('--version') || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next ?? '')) {
  console.error('Uso: node bump-version.mjs --version X.Y.Z[-pre] [--dry-run]');
  process.exit(1);
}

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), 'utf8');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rootPkg = JSON.parse(read('package.json'));
const prev = rootPkg.version;
if (prev === next) {
  console.error(`O projeto já está na versão ${next}.`);
  process.exit(1);
}

const changes = new Map(); // caminho -> novo conteúdo
function edit(path, fn) {
  const before = changes.get(path) ?? read(path);
  const after = fn(before);
  if (after === before) throw new Error(`Nada mudou em ${path} (a versão ${prev} não foi encontrada).`);
  changes.set(path, after);
}

// Expande "apps/*" etc. (só o glob de um nível que o projeto usa).
function expand(pattern) {
  if (!pattern.endsWith('/*')) return [pattern];
  const dir = pattern.slice(0, -2);
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => posix.join(dir, d.name));
}

// ---------- npm ----------
const versionField = (s) => s.replace(new RegExp(`("version"\\s*:\\s*")${esc(prev)}(")`), `$1${next}$2`);
const npmDirs = (rootPkg.workspaces ?? []).flatMap(expand).filter((d) => existsSync(join(root, d, 'package.json')));
edit('package.json', versionField);
const npmEntries = [{ key: '', name: rootPkg.name }];
for (const dir of npmDirs) {
  const pkg = JSON.parse(read(`${dir}/package.json`));
  if (pkg.version !== prev) continue; // pacote com versão própria: não mexe
  edit(`${dir}/package.json`, versionField);
  npmEntries.push({ key: dir, name: pkg.name });

  const tauri = `${dir}/src-tauri/tauri.conf.json`;
  if (existsSync(join(root, tauri)) && JSON.parse(read(tauri)).version === prev) edit(tauri, versionField);
}
if (existsSync(join(root, 'package-lock.json'))) {
  edit('package-lock.json', (s) => {
    // Raiz do lock + cada entrada "packages[<workspace>]".
    s = s.replace(new RegExp(`^(\\s*"version"\\s*:\\s*")${esc(prev)}(")`, 'm'), `$1${next}$2`);
    for (const { key, name } of npmEntries) {
      s = s.replace(
        new RegExp(`("${esc(key)}"\\s*:\\s*\\{\\s*"name"\\s*:\\s*"${esc(name)}",\\s*"version"\\s*:\\s*")${esc(prev)}(")`),
        `$1${next}$2`,
      );
    }
    return s;
  });
}

// ---------- Cargo ----------
if (existsSync(join(root, 'Cargo.toml'))) {
  const ws = read('Cargo.toml');
  const members = [...(/members\s*=\s*\[([^\]]*)\]/.exec(ws)?.[1] ?? '').matchAll(/"([^"]+)"/g)].flatMap((m) => expand(m[1]));
  const crates = [];
  for (const dir of members) {
    const path = `${dir}/Cargo.toml`;
    if (!existsSync(join(root, path))) continue;
    const toml = read(path);
    const pkg = /\[package\]([\s\S]*?)(?:\r?\n\[|$)/.exec(toml)?.[1] ?? '';
    const name = /^name\s*=\s*"([^"]+)"/m.exec(pkg)?.[1];
    if (/^version\s*=\s*"([^"]+)"/m.exec(pkg)?.[1] !== prev) continue;
    // Só a primeira linha `version = ` depois de [package].
    edit(path, (s) => s.replace(new RegExp(`(\\[package\\][\\s\\S]*?^version\\s*=\\s*")${esc(prev)}(")`, 'm'), `$1${next}$2`));
    crates.push(name);
  }
  if (crates.length && existsSync(join(root, 'Cargo.lock'))) {
    edit('Cargo.lock', (s) => {
      for (const name of crates) {
        s = s.replace(new RegExp(`(name = "${esc(name)}"\\r?\\nversion = ")${esc(prev)}(")`), `$1${next}$2`);
      }
      return s;
    });
  }
}

// ---------- README ----------
if (existsSync(join(root, 'README.md'))) {
  // No shields.io, "-" na mensagem do badge vira "--".
  const badge = (v) => v.replace(/-/g, '--');
  edit('README.md', (s) =>
    s
      .replace(new RegExp(`(img\\.shields\\.io/badge/[^"\\s]*?-)${esc(badge(prev))}(-[0-9A-Za-z]+(?:\\?|"))`, 'g'), `$1${badge(next)}$2`)
      // Fora dos badges: a versão solta (não parte de outra versão ou URL de badge).
      .replace(new RegExp(`(?<![0-9A-Za-z.-])${esc(prev)}(?![0-9A-Za-z.]|-[0-9A-Za-z])`, 'g'), next),
  );
}

if (!dryRun) for (const [path, content] of changes) writeFileSync(join(root, path), content, 'utf8');
console.log(JSON.stringify({ from: prev, to: next, dryRun, files: [...changes.keys()] }, null, 2));
