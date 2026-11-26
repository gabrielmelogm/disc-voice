#!/usr/bin/env node
// Calcula a próxima versão (SemVer) a partir dos commits convencionais desde a
// última release do GitHub e gera as notas da release. Não cria nada: só lê
// git/gh e imprime um JSON (e grava as notas em --notes-out, se passado).
//
// Uso: node next-version.mjs --channel alpha|beta|stable [--target origin/main]
//        [--bump major|minor|patch] [--notes-out caminho.md]

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const channel = args.channel ?? 'alpha';
const target = args.target ?? 'origin/main';
if (!['alpha', 'beta', 'stable'].includes(channel)) fail(`Canal inválido: ${channel}`);
if (args.bump && !['major', 'minor', 'patch'].includes(args.bump)) fail(`--bump inválido: ${args.bump}`);

function run(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------- SemVer ----------
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
function parse(str) {
  const m = SEMVER.exec((str ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}
function format(v) {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}`;
}
function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length; // sem pre > com pre
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && +x !== +y) return +x - +y;
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------- Releases existentes ----------
const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
const releases = JSON.parse(
  run('gh', ['release', 'list', '--limit', '200', '--json', 'tagName,name,isPrerelease,isDraft,publishedAt']),
)
  .filter((r) => !r.isDraft)
  // A versão vem da tag; se a tag não for semver (ex.: "Alpha"), tenta o título.
  .map((r) => ({ ...r, version: parse(r.tagName) ?? parse(r.name) }))
  .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

const last = releases[0] ?? null;
const stables = releases.filter((r) => r.version && !r.version.pre.length && !r.isPrerelease);
const lastStable = stables.sort((a, b) => compare(b.version, a.version))[0] ?? null;

// ---------- Commits ----------
function commitsSince(tag) {
  const range = tag ? `${tag}..${target}` : target;
  const out = run('git', ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range]);
  return out
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const [hash, subject, body = ''] = raw.split('\x1f');
      const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject);
      const type = m ? m[1].toLowerCase() : 'other';
      return {
        hash,
        short: hash.slice(0, 7),
        subject,
        type,
        scope: m?.[2] || null,
        description: m ? m[4] : subject,
        breaking: Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body),
      };
    })
    // Os commits release(...) da própria skill só mudam a versão.
    .filter((c) => c.type !== 'release');
}

const LEVEL = { none: 0, patch: 1, minor: 2, major: 3 };
function levelOf(c) {
  if (c.breaking) return 'major';
  if (['feat', 'feature'].includes(c.type)) return 'minor';
  if (['fix', 'perf'].includes(c.type)) return 'patch';
  return 'none';
}
function maxLevel(list) {
  return list.reduce((acc, c) => (LEVEL[levelOf(c)] > LEVEL[acc] ? levelOf(c) : acc), 'none');
}

const newCommits = commitsSince(last?.tagName); // entram nas notas
const sinceStable = commitsSince(lastStable?.tagName); // definem o bump
let bump = args.bump ?? maxLevel(sinceStable);

// ---------- Próxima versão ----------
const base = lastStable?.version ?? { major: 0, minor: 0, patch: 0, pre: [] };
let effective = bump;
// Enquanto a versão for 0.x, quebras sobem só o minor (SemVer §4).
if (base.major === 0 && bump === 'major') effective = 'minor';

const core = { ...base, pre: [] };
if (effective === 'major') Object.assign(core, { major: core.major + 1, minor: 0, patch: 0 });
else if (effective === 'minor') Object.assign(core, { minor: core.minor + 1, patch: 0 });
else if (effective === 'patch') core.patch += 1;

let next = null;
if (bump !== 'none') {
  if (channel === 'stable') {
    next = core;
  } else {
    // Mesma versão-base e mesmo canal: alpha.1, alpha.2... (um "alpha" sem número conta como 0).
    const sameLine = releases
      .map((r) => r.version)
      .filter((v) => v && v.major === core.major && v.minor === core.minor && v.patch === core.patch)
      .filter((v) => v.pre[0] === channel);
    const n = Math.max(0, ...sameLine.map((v) => (/^\d+$/.test(v.pre[1] ?? '') ? +v.pre[1] : 0)));
    next = { ...core, pre: [channel, String(n + 1)] };
  }
}

const warnings = [];
if (last && !parse(last.tagName)) {
  warnings.push(`A última release usa a tag "${last.tagName}", que não é semver; a versão foi lida do título "${last.name}".`);
}
if (next && last?.version && compare(next, last.version) <= 0) {
  warnings.push(`A versão calculada (${format(next)}) não é maior que a última release (${format(last.version)}).`);
}
// Versão que já está em main (vinda de uma PR release(...) mergeada) e ainda sem
// release: é ela que deve ser publicada, sem abrir outra PR.
const pkgVersionAt = (ref) => parse(JSON.parse(run('git', ['show', `${ref}:package.json`])).version);
const mainVersion = pkgVersionAt(target);
// Só conta se a versão mudou em main desde a última release (ou seja, veio de uma PR de versão).
const versionAtLast = last ? pkgVersionAt(last.tagName) : null;
const pendingOnMain =
  mainVersion &&
  (!versionAtLast || compare(mainVersion, versionAtLast) !== 0) &&
  !releases.some((r) => r.version && compare(r.version, mainVersion) === 0) &&
  (!last?.version || compare(mainVersion, last.version) > 0)
    ? format(mainVersion)
    : null;
if (pendingOnMain) {
  next = mainVersion;
  warnings.push(`main já está na versão ${pendingOnMain}, que ainda não tem release: publique-a em vez de abrir outra PR.`);
}

const tag = next ? `v${format(next)}` : null;
if (tag && run('git', ['tag', '--list', tag])) warnings.push(`A tag ${tag} já existe.`);
if (!newCommits.length) warnings.push('Nenhum commit novo desde a última release.');

// ---------- Notas ----------
const SECTIONS = [
  ['⚠️ Quebras de compatibilidade', (c) => c.breaking],
  ['✨ Novidades', (c) => ['feat', 'feature'].includes(c.type)],
  ['🐛 Correções', (c) => c.type === 'fix'],
  ['⚡ Desempenho', (c) => c.type === 'perf'],
  ['🔧 Manutenção', () => true],
];
const used = new Set();
let notes = '';
for (const [title, match] of SECTIONS) {
  const items = newCommits.filter((c) => !used.has(c.hash) && match(c));
  if (!items.length) continue;
  items.forEach((c) => used.add(c.hash));
  notes += `## ${title}\n\n`;
  for (const c of items) notes += `- ${c.scope ? `**${c.scope}:** ` : ''}${c.description} (${c.short})\n`;
  notes += '\n';
}
if (tag) {
  notes += last
    ? `**Changelog completo:** https://github.com/${repo}/compare/${last.tagName}...${tag}\n`
    : `**Changelog completo:** https://github.com/${repo}/commits/${tag}\n`;
}
if (args['notes-out']) writeFileSync(args['notes-out'], notes, 'utf8');

console.log(
  JSON.stringify(
    {
      repo,
      target,
      lastRelease: last && { tag: last.tagName, name: last.name, version: last.version && format(last.version), prerelease: last.isPrerelease },
      lastStable: lastStable && { tag: lastStable.tagName, version: format(lastStable.version) },
      bump,
      appliedBump: effective,
      mainVersion: mainVersion && format(mainVersion),
      pendingOnMain,
      nextVersion: next && format(next),
      tag,
      // Numa versão pendente, o canal vem dela (0.1.0-beta.1 → beta), não do argumento.
      channel: next ? (next.pre[0] ?? 'stable') : channel,
      prerelease: next ? next.pre.length > 0 : channel !== 'stable',
      commits: newCommits.map((c) => ({ short: c.short, subject: c.subject, level: levelOf(c) })),
      warnings,
      notes,
    },
    null,
    2,
  ),
);
