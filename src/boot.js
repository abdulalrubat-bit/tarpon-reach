(() => {
  let ready = false;
  function failure(message) {
    if (ready) return;
    document.getElementById('bootmsg').textContent = 'COMMAND LINK INTERRUPTED';
    const detail = document.getElementById('boot-error'); detail.textContent = message; detail.classList.remove('hidden');
    document.getElementById('boot-retry').classList.remove('hidden');
  }
  window.addEventListener('error', event => failure(event.message || 'A required game file did not load. Please retry.'));
  window.addEventListener('DOMContentLoaded', () => {
    try { SE.boot(); } catch (error) { failure(error.message); }
    const started = performance.now();
    const timer = setInterval(() => {
      if (window.SE_READY) { ready = true; clearInterval(timer); }
      else if (performance.now() - started > 60000) { failure('Loading is taking longer than expected. Check the connection and retry.'); clearInterval(timer); }
      else if (performance.now() - started > 4500) document.getElementById('bootmsg').textContent = 'BUILDING YOUR CORNER OF THE UNIVERSE';
    }, 300);
  });
})();

/* Offline shell. Skipped on file:// so local runs and a WebView build never
   pick up a stale cache. */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
