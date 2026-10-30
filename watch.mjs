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

// Release info from the "more information" text that follows each ISO link on the page.
// Best effort: returns '' if nothing recognisable is found, so a layout change never blocks an alert.
const releaseInfo = (lines, file) => {
  const hash = file.replace(/\.iso$/, '').split('_').at(-1);
  const rev = lines.find(l => new RegExp(String.raw`\.${hash} on ${DATE}`).test(l));
  if (rev) {
    const m = rev.match(new RegExp(String.raw`^(Original Release|Re-Released as):?.*? on (${DATE})\s*(.*)$`));
    if (m) return `${m[1] === 'Original Release' ? 'released' : 're-released'} ${m[2]}${m[3] ? ' ' + m[3].replace(/\.+$/, '') : ''}`;
  }
  const re = lines.join('\n').match(new RegExp(`Latest Re-Release: (${DATE})`));
  const rd = lines.join('\n').match(new RegExp(`Release Date: (${DATE})`));
  return re && (!rd || re[1] !== rd[1]) ? `re-released ${re[1]}` : rd ? `released ${rd[1]}` : '';
};

const res = await fetch(PAGE, { headers: { 'user-agent': 'disguise-os-release-monitor (GitHub Actions)' } });
if (!res.ok) { console.error(`Fetch failed: HTTP ${res.status} for ${PAGE}`); process.exit(1); }
const html = await res.text();

// Each ISO's block of page text runs from its link to the next ISO link.
const hits = [...html.matchAll(ISO_RE)];
if (!hits.length) { console.error('No ISOs found, page layout may have changed'); process.exit(1); }
const images = {}, best = {};
hits.forEach((h, n) => {
  const u = h[0], p = u.split('/'), i = p.indexOf('os-image');
  const platform = p[i + 1], folder = p.slice(i + 2, -1).join('/'), file = p.at(-1), key = `${platform}/${folder}`;
  const end = hits.slice(n + 1).find(x => x[0] !== u)?.index ?? h.index + 20000;
  let info = '';
  try { info = releaseInfo(toText(html.slice(h.index + u.length, end)), file); } catch {}
  const cur = images[key];
  if (cur && cur.file !== file) console.warn(`Warning: ${key} lists more than one ISO; keeping the last by name`);
  if (cur && (cur.file > file || (cur.file === file && (cur.info || !info)))) return;
  images[key] = { platform, file, info, r: rank(folder) };
});
for (const [key, img] of Object.entries(images)) {
  const cur = best[img.platform];
  if (!cur || cmp(img.r, images[cur].r) > 0 || (cmp(img.r, images[cur].r) === 0 && img.file > images[cur].file)) best[img.platform] = key;
}
const keys = Object.keys(images).sort();
console.log(`Found ${keys.length} images on ${Object.keys(best).length} platforms (* = newest for platform):`);
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
