// Checks the Disguise hardware OS images page and records every listed ISO.
// latest.json maps "<platform>/<version-folder>" to the ISO filename (which contains the build
// hash), so new versions and silent re-releases of any image are caught, not just the newest.
// Also reads the Disguise legacy products (legacy.json) and product compatibility
// (compatibility.json) pages and cross-references them with the OS platforms.
// Writes changes.md, issue-title.txt and pushes.json (for notify.mjs) only when something differs
// from the committed state.
// Exits non-zero if the OS page can't be read or has no ISOs.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PAGE = process.env.PAGE_URL || 'https://help.disguise.one/hardware/hardware-os-images';
const LEGACY_PAGE = process.env.LEGACY_URL || 'https://www.disguise.one/en/products/legacy-products';
const COMPAT_PAGE = process.env.COMPAT_URL || 'https://help.disguise.one/hardware/product-compatibility';
const UA = { 'user-agent': 'disguise-os-release-monitor (GitHub Actions)' };
const ISO_RE = /https:\/\/cfpkg\.disguise\.one\/pkg\/os-image\/[^"'\s)<>]+\.iso/g;

// Quarter folders (24Q1, 24Q1_1) rank above legacy numeric builds (199, 215).
const rank = v => {
  const m = v.match(/^(\d{2})Q(\d)(?:_(\d+))?$/);
  return m ? [1, +m[1], +m[2], +(m[3] || 0)] : [0, parseFloat(v) || 0, 0, 0];
};
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

const toText = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<br\s*\/?>|<\/(p|li|tr|div|h\d|summary|details)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&rsquo;/g, "'")
  .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
const DATE = String.raw`\d{1,2}\/[A-Za-z]+\/\d{4}`;

const MONTHS = 'janfebmaraprmayjunjulaugsepoctnovdec';
const dateValue = d => { const [dd, mm, yy] = d.split('/'); return +yy * 10000 + (MONTHS.indexOf(mm.slice(0, 3).toLowerCase()) / 3 + 1) * 100 + +dd; };

// Release details from the "more information" text that follows each ISO link on the page.
// Best effort: missing fields are left empty, so a layout change never blocks an alert.
const releaseInfo = (lines, file) => {
  const text = lines.join('\n'), field = re => text.match(re)?.[1].trim() ?? '';
  const d = {
    kind: '', date: '', reason: '',
    windows: field(/Windows Version:\s*(.+)/), designer: field(/Compatible (?:d3|Designer) Versions?:\s*(.+)/i),
    models: field(/Applicable Models:\s*(.+)/),
  };
  const hash = file.replace(/\.iso$/, '').split('_').at(-1);
  const rev = lines.find(l => new RegExp(String.raw`\.${hash} on ${DATE}`).test(l));
  const m = rev?.match(new RegExp(String.raw`^(Original Release|Re-Released as):?.*? on (${DATE})\s*(.*)$`));
  const re = text.match(new RegExp(`Latest Re-Release: (${DATE})`)), rd = text.match(new RegExp(`Release Date: (${DATE})`));
  if (m) Object.assign(d, { kind: m[1] === 'Original Release' ? 'released' : 're-released', date: m[2], reason: m[3].replace(/\.+$/, '') });
  else if (re && (!rd || re[1] !== rd[1])) Object.assign(d, { kind: 're-released', date: re[1] });
  else if (rd) Object.assign(d, { kind: 'released', date: rd[1] });
  d.info = d.date ? `${d.kind} ${d.date}${d.reason ? ' ' + d.reason : ''}` : '';
  return d;
};

// Legacy products page: each product has a name line, a description, "Date discontinued: …"
// (sometimes inline in the description) and usually "Current Generation: …".
const parseLegacy = h => {
  const lines = toText(h.replace(/<\/(a|span)>/gi, '</p>'));
  const out = {}; let name = null, last = null;
  for (const l of lines.slice(lines.findIndex(x => /^See all our legacy products/i.test(x)) + 1)) {
    if (l === 'Footer') break;
    const d = l.match(/Date discontinued\s*:\s*(.+)$/i), g = l.match(/^Current Generation\s*:\s*(.+)$/i);
    if (d && name) { out[last = name] = { discontinued: d[1].trim(), successor: '' }; name = null; }
    else if (g && last) out[last].successor = g[1].trim();
    else if (!d && !g && l.length <= 30 && !/^View spec/i.test(l)) name = l;
  }
  return out;
};

