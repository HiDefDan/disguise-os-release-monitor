// Checks the Disguise hardware OS images page and records every listed ISO.
// latest.json maps "<platform>/<version-folder>" to the ISO filename (which contains the build
// hash), so new versions and silent re-releases of any image are caught, not just the newest.
// Also reads the Disguise legacy products page (legacy.json) and cross-references it.
// Writes changes.md and issue-title.txt only when something differs from the committed state.
// Exits non-zero if the OS page can't be read or has no ISOs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PAGE = process.env.PAGE_URL || 'https://help.disguise.one/hardware/hardware-os-images';
const LEGACY_PAGE = process.env.LEGACY_URL || 'https://www.disguise.one/en/products/legacy-products';
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

// "Discontinued" means no longer sold, not that OS builds have stopped, so legacy platforms
// stay fully watched. A legacy page failure never blocks OS alerts: the last known list is kept
// and legacy-error.txt makes the workflow fail afterwards, so the problem is still visible.
const knownLegacy = existsSync('legacy.json') ? JSON.parse(readFileSync('legacy.json', 'utf8')) : null;
let legacy = null, legacyError = '';
try {
  const r = await fetch(LEGACY_PAGE, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  legacy = parseLegacy(await r.text());
  if (!Object.keys(legacy).length) throw new Error('no products found, page layout may have changed');
} catch (e) {
  legacyError = `Legacy products page: ${e.message} (${LEGACY_PAGE}). Kept the last known list.`;
  legacy = knownLegacy;
  console.error(legacyError);
}

// Match legacy products to OS platforms by model name ("RX II" ~ "RX-II", but not "RX III").
const modelKey = v => v.toLowerCase().replace(/[\s_-]+/g, '');
const legacyOf = {}, platformOf = {};
for (const pl of Object.keys(best)) {
  const models = [...new Set((images[best[pl]].models || name(pl)).split('/').map(modelKey).filter(Boolean))];
  const products = Object.keys(legacy ?? {}).filter(p => models.includes(modelKey(p)));
  products.forEach(p => platformOf[p] = pl);
  if (products.length) legacyOf[pl] = { products, all: products.length === models.length };
}
console.log(`Legacy products (${Object.keys(legacy ?? {}).length}):`);
for (const [p, v] of Object.entries(legacy ?? {})) console.log(`  ${p.padEnd(22)} discontinued ${v.discontinued}${v.successor ? `, current generation ${v.successor}` : ''} -> ${platformOf[p] ? name(platformOf[p]) : '(no OS image section)'}`);

let known = existsSync('latest.json') ? JSON.parse(readFileSync('latest.json', 'utf8')) : null;
if (known && !Object.keys(known).some(k => k.includes('/'))) {
  console.log('latest.json is in the old one-image-per-platform format, recording a new baseline');
  known = null;
}
let osLines = [];
if (!known) console.log('No previous state, recording baseline');
else {
  const line = k => {
    const { platform, file, info } = images[k];
    const what = !(k in known) ? (Object.keys(known).some(x => x.startsWith(platform + '/')) ? 'new image' : 'new platform')
      : `replaces \`${known[k]}\``;
    const tags = [best[platform] === k && 'newest for platform', legacyOf[platform] && (legacyOf[platform].all ? 'discontinued platform' : 'partly discontinued platform')].filter(Boolean);
    return `- **${k}**${tags.length ? ` (${tags.join(', ')})` : ''}: \`${file}\` - ${what}${info ? `\n  - ${info}` : ''}`;
  };
  const changed = keys.filter(k => known[k] !== images[k].file).sort((a, b) => (best[images[b].platform] === b) - (best[images[a].platform] === a));
  const gone = Object.keys(known).filter(k => !(k in images));
  if (gone.length) console.log('No longer listed:', gone.join(', '));
  osLines = changed.map(line);
}

const legacyLines = [];
const legacyDesc = v => `discontinued ${v.discontinued}${v.successor ? `, current generation ${v.successor}` : ''}`;
if (!legacyError && !knownLegacy) console.log('No previous legacy list, recording baseline');
else if (!legacyError) {
  for (const [p, v] of Object.entries(legacy)) {
    const o = knownLegacy[p];
    if (!o) legacyLines.push(`- **${p}** added to the legacy list: ${legacyDesc(v)}${platformOf[p] ? ` (OS images: ${name(platformOf[p])})` : ''}`);
    else if (o.discontinued !== v.discontinued || o.successor !== v.successor) legacyLines.push(`- **${p}**: ${legacyDesc(v)} (was ${legacyDesc(o)})`);
  }
  for (const p of Object.keys(knownLegacy)) if (!(p in legacy)) legacyLines.push(`- **${p}** removed from the legacy list`);
}

if (osLines.length || legacyLines.length) {
  writeFileSync('changes.md', [
    ...(osLines.length ? ['### OS images', '', ...osLines, '', PAGE, ''] : []),
    ...(legacyLines.length ? ['### Legacy products', '', ...legacyLines, '', LEGACY_PAGE, ''] : []),
  ].join('\n'));
  const title = osLines.length ? `New Disguise OS image${legacyLines.length ? ' + legacy list change' : ''}` : 'Disguise legacy products list changed';
  writeFileSync('issue-title.txt', `${title} (${new Date().toISOString().slice(0, 10)})`);
  console.log(`Changes:\n${[...osLines, ...legacyLines].join('\n')}`);
} else console.log('No changes');
writeFileSync('latest.json', JSON.stringify(Object.fromEntries(keys.map(k => [k, images[k].file])), null, 1) + '\n');
if (legacyError) writeFileSync('legacy-error.txt', legacyError + '\n');
else writeFileSync('legacy.json', JSON.stringify(legacy, null, 1) + '\n');

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
