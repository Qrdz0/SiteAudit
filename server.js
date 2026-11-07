const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.bunny.net; font-src https://fonts.bunny.net https://cdn.jsdelivr.net");
  next();
});
app.use(express.static(__dirname + '/public'));

const LEGAL = /privacy policy|privacybeleid|terms of service|algemene voorwaarden/i;
const FONTS = /fonts\.(googleapis|gstatic)\.com/;

// SSRF: private, loopback, link-local, cloud metadata and reserved ranges
const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6');

async function isPublicHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h, family: net.isIP(h) }] : await dns.lookup(h, { all: true });
  return addrs.length > 0 && addrs.every(a => !blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'));
}

// Each scan is a full Chrome: cap concurrency and per-IP rate
const MAX_ACTIVE = 2, PER_MIN = 5;
let active = 0;
const hits = new Map(); // shortcut: in-memory, resets on restart and isn't shared across instances; use Redis if you scale out
function overLimit(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > PER_MIN;
}

app.post('/api/scan', async (req, res) => {
  let url;
  try {
    const raw = String(req.body.url || '').trim();
    if (raw.length > 2048) throw new Error();
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (overLimit(req.ip)) return res.status(429).json({ error: 'Too many scans, try again in a minute' });
  if (active >= MAX_ACTIVE) return res.status(503).json({ error: 'Scanner busy, try again shortly' });

  try {
    if (!(await isPublicHost(url.hostname))) return res.status(400).json({ error: 'Internal addresses are not allowed' });
  } catch {
    return res.status(502).json({ error: 'Could not resolve site' });
  }

  active++;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 45000 });
    const page = await browser.newPage();
    let fontRequest = false;
    const checked = new Map();

    // Vet every request (redirects, subresources), not just the typed URL
    await page.setRequestInterception(true);
    page.on('request', async r => {
      try {
        const u = new URL(r.url());
        if (u.protocol === 'data:' || u.protocol === 'blob:') return r.continue();
        if (!['http:', 'https:'].includes(u.protocol)) return r.abort();
        if (FONTS.test(u.href)) fontRequest = true;
        if (!checked.has(u.hostname)) checked.set(u.hostname, isPublicHost(u.hostname).catch(() => false));
        return (await checked.get(u.hostname)) ? r.continue() : r.abort();
      } catch {
        return r.abort();
      }
    });

    await page.goto(url.href, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    const $ = cheerio.load(html);
    res.json({
      url: page.url(),
      gdprRisk: fontRequest || FONTS.test(html),
      missingPrivacy: !$('a').toArray().some(a => LEGAL.test($(a).text())),
      missingViewport: $('head meta[name="viewport"]').length === 0,
    });
  } catch (e) {
    res.status(502).json({ error: e.name === 'TimeoutError' ? 'Timed out after 30s' : 'Could not load site' });
  } finally {
    await browser?.close().catch(() => browser.process()?.kill('SIGKILL'));
    active--;
  }
});

app.listen(process.env.PORT || 3000, () => console.log('SiteAudit on http://localhost:' + (process.env.PORT || 3000)));
