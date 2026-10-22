'use strict';

// The original standalone popup called Groq directly and is retired.
// The root manifest now opens the authenticated UI in extension/ instead.
document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('status');
  if (status) status.textContent = 'This legacy popup is disabled. Use the secure Smart Web Assistant popup.';
  document.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
});
