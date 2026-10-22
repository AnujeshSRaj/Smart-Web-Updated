/**
 * content.js
 * ──────────
 * Responsibility : Extract readable text from the current webpage's DOM.
 *
 * This script is INJECTED into the active tab by popup.js using
 * chrome.scripting.executeScript().  It runs in the context of the webpage —
 * NOT in the extension's context.
 *
 * How text extraction works:
 *  1. Clone the document body so we never modify the real page.
 *  2. Remove elements that are noise (scripts, ads, nav, etc.).
 *  3. Try to find a main content area (article, main, etc.).
 *  4. Fall back to the whole cloned body if no semantic element is found.
 *  5. Get the innerText, normalise whitespace, and trim to a size limit.
 *
 * Returns: { text: string, characterCount: number, usedMainContent: boolean }
 *          (the return value of an IIFE is what executeScript() resolves with)
 *
 * Security:
 *  - We NEVER eval() or execute any content found on the page.
 *  - The extracted text is treated as untrusted data everywhere it flows.
 *  - We use a DOM clone to avoid side effects on the live page.
 *
 * Known limitations (documented honestly):
 *  - Single-page apps that render content after a delay may yield incomplete text.
 *  - Some paywalled sites show very little text.
 *  - Heavily JavaScript-driven pages may not expose useful innerText.
 *  - This is not a production-grade article extractor like Readability.js.
 */
(() => {
  const MAX_CHARS = 40_000; // Hard cap before sending to backend (backend has its own limit too)

  // Tags whose content is always noise.
  const NOISE_TAGS = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
    'video', 'audio', 'picture', 'figure', 'form',
  ];

  // Roles / classes associated with navigation and boilerplate.
  const NOISE_SELECTORS = [
    'nav', 'header', 'footer',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '.cookie-banner', '.cookie-notice', '#cookie-banner',
    '.ad', '.advertisement', '.sidebar', '.widget',
    '[aria-hidden="true"]',
  ];

  // ── Clone the body ──────────────────────────────────────────────────────────
  // cloneNode(true) deep-clones the entire subtree without affecting the page.
  const clone = document.body.cloneNode(true);

  // ── Remove noise ────────────────────────────────────────────────────────────
  const allNoise = [...NOISE_TAGS, ...NOISE_SELECTORS].join(', ');
  clone.querySelectorAll(allNoise).forEach((el) => el.remove());

  // ── Find main content area ──────────────────────────────────────────────────
  // Prefer the most semantically meaningful container.
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
    if (el && el.innerText && el.innerText.trim().length > 200) {
      contentRoot = el;
      usedMainContent = true;
      break;
    }
  }

  // Fall back to the whole cloned body.
  if (!contentRoot) {
    contentRoot = clone;
  }

  // ── Extract and normalise text ──────────────────────────────────────────────
  const rawText = contentRoot.innerText || contentRoot.textContent || '';

  // Collapse runs of whitespace / blank lines into single spaces or newlines.
  const normalised = rawText
    .replace(/\r\n/g, '\n')          // Normalise line endings
    .replace(/[ \t]+/g, ' ')         // Collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')      // Collapse multiple blank lines
    .trim();

  // Apply the character limit.
  const text = normalised.slice(0, MAX_CHARS);

  return {
    text,
    characterCount: text.length,
    usedMainContent,
    pageTitle: document.title,
    pageUrl: window.location.href,
  };
})();
