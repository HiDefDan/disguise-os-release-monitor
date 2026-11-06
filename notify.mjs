// Sends the pushes in pushes.json (written by watch.mjs) to the Notify! iOS app: one per server
// type, stacked per type on the phone.
//   NOTIFY_DEVICE_ID / NOTIFY_DEVICE_TOKEN (secrets): your own device.
//   NOTIFY_PLATFORMS (variable, optional, e.g. "GX3P, vx4p"): server types your device gets.
//   NOTIFY_GROUPS (secret, optional): JSON mapping server types to Notify! groups that other
//     people join, e.g. {"GX3P": "GRPAB123:token", "vx4p": "GRPCD456:token"}. A server type with
//     a group goes to that group only (join it yourself to get it too). The key "other" catches
//     pushes with no server type (legacy or compatibility entries without OS images).
// Never fails the step: a failed send is written to notify-error.txt, which fails the run later,
// after the issue and state commit have gone through.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { NOTIFY_DEVICE_ID, NOTIFY_DEVICE_TOKEN, NOTIFY_PLATFORMS = '', NOTIFY_GROUPS = '', TEST_PUSH } = process.env;
const API = process.env.NOTIFY_API || 'https://push.getnotifyapp.com';
const errors = [];

const device = NOTIFY_DEVICE_ID && NOTIFY_DEVICE_TOKEN ? { label: 'your device', id: NOTIFY_DEVICE_ID, token: NOTIFY_DEVICE_TOKEN } : null;
const groups = {};
if (NOTIFY_GROUPS.trim()) {
  try {
    for (const [k, v] of Object.entries(JSON.parse(NOTIFY_GROUPS))) {
      const [id, token] = String(v).split(':');
      if (!/^GRP/.test(id) || !token) throw new Error(`entry "${k}" is not "GRP…:token"`);
      groups[k.toLowerCase()] = { label: `group for ${k}`, id, token: token.trim() };
    }
  } catch (e) {
    errors.push(`NOTIFY_GROUPS is not valid: ${e instanceof SyntaxError ? 'not JSON' : e.message}`);
  }
}

const pushes = existsSync('pushes.json') ? JSON.parse(readFileSync('pushes.json', 'utf8')) : [];
if (TEST_PUSH === 'true') pushes.push({ platform: null, test: true, groupType: 'test', title: 'Disguise OS watch', text: 'Test push: notifications are set up.' });
if (!pushes.length && !errors.length) { console.log('Nothing to send'); process.exit(0); }
if (!device && !Object.keys(groups).length && !errors.length) {
  console.log('::warning::No Notify! device or groups are configured, so no push notifications were sent');
  process.exit(0);
}

const only = NOTIFY_PLATFORMS.split(/[\s,]+/).filter(Boolean).map(p => p.toLowerCase());
const deviceWants = p => !only.length || (p.platform && only.includes(p.platform.toLowerCase()));
// A test push goes everywhere, so every group's setup is checked too.
const targets = p => {
  if (p.test) return [device, ...new Map(Object.values(groups).map(g => [g.id, g])).values()].filter(Boolean);
  const g = groups[(p.platform ?? 'other').toLowerCase()];
  return g ? [g] : device && deviceWants(p) ? [device] : [];
};

for (const p of pushes) {
  const to = targets(p);
  if (!to.length) { console.log(`Skipped (no target for this server type): ${p.title}`); continue; }
  for (const t of to) {
    try {
      const res = await fetch(`${API}/notify-json/${encodeURIComponent(t.id)}?token=${encodeURIComponent(t.token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: p.title, text: p.text, groupType: p.groupType }),
      });
      const body = await res.text();
      // A group send answers 200 even when every member failed, so check its counts too.
      const counts = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      if (!res.ok) errors.push(`HTTP ${res.status} sending "${p.title}" to ${t.label}: ${body.slice(0, 200)}`);
      else if (counts.successCount === 0 && counts.failureCount > 0) errors.push(`no member of ${t.label} received "${p.title}"`);
      else console.log(`Sent to ${t.label}: ${p.title}`);
    } catch (e) {
      errors.push(`${e.cause?.code || e.message} sending "${p.title}" to ${t.label}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  writeFileSync('notify-error.txt', `Notify! push failed: ${errors.join('; ')}\n`);
}
