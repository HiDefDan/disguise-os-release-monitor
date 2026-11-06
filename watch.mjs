// Checks the Disguise hardware OS images page and records every listed ISO.
// latest.json maps "<platform>/<version-folder>" to the ISO filename (which contains the build
// hash), so new versions and silent re-releases of any image are caught, not just the newest.
// Also reads the Disguise legacy products (legacy.json) and product compatibility
// (compatibility.json) pages and cross-references them with the OS platforms.
// Writes changes.md, issue-title.txt and pushes.json (for notify.mjs) only when something differs
// from the committed state.
// Exits non-zero if the OS page can't be read or has no ISOs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
