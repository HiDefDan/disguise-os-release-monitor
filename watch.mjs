// Checks the Disguise hardware OS images page and records the newest ISO per platform.
// Writes latest.json every run; writes changes.md only when something differs from the
// previously committed latest.json. Exits non-zero if the page can't be read or has no ISOs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PAGE = process.env.PAGE_URL || 'https://help.disguise.one/hardware/hardware-os-images';

// Quarter folders (24Q1, 24Q1_1) rank above legacy numeric builds (199, 215).
const rank = v => {
  const m = v.match(/^(\d{2})Q(\d)(?:_(\d+))?$/);
  return m ? [1, +m[1], +m[2], +(m[3] || 0)] : [0, parseFloat(v) || 0, 0, 0];
};
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

const res = await fetch(PAGE, { headers: { 'user-agent': 'disguise-os-release-monitor (GitHub Actions)' } });
if (!res.ok) { console.error(`Fetch failed: HTTP ${res.status} for ${PAGE}`); process.exit(1); }
const html = await res.text();
const urls = [...new Set(html.match(/https:\/\/cfpkg\.disguise\.one\/pkg\/os-image\/[^"'\s)<>]+\.iso/g) ?? [])];
if (!urls.length) { console.error('No ISOs found, page layout may have changed'); process.exit(1); }
console.log(`Found ${urls.length} ISO links:\n${urls.sort().join('\n')}`);

const best = {};
for (const u of urls) {
  const p = u.split('/'), i = p.indexOf('os-image');
  const platform = p[i + 1], file = p.at(-1), r = rank(p.slice(i + 2, -1).join('/'));
  const cur = best[platform];
  if (!cur || cmp(r, cur.r) > 0 || (cmp(r, cur.r) === 0 && file > cur.file)) best[platform] = { file, r };
}
const latest = Object.fromEntries(Object.keys(best).sort().map(k => [k, best[k].file]));
console.log(`${Object.keys(latest).length} platforms:`, latest);

const known = existsSync('latest.json') ? JSON.parse(readFileSync('latest.json', 'utf8')) : null;
if (!known) console.log('No previous latest.json, recording baseline');
else {
  const changes = Object.entries(latest).filter(([k, f]) => known[k] !== f)
    .map(([k, f]) => `- **${k}**: \`${f}\`` + (known[k] ? ` (was \`${known[k]}\`)` : ' (new platform)'));
  const gone = Object.keys(known).filter(k => !(k in latest));
  if (gone.length) console.log('Platforms no longer listed:', gone.join(', '));
  if (changes.length) {
    writeFileSync('changes.md', changes.join('\n') + `\n\n${PAGE}\n`);
    console.log(`${changes.length} change(s):\n${changes.join('\n')}`);
  } else console.log('No changes');
}
writeFileSync('latest.json', JSON.stringify(latest, null, 1) + '\n');
