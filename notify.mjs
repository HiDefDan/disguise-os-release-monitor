// Sends the pushes in pushes.json (written by watch.mjs) to the Notify! iOS app: one per server
// type, stacked per type on the phone. Needs the NOTIFY_DEVICE_ID and NOTIFY_DEVICE_TOKEN secrets.
// NOTIFY_PLATFORMS (optional, e.g. "GX3P, vx4p") limits which server types push.
// Never fails the step: a failed send is written to notify-error.txt, which fails the run later,
// after the issue and state commit have gone through.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { NOTIFY_DEVICE_ID: id, NOTIFY_DEVICE_TOKEN: token, NOTIFY_PLATFORMS = '', TEST_PUSH } = process.env;
const API = process.env.NOTIFY_API || 'https://push.getnotifyapp.com';

const pushes = existsSync('pushes.json') ? JSON.parse(readFileSync('pushes.json', 'utf8')) : [];
if (TEST_PUSH === 'true') pushes.push({ platform: null, test: true, groupType: 'test', title: 'Disguise OS watch', text: 'Test push: notifications are set up.' });
if (!pushes.length) { console.log('Nothing to send'); process.exit(0); }
if (!id || !token) {
  console.log('::warning::NOTIFY_DEVICE_ID / NOTIFY_DEVICE_TOKEN secrets are not set, so no push notifications were sent');
  process.exit(0);
}

const only = NOTIFY_PLATFORMS.split(/[\s,]+/).filter(Boolean).map(p => p.toLowerCase());
const wanted = p => p.test || !only.length || (p.platform && only.includes(p.platform.toLowerCase()));
const errors = [];
for (const p of pushes) {
  if (!wanted(p)) { console.log(`Skipped (not in NOTIFY_PLATFORMS): ${p.title}`); continue; }
  try {
    const res = await fetch(`${API}/notify-json/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: p.title, text: p.text, groupType: p.groupType }),
    });
    if (res.ok) console.log(`Sent: ${p.title}`);
    else errors.push(`HTTP ${res.status} for "${p.title}": ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    errors.push(`${e.cause?.code || e.message} for "${p.title}"`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  writeFileSync('notify-error.txt', `Notify! push failed: ${errors.join('; ')}\n`);
}
