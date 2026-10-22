(() => {
  const bodyClone = document.body.cloneNode(true);
  bodyClone.querySelectorAll('script, style, nav, footer, header, iframe, noscript, svg').forEach((el) => el.remove());
  const text = (bodyClone.innerText || bodyClone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50000);
  return { text, characterCount: text.length, pageTitle: document.title, pageUrl: window.location.href };
})();
