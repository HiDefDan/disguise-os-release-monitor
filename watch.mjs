// Checks the Disguise hardware OS images page and records every listed ISO.
// latest.json maps "<platform>/<version-folder>" to the ISO filename (which contains the build
// hash), so new versions and silent re-releases of any image are caught, not just the newest.
// Writes changes.md only when something differs from the previously committed latest.json.
// Exits non-zero if the page can't be read or has no ISOs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PAGE = process.env.PAGE_URL || 'https://help.disguise.one/hardware/hardware-os-images';
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

const res = await fetch(PAGE, { headers: { 'user-agent': 'disguise-os-release-monitor (GitHub Actions)' } });
if (!res.ok) { console.error(`Fetch failed: HTTP ${res.status} for ${PAGE}`); process.exit(1); }
const html = await res.text();

// Platform names come from the page's h2 section headings, e.g. "RX I / RX II OS".
const headings = [...html.matchAll(/<h2[^>]*?id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)]
  .map(m => ({ index: m.index, id: m[1], name: toText(m[2]).join(' ').replace(/\s+OS$/, '') }));
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
for (const [key, img] of Object.entries(images)) {
  const cur = best[img.platform];
  if (!cur || cmp(img.r, images[cur].r) > 0 || (cmp(img.r, images[cur].r) === 0 && img.file > images[cur].file)) best[img.platform] = key;
}
const keys = Object.keys(images).sort();
console.log(`Found ${keys.length} images on ${Object.keys(best).length} platforms (* = newest for platform):`);
for (const [k, sec] of Object.entries(sections)) console.log(`Platform ${k}: ${sec ? `"${sec.name}" (#${sec.id})` : '(no heading found)'}`);
for (const k of keys) console.log(`${best[images[k].platform] === k ? '*' : ' '} ${k.padEnd(26)} ${images[k].file.padEnd(36)} ${images[k].info || '(no date found)'}`);

let known = existsSync('latest.json') ? JSON.parse(readFileSync('latest.json', 'utf8')) : null;
if (known && !Object.keys(known).some(k => k.includes('/'))) {
  console.log('latest.json is in the old one-image-per-platform format, recording a new baseline');
  known = null;
}
if (!known) console.log('No previous state, recording baseline');
else {
  const line = k => {
    const { platform, file, info } = images[k];
    const what = !(k in known) ? (Object.keys(known).some(x => x.startsWith(platform + '/')) ? 'new image' : 'new platform')
      : `replaces \`${known[k]}\``;
    return `- **${k}**${best[platform] === k ? ' (newest for platform)' : ''}: \`${file}\` - ${what}${info ? `\n  - ${info}` : ''}`;
  };
  const changed = keys.filter(k => known[k] !== images[k].file).sort((a, b) => (best[images[b].platform] === b) - (best[images[a].platform] === a));
  const gone = Object.keys(known).filter(k => !(k in images));
  if (gone.length) console.log('No longer listed:', gone.join(', '));
  if (changed.length) {
    writeFileSync('changes.md', changed.map(line).join('\n') + `\n\n${PAGE}\n`);
    console.log(`${changed.length} change(s):\n${changed.map(line).join('\n')}`);
  } else console.log('No changes');
}
writeFileSync('latest.json', JSON.stringify(Object.fromEntries(keys.map(k => [k, images[k].file])), null, 1) + '\n');

// LATEST.md: a rendered summary of the newest image per platform. No timestamps, so it only
// changes (and gets committed) when the page does.
const cell = v => (v || '').replace(/\|/g, '\\|');
const name = pl => sections[pl]?.name || pl;
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
    const models = img.models && img.models.toLowerCase() !== name(img.platform).toLowerCase() ? `<br><sub>${cell(img.models)}</sub>` : '';
    return `| **${link(img.platform)}**${models} | \`${cell(img.folder)}\` | ${when} | ${cell(img.windows) || '—'} | ${cell(img.designer) || '—'} | [⬇️ \`${cell(img.file)}\`](${img.url}) |`;
  }),
  '',
  '🔁 = re-released under the same version label with a new build hash. Delete older copies.',
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
