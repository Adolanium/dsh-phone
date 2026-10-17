/**
 * App-support endpoints on the tailnet listener:
 *
 *   GET /__pair-bootstrap#c=<code>&n=<name>
 *     A tiny page that POSTs `/__pair` from inside the app's WKWebView. The
 *     pairing code travels in the URL fragment, so it never reaches this
 *     server in a request line and never appears in the page HTML. On success
 *     the page navigates to `dshphone://paired`, which the iOS app intercepts.
 *
 *   GET /__session
 *     A device-cookie-gated liveness/auth check used by the app's hidden
 *     WebView: 200 when the device cookie is live, 401 when it is missing or
 *     revoked. It avoids URLSession/ATS entirely.
 */
import { sendJson } from './http.js'

/** Exact path for the pairing bootstrap page. */
export const PAIR_BOOTSTRAP_PATH = '/__pair-bootstrap'

/** Exact path for the app's device-session probe. */
export const SESSION_PATH = '/__session'

/**
 * Render the pairing bootstrap page. The code is read from `location.hash` by
 * the page's script; it is deliberately absent from this HTML.
 * @returns HTML document.
 */
export function renderPairBootstrap() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Pair DSH Phone</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { padding: 32px; max-width: 320px; text-align: center; }
  #status { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  #status[data-state="error"] { color: #d14343; }
  #hint { font-size: 14px; line-height: 1.5; opacity: .7; margin: 0; }
</style>
</head>
<body>
<main>
  <div id="status" role="status">Pairing…</div>
  <p id="hint">Keep this screen open while the bridge checks the code.</p>
</main>
<script>
(function () {
  var status = document.getElementById('status');
  var hint = document.getElementById('hint');
  function fail(message) {
    status.textContent = message;
    status.dataset.state = 'error';
    hint.textContent = 'Close this sheet and scan a fresh code from DSH.';
  }
  var params = new URLSearchParams(location.hash.slice(1));
  var code = (params.get('c') || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  var name = params.get('n') || 'iPhone';
  if (!code) { fail('Missing pairing code.'); return; }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 12000);
  fetch('/__pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code, name: name }),
    credentials: 'same-origin',
    cache: 'no-store',
    signal: controller.signal
  }).then(function (response) {
    clearTimeout(timer);
    if (response.status === 204) {
      status.textContent = 'Paired';
      hint.textContent = 'Returning to DSH Phone…';
      location.replace('dshphone://paired');
      return;
    }
    return response.json().catch(function () { return {}; }).then(function () {
      if (response.status === 401) fail('Code expired or already used.');
      else if (response.status === 429) fail('Too many attempts. Wait 15 minutes and try a new code.');
      else fail('Pairing failed (' + response.status + ').');
    });
  }).catch(function () {
    clearTimeout(timer);
    fail('Could not reach the bridge.');
  });
})();
</script>
</body>
</html>`
}

/**
 * Serve the bootstrap page.
 * @param req - incoming request.
 * @param res - response to write.
 */
export function handleBootstrapRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      allow: 'GET, HEAD',
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end('method not allowed\n')
    return
  }
  const payload = Buffer.from(renderPairBootstrap(), 'utf8')
  res.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.length),
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(req.method === 'HEAD' ? undefined : payload)
}

/**
 * Reply to the app's device-session probe.
 * @param req - incoming request.
 * @param res - response to write.
 * @param options - auth owner.
 */
export function handleSessionRequest(req, res, { auth }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, code: 'method-not-allowed' }, { allow: 'GET' })
    return
  }
  const device = auth.deviceFromRequest(req)
  if (device === undefined) {
    sendJson(res, 401, { ok: false, code: 'pairing-required' })
    return
  }
  sendJson(res, 200, { ok: true })
}
