const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/public'));

const LEGAL = /privacy policy|privacybeleid|terms of service|algemene voorwaarden/i;
const FONTS = /fonts\.(googleapis|gstatic)\.com/;

app.post('/api/scan', async (req, res) => {
  let url;
  try {
    const raw = String(req.body.url || '').trim();
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let browser;
  try {
    // shortcut: no private-IP blocking (SSRF), add before exposing this publicly
    browser = await puppeteer.launch({ headless: 'shell' });
    const page = await browser.newPage();
    let fontRequest = false; // fonts pulled in by CSS @import never appear in the HTML
    page.on('request', r => { if (FONTS.test(r.url())) fontRequest = true; });
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
    await browser?.close();
  }
});

app.listen(process.env.PORT || 3000, () => console.log('SiteAudit on http://localhost:' + (process.env.PORT || 3000)));