// Product compatibility page: one table, a row per product. Columns are found by header text
// so a reordering doesn't break it; multi-line cells (the OS column) keep their lines.
const COMPAT_COLUMNS = { product: /^product$/i, phase: /life\s*cycle/i, designerFrom: /initial/i, designerLatest: /latest designer support/i, canLoadLatest: /can i load/i, os: /^os$/i };
const parseCompat = h => {
  const table = h.match(/<table[\s\S]*?<\/table>/)?.[0] ?? '';
  const cells = row => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => toText(m[1].replace(/<br\s*\/?>/gi, '\n')));
  const [head, ...rows] = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => cells(m[1]));
  const col = Object.fromEntries(Object.entries(COMPAT_COLUMNS).map(([k, re]) => [k, (head ?? []).findIndex(c => re.test(c.join(' ')))]));
  if (Object.values(col).includes(-1)) throw new Error('compatibility table columns not recognised, page layout may have changed');
  const out = {};
  for (const r of rows) {
    const v = k => r[col[k]] ?? [];
    if (v('product').length) out[v('product').join(' ')] = { phase: v('phase').join(' '), designerFrom: v('designerFrom').join(' '), designerLatest: v('designerLatest').join(' '), canLoadLatest: v('canLoadLatest').join(' '), os: v('os') };
  }
  return out;
};

const res = await fetch(PAGE, { headers: UA });
if (!res.ok) { console.error(`Fetch failed: HTTP ${res.status} for ${PAGE}`); process.exit(1); }
const html = await res.text();

// Platform names come from the nearest section heading above each platform's first ISO,
// e.g. "RX I / RX II OS" (h3 on the live page).
const headings = [...html.matchAll(/<h([23])[^>]*?id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)]
  .map(m => ({ index: m.index, id: m[2], name: toText(m[3]).join(' ').replace(/\s+OS$/, '') }))
  .filter(x => !/^(Revision History|Release Notes|Getting OS Images)$/i.test(x.name));
const sections = {};

