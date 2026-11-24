const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');
const { ScanError } = require('./errors');

const stealth = StealthPlugin();
stealth.enabledEvasions.delete('user-agent-override');
const puppeteer = addExtra(require('puppeteer'));
puppeteer.use(stealth);

const LEGAL = /privacy policy|privacybeleid|terms of service|algemene voorwaarden/i;
const FONTS = /fonts\.(googleapis|gstatic)\.com/;
const NAV_TIMEOUT = 30000;
const CHALLENGE_WAIT = 12000;

const VIEWPORTS = [[1920, 1080], [1536, 864], [1440, 900], [1366, 768], [1280, 720], [1600, 900]];

const CHALLENGE_TITLE = /just a moment|attention required|access denied|verify you are human|security check|ddos-guard|pardon our interruption/i;
const CHALLENGE_MARKUP = /window\._cf_chl_opt|id="challenge-form"|id="cf-error-details"|captcha-delivery\.com\/captcha|id="px-captcha"|_Incapsula_Resource/i;

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

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const jitter = (n, range) => n - Math.floor(Math.random() * range);

function randomViewport() {
  const [width, height] = pick(VIEWPORTS);
  return { width: jitter(width, 24), height: jitter(height, 80), deviceScaleFactor: 1, isMobile: false, hasTouch: false };
}

function userAgentFor(browserVersion) {
  const full = browserVersion.split('/')[1] || '131.0.0.0';
  const major = full.split('.')[0];
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not_A Brand', version: '99' },
  ];
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: 'Win32',
    userAgentMetadata: {
      brands,
      fullVersionList: brands.map(b => ({ ...b, version: b.brand === 'Not_A Brand' ? '99.0.0.0' : full })),
      fullVersion: full,
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
  };
}

async function looksBlocked(page, response) {
  const status = response?.status() ?? 0;
  const server = response?.headers()['server'] || '';
  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  if (CHALLENGE_TITLE.test(title) || CHALLENGE_MARKUP.test(html)) return true;
  return [401, 403, 429].includes(status) || (status === 503 && /cloudflare|akamai|ddos-guard/i.test(server));
}

async function waitOutChallenge(page) {
  try {
    await page.waitForFunction(
      (t, m) => !new RegExp(t, 'i').test(document.title) && !new RegExp(m, 'i').test(document.documentElement.outerHTML),
      { timeout: CHALLENGE_WAIT, polling: 500 },
      CHALLENGE_TITLE.source, CHALLENGE_MARKUP.source,
    );
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function scan(url) {
  const viewport = randomViewport();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 45000,
      defaultViewport: viewport,
      args: [`--window-size=${viewport.width},${viewport.height}`, '--lang=en-US'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(userAgentFor(await browser.version()));
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    let fontRequest = false;
    const checked = new Map();

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

    let response;
    try {
      response = await page.goto(url.href, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    } catch (e) {
      if (e.name === 'TimeoutError') throw new ScanError('The site took too long to respond (30s).', 504, 'TIMEOUT');
      if (/ERR_NAME_NOT_RESOLVED/.test(e.message)) throw new ScanError('That domain does not exist.', 502, 'DNS');
      throw new ScanError('Could not load the site.', 502, 'LOAD_FAILED');
    }

    if (await looksBlocked(page, response) && !(await waitOutChallenge(page))) {
      throw new ScanError('Scan blocked by target site. It uses bot protection (e.g. Cloudflare) that stopped our scanner.', 403, 'BLOCKED');
    }

    const html = await page.content();
    const $ = cheerio.load(html);
    return {
      url: page.url(),
      gdprRisk: fontRequest || FONTS.test(html),
      missingPrivacy: !$('a').toArray().some(a => LEGAL.test($(a).text())),
      missingViewport: $('head meta[name="viewport"]').length === 0,
    };
  } finally {
    await browser?.close().catch(() => browser.process()?.kill('SIGKILL'));
  }
}

module.exports = { scan, isPublicHost };