// Each ISO's block of page text runs from its link to the next ISO link.
const hits = [...html.matchAll(ISO_RE)];
if (!hits.length) { console.error('No ISOs found, page layout may have changed'); process.exit(1); }
const images = {}, best = {};
hits.forEach((h, n) => {
  const u = h[0], p = u.split('/'), i = p.indexOf('os-image');
  const platform = p[i + 1], folder = p.slice(i + 2, -1).join('/'), file = p.at(-1), key = `${platform}/${folder}`;
  const end = hits.slice(n + 1).find(x => x[0] !== u)?.index ?? h.index + 20000;
  sections[platform] ??= headings.filter(x => x.index < h.index).at(-1);
  let d = { info: '' };
  try { d = releaseInfo(toText(html.slice(h.index + u.length, end)), file); } catch {}
  const cur = images[key];
  if (cur && cur.file !== file) console.warn(`Warning: ${key} lists more than one ISO; keeping the last by name`);
  if (cur && (cur.file > file || (cur.file === file && (cur.info || !d.info)))) return;
  images[key] = { ...d, platform, folder, file, url: u, r: rank(folder) };
});
const name = pl => sections[pl]?.name || pl;
for (const [key, img] of Object.entries(images)) {
  const cur = best[img.platform];
  if (!cur || cmp(img.r, images[cur].r) > 0 || (cmp(img.r, images[cur].r) === 0 && img.file > images[cur].file)) best[img.platform] = key;
}
const keys = Object.keys(images).sort();
console.log(`Found ${keys.length} images on ${Object.keys(best).length} platforms (* = newest for platform):`);
for (const [k, sec] of Object.entries(sections)) console.log(`Platform ${k}: ${sec ? `"${sec.name}" (#${sec.id})` : '(no heading found)'}`);
for (const k of keys) console.log(`${best[images[k].platform] === k ? '*' : ' '} ${k.padEnd(26)} ${images[k].file.padEnd(36)} ${images[k].info || '(no date found)'}`);

// Secondary pages (legacy products, product compatibility). A failure never blocks OS alerts:
// the last known data is kept and source-errors.txt makes the workflow fail afterwards, so the
// problem is still visible.
const sourceErrors = [];
const loadSource = async (label, url, file, parse) => {
  const known = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  try {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = parse(await r.text());
    if (!Object.keys(data).length) throw new Error('no products found, page layout may have changed');
    return { known, data, ok: true };
  } catch (e) {
    sourceErrors.push(`${label}: ${e.message} (${url}). Kept the last known data.`);
    console.error(sourceErrors.at(-1));
    return { known, data: known, ok: false };
  }
};
// "Discontinued" means no longer sold, not that OS builds have stopped, so legacy platforms
// stay fully watched.
const legacySrc = await loadSource('Legacy products page', LEGACY_PAGE, 'legacy.json', parseLegacy);
const compatSrc = await loadSource('Product compatibility page', COMPAT_PAGE, 'compatibility.json', parseCompat);
const legacy = legacySrc.data, knownLegacy = legacySrc.known, compat = compatSrc.data;

// Match products to OS platforms by model name ("RX II" ~ "RX-II", but not "RX III").
const modelKey = v => v.toLowerCase().replace(/[\s_-]+/g, '');
const modelsOf = Object.fromEntries(Object.keys(best).map(pl =>
  [pl, [...new Set((images[best[pl]].models || name(pl)).split('/').map(modelKey).filter(Boolean))]]));
const platformFor = product => Object.keys(best).find(pl => modelsOf[pl].includes(modelKey(product)));
const legacyOf = {}, platformOf = {};
for (const p of Object.keys(legacy ?? {})) if (platformFor(p)) platformOf[p] = platformFor(p);
for (const pl of Object.keys(best)) {
  const products = Object.keys(platformOf).filter(p => platformOf[p] === pl);
  if (products.length) legacyOf[pl] = { products, all: products.length === modelsOf[pl].length };
}
console.log(`Product compatibility (${Object.keys(compat ?? {}).length}):`);
for (const [p, v] of Object.entries(compat ?? {})) console.log(`  ${p.padEnd(26)} ${v.phase.padEnd(18)} Designer ${v.designerFrom} to ${v.designerLatest} -> ${platformFor(p) ? name(platformFor(p)) : '(no OS image section)'}`);
console.log(`Legacy products (${Object.keys(legacy ?? {}).length}):`);
for (const [p, v] of Object.entries(legacy ?? {})) console.log(`  ${p.padEnd(22)} discontinued ${v.discontinued}${v.successor ? `, current generation ${v.successor}` : ''} -> ${platformOf[p] ? name(platformOf[p]) : '(no OS image section)'}`);

let known = existsSync('latest.json') ? JSON.parse(readFileSync('latest.json', 'utf8')) : null;
if (known && !Object.keys(known).some(k => k.includes('/'))) {
  console.log('latest.json is in the old one-image-per-platform format, recording a new baseline');
  known = null;
}
let osLines = [], changed = [];
if (!known) console.log('No previous state, recording baseline');
else {
  const line = k => {
    const { platform, file, info } = images[k];
    const what = !(k in known) ? (Object.keys(known).some(x => x.startsWith(platform + '/')) ? 'new image' : 'new platform')
      : `replaces \`${known[k]}\``;
    const tags = [best[platform] === k && 'newest for platform', legacyOf[platform] && (legacyOf[platform].all ? 'discontinued platform' : 'partly discontinued platform')].filter(Boolean);
    return `- **${k}**${tags.length ? ` (${tags.join(', ')})` : ''}: \`${file}\` - ${what}${info ? `\n  - ${info}` : ''}`;
  };
  changed = keys.filter(k => known[k] !== images[k].file).sort((a, b) => (best[images[b].platform] === b) - (best[images[a].platform] === a));
  const gone = Object.keys(known).filter(k => !(k in images));
  if (gone.length) console.log('No longer listed:', gone.join(', '));
  osLines = changed.map(line);
}

const legacyLines = [], legacyPushes = [];
const legacyDesc = v => `discontinued ${v.discontinued}${v.successor ? `, current generation ${v.successor}` : ''}`;
if (legacySrc.ok && !knownLegacy) console.log('No previous legacy list, recording baseline');
else if (legacySrc.ok) {
  for (const [p, v] of Object.entries(legacy)) {
    const o = knownLegacy[p];
    const os = platformOf[p] ? ` (OS images: ${name(platformOf[p])})` : '';
    if (!o) legacyPushes.push({ product: p, what: `added to the legacy list: ${legacyDesc(v)}${os}` });
    else if (o.discontinued !== v.discontinued || o.successor !== v.successor) legacyPushes.push({ product: p, what: `${legacyDesc(v)} (was ${legacyDesc(o)})` });
  }
  for (const p of Object.keys(knownLegacy)) if (!(p in legacy)) legacyPushes.push({ product: p, what: 'removed from the legacy list' });
  legacyLines.push(...legacyPushes.map(x => `- **${x.product}**${/^(added|removed) /.test(x.what) ? ' ' : ': '}${x.what}`));
}

// Compatibility changes, field by field, e.g. a product moving to End of Support.
const COMPAT_LABELS = { phase: 'lifecycle', designerFrom: 'first Designer', designerLatest: 'latest Designer', canLoadLatest: 'can load latest Designer', os: 'OS / Designer' };
const compatShow = v => Array.isArray(v) ? v.join('; ') : v;
const compatChanges = [];
if (compatSrc.ok && !compatSrc.known) console.log('No previous compatibility table, recording baseline');
else if (compatSrc.ok) {
  for (const [p, v] of Object.entries(compat)) {
    const o = compatSrc.known[p];
    if (!o) { compatChanges.push({ product: p, what: `added: ${v.phase}, Designer ${v.designerFrom} to ${v.designerLatest}` }); continue; }
    const diffs = Object.keys(COMPAT_LABELS).filter(k => compatShow(o[k]) !== compatShow(v[k]))
      .map(k => `${COMPAT_LABELS[k]} ${compatShow(v[k])} (was ${compatShow(o[k])})`);
    if (diffs.length) compatChanges.push({ product: p, what: diffs.join('; ') });
  }
  for (const p of Object.keys(compatSrc.known)) if (!(p in compat)) compatChanges.push({ product: p, what: 'removed from the compatibility table' });
}
const compatLines = compatChanges.map(x => {
  const pl = platformFor(x.product);
  return `- **${x.product}**${pl && modelKey(name(pl)) !== modelKey(x.product) ? ` (${name(pl)})` : ''}: ${x.what}`;
});

if (osLines.length || legacyLines.length || compatLines.length) {
  writeFileSync('changes.md', [
    ...(osLines.length ? ['### OS images', '', ...osLines, '', PAGE, ''] : []),
    ...(legacyLines.length ? ['### Legacy products', '', ...legacyLines, '', LEGACY_PAGE, ''] : []),
    ...(compatLines.length ? ['### Product compatibility', '', ...compatLines, '', COMPAT_PAGE, ''] : []),
  ].join('\n'));
  const others = [legacyLines.length && 'legacy list', compatLines.length && 'product compatibility'].filter(Boolean);
  const title = osLines.length ? `New Disguise OS image${others.length ? ` + ${others.join(' + ')} change` : ''}` : `Disguise ${others.join(' + ')} changed`;
  writeFileSync('issue-title.txt', `${title} (${new Date().toISOString().slice(0, 10)})`);
  console.log(`Changes:\n${[...osLines, ...legacyLines, ...compatLines].join('\n')}`);

  // One push per server type (stacked per type on the phone by groupType), one per legacy change.
  const pushes = [];
  for (const pl of [...new Set(changed.map(k => images[k].platform))]) {
    const ks = changed.filter(k => images[k].platform === pl), l = legacyOf[pl];
    const what = k => known[k] ? `${images[k].folder} re-released` : `new OS image ${images[k].folder}`;
    pushes.push({
      platform: pl, groupType: `os-${pl}`,
      title: `${name(pl)}: ${ks.length === 1 ? what(ks[0]) : `${ks.length} OS image changes`}`,
      text: [
        ...ks.map(k => `${images[k].file}${best[pl] === k ? ' (newest)' : ''}${images[k].info ? `\n${images[k].info}` : ''}`),
        l ? (l.all ? 'Platform discontinued (no longer sold)' : 'Platform partly discontinued') : '',
      ].filter(Boolean).join('\n\n'),
    });
  }
  for (const x of legacyPushes) pushes.push({ platform: platformOf[x.product] ?? null, groupType: 'legacy', title: `Disguise legacy list: ${x.product}`, text: x.what });
  // Compatibility changes go into the matching server type's thread.
  for (const x of compatChanges) {
    const pl = platformFor(x.product) ?? null;
    pushes.push({ platform: pl, groupType: pl ? `os-${pl}` : 'compatibility', title: `${x.product}: compatibility update`, text: x.what });
  }
  writeFileSync('pushes.json', JSON.stringify(pushes, null, 1) + '\n');
} else console.log('No changes');
writeFileSync('latest.json', JSON.stringify(Object.fromEntries(keys.map(k => [k, images[k].file])), null, 1) + '\n');
if (sourceErrors.length) writeFileSync('source-errors.txt', sourceErrors.join('\n') + '\n');
if (legacySrc.ok) writeFileSync('legacy.json', JSON.stringify(legacy, null, 1) + '\n');
if (compatSrc.ok) writeFileSync('compatibility.json', JSON.stringify(compat, null, 1) + '\n');

// LATEST.md: a rendered summary of the newest image per platform. No timestamps, so it only
// changes (and gets committed) when the page does.
const cell = v => (v || '').replace(/\|/g, '\\|');
const link = pl => sections[pl] ? `[${cell(name(pl))}](${PAGE}#${sections[pl].id})` : cell(pl);
const byDate = (a, b) => (b.date ? dateValue(b.date) : 0) - (a.date ? dateValue(a.date) : 0) || name(a.platform).localeCompare(name(b.platform));
const newest = Object.values(best).map(k => images[k]).sort(byDate);
const SITE_URL = `https://${(process.env.GITHUB_REPOSITORY || 'HiDefDan/disguise-os-release-monitor').split('/').map((x, i) => i ? x : `${x.toLowerCase()}.github.io`).join('/')}/`;
const status = `https://github.com/${process.env.GITHUB_REPOSITORY || 'HiDefDan/disguise-os-release-monitor'}/actions/workflows/watch.yml`;
const md = [
  '# Latest Disguise OS images',
  '',
  `[![watcher](${status}/badge.svg)](${status}) &nbsp; **${newest.length} platforms** · **${keys.length} images** · source: [help.disguise.one](${PAGE})`,
  '',
  '> [!NOTE]',
  '> Generated automatically from the Disguise hardware OS images page and checked every 6 hours.',
  '> Newest release first. Always confirm against the official page before reimaging a server.',
  '',
  `Follow your server types: [per-server-type pages and feeds](${SITE_URL}) (paste a page address into a feed reader such as Notify!'s Follow Any Feed).`,
  '',
  `Jump to: ${[compat && '[Designer compatibility by model](#designer-compatibility-by-model)', legacy && '[Legacy products](#legacy-products)', '[All images](#all-images)'].filter(Boolean).join(' · ')}`,
  '',
  '| Platform | Version | Released | Windows | Designer | Download |',
  '|:--|:--|:--|:--|:--|:--|',
  ...newest.map(img => {
    const when = img.date ? `${img.kind === 're-released' ? '🔁 ' : ''}${img.date}${img.reason ? `<br><sub>${cell(img.reason)}</sub>` : ''}` : '—';
    const norm = v => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    const models = img.models && norm(img.models) !== norm(name(img.platform)) ? `<br><sub>${cell(img.models)}</sub>` : '';
    const l = legacyOf[img.platform], succ = l ? [...new Set(l.products.map(p => legacy[p].successor).filter(Boolean))] : [];
    const status = l ? `<br><sub>${l.all ? '🟥 Discontinued' : '🟧 Partly discontinued'}: ${l.products.map(p => `${cell(p)} ${cell(legacy[p].discontinued)}`).join(', ')}${succ.length ? ` → ${cell(succ.join(' / '))}` : ''}</sub>` : '';
    return `| **${link(img.platform)}**${models}${status} | \`${cell(img.folder)}\` | ${when} | ${cell(img.windows) || '—'} | ${cell(img.designer) || '—'} | [⬇️ \`${cell(img.file)}\`](${img.url}) |`;
  }),
  '',
  '🔁 = re-released under the same version label with a new build hash. Delete older copies.<br>',
  '🟥 / 🟧 = all / some of the platform\'s models are on Disguise\'s legacy products list (no longer sold).',
  '',
  ...(compat ? (() => {
    const PHASE = { 'current production': '🟢', 'end of production': '🟡', 'end of support': '🟠', 'end of life': '🔴' };
    const order = [...newest.flatMap(img => Object.keys(compat).filter(p => platformFor(p) === img.platform)), ...Object.keys(compat).filter(p => !platformFor(p))];
    return [
      '## Designer compatibility by model',
      '',
      '| Model | Lifecycle | OS images | First Designer | Latest Designer | Runs latest Designer? | OS → Designer |',
      '|:--|:--|:--|:--|:--|:--|:--|',
      ...order.map(p => {
        const v = compat[p], pl = platformFor(p);
        return `| **${cell(p)}** | ${PHASE[v.phase.toLowerCase()] ?? ''} ${cell(v.phase)} | ${pl ? link(pl) : '—'} | ${cell(v.designerFrom)} | ${cell(v.designerLatest)} | ${cell(v.canLoadLatest)} | ${v.os.map(cell).join('<br>') || '—'} |`;
      }),
      '',
      '🟢 Current Production · 🟡 End of Production · 🟠 End of Support · 🔴 End of Life',
      '',
      `Source: [help.disguise.one product compatibility](${COMPAT_PAGE})`,
      '',
    ];
  })() : []),
  ...(legacy ? [
    '## Legacy products',
    '',
    '> [!IMPORTANT]',
    '> Discontinued means Disguise no longer sells the product. It does not mean OS builds have stopped:',
    '> compare the discontinued date with the newest OS image.',
    '',
    '| Product | Discontinued | Current generation | OS images | Newest OS image |',
    '|:--|:--|:--|:--|:--|',
    ...Object.entries(legacy).map(([p, v]) => {
      const img = platformOf[p] && images[best[platformOf[p]]];
      return `| ${cell(p)} | ${cell(v.discontinued)} | ${cell(v.successor) || '—'} | ${img ? link(img.platform) : '—'} | ${img ? `\`${cell(img.folder)}\`${img.date ? ` · ${img.date}` : ''}` : '—'} |`;
    }),
    '',
    `Source: [disguise.one legacy products](${LEGACY_PAGE})`,
    '',
  ] : []),
  '## All images',
  '',
  '<details>',
  `<summary><b>All ${keys.length} listed images</b></summary>`,
  '',
  '| Platform | Version | File | Released |',
  '|:--|:--|:--|:--|',
  ...keys.map(k => images[k]).sort((a, b) => name(a.platform).localeCompare(name(b.platform)) || cmp(b.r, a.r)).map(img =>
    `| ${cell(name(img.platform))}${best[img.platform] === `${img.platform}/${img.folder}` ? ' ⭐' : ''} | \`${cell(img.folder)}\` | [\`${cell(img.file)}\`](${img.url}) | ${img.date ? `${img.kind === 're-released' ? '🔁 ' : ''}${img.date}` : '—'} |`),
  '',
  '⭐ = newest for platform',
  '',
  '</details>',
  '',
].join('\n');
writeFileSync('LATEST.md', md);

// docs/: a GitHub Pages site with one page per server type, for people who watch a page for
// changes instead of getting pushes. Each page holds only that server type's data and has no
// timestamps, so it changes only when that server type does.
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slug = pl => pl.toLowerCase().replace(/_/g, '-');
const PHASES = { 'current production': '🟢', 'end of production': '🟡', 'end of support': '🟠', 'end of life': '🔴' };
const STYLE = `:root{--bg:#fff;--fg:#1b1f24;--muted:#5b636e;--line:#d8dee4;--card:#f6f8fa;--accent:#0b62d6}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9aa4af;--line:#30363d;--card:#161b22;--accent:#4c9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}a{color:var(--accent)}h1{margin:.2em 0 .1em;font-size:1.9rem}
h2{margin:1.8em 0 .5em;font-size:1.15rem}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}code{font-size:.9em;overflow-wrap:anywhere}footer{margin-top:40px;font-size:.85rem;color:var(--muted)}`;
const pageHtml = (title, body, feed) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="alternate" type="application/atom+xml" title="${esc(title)}" href="${esc(feed)}">
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer>
<p>Unofficial and not affiliated with or endorsed by Disguise. Generated from Disguise's public
<a href="${esc(PAGE)}">hardware OS images</a>, <a href="${esc(COMPAT_PAGE)}">product compatibility</a> and
<a href="${esc(LEGACY_PAGE)}">legacy products</a> pages. Always check the official pages before reimaging hardware.</p>
</footer>
</main>
</body>
</html>
`;
const released = img => img.date ? `${img.kind === 're-released' ? '🔁 Re-released' : 'Released'} ${esc(img.date)}${img.reason ? ` <span class="muted">${esc(img.reason)}</span>` : ''}` : '—';
const compatFor = pl => Object.keys(compat ?? {}).filter(p => platformFor(p) === pl);
const compatTable = products => products.length ? `<div class="scroll"><table>
<tr><th>Model</th><th>Lifecycle</th><th>First Designer</th><th>Latest Designer</th><th>Runs latest Designer?</th><th>OS → Designer</th></tr>
${products.map(p => { const v = compat[p]; return `<tr><td><b>${esc(p)}</b></td><td>${PHASES[v.phase.toLowerCase()] ?? ''} ${esc(v.phase)}</td><td>${esc(v.designerFrom)}</td><td>${esc(v.designerLatest)}</td><td>${esc(v.canLoadLatest)}</td><td>${v.os.map(esc).join('<br>') || '—'}</td></tr>`; }).join('\n')}
</table></div>` : '<p class="muted">No entry on the product compatibility page.</p>';

// history.json: every change ever seen, one entry each, with a stable id. The Atom feeds are built
// from it, so feed readers (and Notify!'s "Follow Any Feed") only see genuinely new entries.
const SITE = SITE_URL;
const isoDay = d => { const v = dateValue(d); return `${Math.floor(v / 10000)}-${String(Math.floor(v / 100) % 100).padStart(2, '0')}-${String(v % 100).padStart(2, '0')}T00:00:00Z`; };
const hash = v => createHash('sha256').update(v).digest('hex').slice(0, 12);
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const osEntry = (k, updated, seeding = false) => {
  const i = images[k], newestNow = best[i.platform] === k;
  return { id: `os/${i.platform}/${i.file}`, platform: i.platform, updated,
    title: `${name(i.platform)}: ${i.folder} ${i.kind || (!seeding && known?.[k] ? 're-released' : 'OS image')}${newestNow ? '' : ' (older version)'}`,
    text: [i.file, i.info, i.windows && `Windows: ${i.windows}`, i.designer && `Designer: ${i.designer}`].filter(Boolean).join('\n'), url: i.url };
};
let history = existsSync('history.json') ? JSON.parse(readFileSync('history.json', 'utf8')) : null;
if (!history) {
  // First run: seed with the current newest image per server type, dated from the page.
  history = Object.values(best).map(k => osEntry(k, images[k].date ? isoDay(images[k].date) : now, true));
  console.log(`No history.json, seeding ${history.length} feed entries`);
}
const seen = new Set(history.map(e => e.id));
const add = e => { if (!seen.has(e.id)) { seen.add(e.id); history.push(e); } };
for (const k of changed) add(osEntry(k, now));
for (const x of compatChanges) add({ id: `compat/${x.product}/${hash(x.what)}`, platform: platformFor(x.product) ?? null, updated: now,
  title: `${x.product}: compatibility update`, text: x.what, url: COMPAT_PAGE });
for (const x of legacyPushes) add({ id: `legacy/${x.product}/${hash(x.what)}`, platform: platformOf[x.product] ?? null, updated: now,
  title: `Disguise legacy list: ${x.product}`, text: x.what, url: LEGACY_PAGE });
history.sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
writeFileSync('history.json', JSON.stringify(history, null, 1) + '\n');

const atom = (file, title, entries) => {
  const top = entries.slice(0, 50);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${esc(title)}</title>
<id>${esc(SITE + file)}</id>
<link rel="self" href="${esc(SITE + file)}"/>
<link rel="alternate" href="${esc(SITE + file.replace(/\.xml$/, '.html').replace(/^all\.html$/, ''))}"/>
<updated>${top[0]?.updated ?? '2026-01-01T00:00:00Z'}</updated>
<author><name>disguise-os-release-monitor (unofficial)</name></author>
${top.map(e => `<entry>
<id>tag:${new URL(SITE).host},2026:${esc(e.id)}</id>
<title>${esc(e.title)}</title>
<updated>${e.updated}</updated>
<link href="${esc(e.url)}"/>
<content type="text">${esc(e.text)}</content>
</entry>`).join('\n')}
</feed>
`;
};

mkdirSync('docs', { recursive: true });
writeFileSync('docs/.nojekyll', '');
for (const pl of Object.keys(best)) {
  const img = images[best[pl]], l = legacyOf[pl];
  const all = keys.filter(k => images[k].platform === pl).map(k => images[k]).sort((a, b) => cmp(b.r, a.r));
  const legacyNote = l ? `<p>${l.all ? '🟥 Discontinued (no longer sold)' : '🟧 Partly discontinued'}: ${l.products.map(p => `${esc(p)} ${esc(legacy[p].discontinued)}${legacy[p].successor ? ` → ${esc(legacy[p].successor)}` : ''}`).join(', ')}.
Discontinued means no longer sold, not that OS builds have stopped.</p>` : '';
  writeFileSync(`docs/${slug(pl)}.xml`, atom(`${slug(pl)}.xml`, `${name(pl)} · Disguise OS images (unofficial)`, history.filter(e => e.platform === pl)));
  writeFileSync(`docs/${slug(pl)}.html`, pageHtml(`${name(pl)} · Disguise OS images`, `<p><a href="./">All server types</a> · <a href="${slug(pl)}.xml">Feed for ${esc(name(pl))}</a></p>
<h1>${esc(name(pl))}</h1>
${img.models && modelKey(img.models) !== modelKey(name(pl)) ? `<p class="muted">Models: ${esc(img.models)}</p>` : ''}
${legacyNote}
<h2>Latest OS image</h2>
<div class="card"><dl>
<dt>Version</dt><dd><b>${esc(img.folder)}</b></dd>
<dt>File</dt><dd><a href="${esc(img.url)}"><code>${esc(img.file)}</code></a></dd>
<dt>Released</dt><dd>${released(img)}</dd>
<dt>Windows</dt><dd>${esc(img.windows) || '—'}</dd>
<dt>Designer</dt><dd>${esc(img.designer) || '—'}</dd>
</dl></div>
<h2>Designer compatibility</h2>
${compatTable(compatFor(pl))}
<h2>All OS images</h2>
<div class="scroll"><table>
<tr><th>Version</th><th>File</th><th>Released</th></tr>
${all.map(i => `<tr><td>${esc(i.folder)}</td><td><a href="${esc(i.url)}"><code>${esc(i.file)}</code></a></td><td>${released(i)}</td></tr>`).join('\n')}
</table></div>
<p><a href="${esc(PAGE)}#${esc(sections[pl]?.id ?? '')}">Official ${esc(name(pl))} OS page</a></p>`, `${slug(pl)}.xml`));
}
writeFileSync('docs/all.xml', atom('all.xml', 'Disguise OS images, all server types (unofficial)', history));
writeFileSync('docs/index.html', pageHtml('Disguise OS images by server type', `<h1>Disguise OS images by server type</h1>
<p>Each server type has its own page and feed. A feed gets one entry per change for that server
type: a new or re-released OS image, a Designer compatibility change, or a legacy-list change.
To get alerts for your servers, add their page address to a feed reader (each page links its
feed). <a href="all.xml">The all-server-types feed</a> gets every change.</p>
<div class="scroll"><table>
<tr><th>Server type</th><th>Latest OS</th><th>Released</th><th>Lifecycle</th></tr>
${newest.map(img => { const phases = [...new Set(compatFor(img.platform).map(p => compat[p].phase))];
  return `<tr><td><a href="${slug(img.platform)}.html"><b>${esc(name(img.platform))}</b></a></td><td>${esc(img.folder)}</td><td>${img.date ? `${img.kind === 're-released' ? '🔁 ' : ''}${esc(img.date)}` : '—'}</td><td>${phases.map(p => `${PHASES[p.toLowerCase()] ?? ''} ${esc(p)}`).join('<br>') || '—'}</td></tr>`; }).join('\n')}
</table></div>`, 'all.xml'));
