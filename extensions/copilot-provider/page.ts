export const pageHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect GitHub Copilot · my-agent</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:64px 20px;background:#f6f8fa;color:#1f2328;
font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.shell{width:100%;max-width:440px;margin:0 auto}
.brand{display:flex;align-items:center;justify-content:center;gap:8px;
margin-bottom:24px;font-size:16px;font-weight:600;color:#59636e}
.brand-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;
background:#25292e;color:white;font:600 19px/1 monospace}
main{padding:28px;background:#fff;border:1px solid #d1d9e0;border-radius:8px;
box-shadow:0 1px 2px #1f23280a}
h1{margin:0 0 8px;font-size:23px;font-weight:600;letter-spacing:-.4px}
.intro{margin:0 0 24px;color:#59636e}
button{font:inherit;font-weight:500;cursor:pointer;border:1px solid #d1d9e0;border-radius:6px}
button:focus-visible,a:focus-visible{outline:2px solid #0969da;outline-offset:3px}
button:disabled{cursor:default;opacity:.65}
#account-action{width:100%;min-height:38px;padding:8px 16px}
.primary{background:#1f883d;color:#fff;border-color:#1f232826}
.primary:hover:enabled{background:#1a7f37}
.secondary{background:#f6f8fa;color:#25292e}
.secondary:hover:enabled{background:#eff2f5}
.danger{background:#fff;color:#cf222e}
.danger:hover:enabled{background:#ffebe9;border-color:#cf222e}
#status{display:flex;align-items:flex-start;gap:12px;padding:14px;margin-bottom:16px;
background:#f6f8fa;border:1px solid #d1d9e0;border-radius:6px}
#status-title{font-size:14px;font-weight:600;margin:0}
#status-message{margin:3px 0 0;font-size:13px;color:#59636e;overflow-wrap:anywhere}
.status-indicator{position:relative;flex:0 0 16px;height:16px;margin-top:3px;
border:2px solid #8c959f;border-radius:50%}
#status[data-tone="success"]{background:#dafbe1;border-color:#aceebb}
#status[data-tone="success"] .status-indicator{background:#1a7f37;border-color:#1a7f37}
#status[data-tone="success"] .status-indicator::after{content:"";position:absolute;
left:3px;top:1px;width:4px;height:7px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
#status[data-tone="danger"]{background:#ffebe9;border-color:#ffcecb}
#status[data-tone="danger"] .status-indicator{border-color:#cf222e}
#authorization{margin-top:24px;border-top:1px solid #d1d9e0;padding-top:20px}
.steps{margin:0;padding-left:22px}
.steps li{padding-left:4px;margin-bottom:20px}
.steps li:last-child{margin-bottom:0}
.steps li::marker{font-weight:600;color:#59636e}
.step-title{margin:0 0 10px;font-weight:600}
.step-hint{margin:8px 0 0;color:#59636e;font-size:13px}
.code-row{display:flex;align-items:center;justify-content:space-between;gap:8px;
padding:12px;background:#f6f8fa;border:1px solid #d1d9e0;border-radius:6px}
#device-code{font:600 23px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;
letter-spacing:1px;user-select:all;overflow-wrap:anywhere;min-width:0}
#copy-code{padding:5px 9px;white-space:nowrap;font-size:12px;background:#fff;color:#25292e}
#copy-code:hover{background:#eff2f5}
#github-link{color:#0969da;text-decoration:none;overflow-wrap:anywhere}
#github-link:hover{text-decoration:underline}
#error{margin:16px 0 0;padding:12px;background:#ffebe9;border:1px solid #ffcecb;
border-radius:6px;color:#82071e;font-size:13px;white-space:pre-wrap}
.privacy{margin:20px 0 0;color:#59636e;font-size:12px;text-align:center}
@media(max-width:480px){body{padding:28px 16px}main{padding:20px}h1{font-size:21px}}
</style><script src="/app.js" defer></script></head><body><div class="shell">
<div class="brand"><span class="brand-mark" aria-hidden="true">m</span>my-agent</div>
<main>
<h1>Connect GitHub Copilot</h1>
<p class="intro">Sign in with GitHub to connect this extension to your Copilot subscription.</p>
<div id="status" role="status" aria-live="polite" data-tone="neutral">
<span class="status-indicator" aria-hidden="true"></span>
<div><h2 id="status-title">Checking your connection</h2>
<p id="status-message">Please wait a moment.</p></div>
</div>
<button id="account-action" class="primary" type="button" disabled>Sign in with GitHub</button>
<section id="authorization" aria-label="GitHub device authorization" hidden>
<ol class="steps">
<li><p class="step-title">Copy your device code</p>
<div class="code-row"><code id="device-code"></code>
<button id="copy-code" type="button">Copy code</button></div></li>
<li><p class="step-title">Open GitHub and enter the code</p>
<a id="github-link" target="_blank" rel="noopener noreferrer"></a></li>
<li><p class="step-title">Approve access to your account</p>
<p class="step-hint">Keep this page open. Your connection status will update automatically.</p></li>
</ol>
</section>
<p id="error" role="alert" hidden></p>
<p class="privacy">Your credentials are encrypted and stored on this device.</p>
</main></div></body></html>`;

export const pageScript = `
const key = location.hash.slice(1) || sessionStorage.getItem('copilot-login-key') || '';
if (key) sessionStorage.setItem('copilot-login-key', key);
history.replaceState(null, '', location.pathname);
const accountAction = document.getElementById('account-action');
const status = document.getElementById('status');
const statusTitle = document.getElementById('status-title');
const statusMessage = document.getElementById('status-message');
const error = document.getElementById('error');
const authorization = document.getElementById('authorization');
const deviceCode = document.getElementById('device-code');
const githubLink = document.getElementById('github-link');
const copyCode = document.getElementById('copy-code');
const lifetime = new AbortController();
let closing = false;
let issuing = false;
let disconnected = false;
let latest;
let nextAction;
function setError(message) {
  error.textContent = message;
  error.hidden = !message;
}
async function call(path, method = 'GET') {
  const response = await fetch('/api/' + path, {
    method, headers: { authorization: 'Bearer ' + key }, cache: 'no-store', signal: lifetime.signal
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed.');
  return value;
}
function render(value) {
  if (closing || disconnected) return;
  latest = value;
  const titles = {
    'signed-out': 'Not connected', saved: 'Checking your connection',
    'requesting-code': 'Starting sign-in', 'waiting-authorization': 'Waiting for GitHub',
    verifying: 'Checking your connection', saving: 'Finishing sign-in',
    verified: 'Connected to GitHub Copilot', 'signing-out': 'Signing out',
    cancelling: 'Cancelling', cancelled: value.saved && !value.needsLogin ? 'Check cancelled' : 'Sign-in cancelled',
    failed: 'Connection needs attention'
  };
  statusTitle.textContent = titles[value.state];
  statusMessage.textContent = value.message;
  status.dataset.tone = value.state === 'verified' ? 'success' : value.state === 'failed' ? 'danger' : 'neutral';
  const finishing = ['saving', 'signing-out', 'cancelling'].includes(value.state);
  const connected = value.saved && !value.needsLogin;
  nextAction = value.busy ? 'cancel' : connected ? 'logout' : 'login';
  accountAction.className = value.busy ? 'secondary' : connected ? 'danger' : 'primary';
  accountAction.textContent = finishing
    ? { saving: 'Finishing sign-in...', 'signing-out': 'Signing out...', cancelling: 'Cancelling...' }[value.state]
    : value.busy ? 'Cancel' : connected ? 'Sign out' : 'Sign in with GitHub';
  accountAction.disabled = issuing || finishing;
  const instructions = value.state === 'waiting-authorization' ? value.authorization : undefined;
  if (deviceCode.textContent !== (instructions?.code || '')) copyCode.textContent = 'Copy code';
  authorization.hidden = !instructions;
  deviceCode.textContent = instructions?.code || '';
  githubLink.textContent = instructions?.url || '';
  if (instructions) githubLink.href = instructions.url;
  else githubLink.removeAttribute('href');
}
function disconnect(message) {
  disconnected = true;
  lifetime.abort();
  accountAction.disabled = true;
  authorization.hidden = true;
  deviceCode.textContent = '';
  githubLink.textContent = '';
  githubLink.removeAttribute('href');
  if (!closing) {
    statusTitle.textContent = 'Connection lost';
    setError(message);
  }
}
async function action(name) {
  issuing = true;
  accountAction.disabled = true;
  setError('');
  try { await call(name, 'POST'); }
  catch (failure) { if (!closing && !disconnected) setError(failure.message); }
  finally {
    issuing = false;
    if (latest) render(latest);
  }
}
accountAction.onclick = () => action(nextAction);
copyCode.onclick = async () => {
  const code = deviceCode.textContent;
  if (!code || authorization.hidden) return;
  try {
    await navigator.clipboard.writeText(code);
    if (deviceCode.textContent === code) copyCode.textContent = 'Copied';
    setError('');
  } catch {
    setError('Could not copy the code. Select and copy the displayed code manually.');
  }
};
window.addEventListener('pagehide', () => {
  closing = true;
  lifetime.abort();
  disconnect('');
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
async function connect() {
  try {
    const response = await fetch('/api/events', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + key }, cache: 'no-store', signal: lifetime.signal
    });
    if (!response.ok || !response.body) throw new Error('Could not connect the login page.');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += value;
        let end;
        while ((end = pending.indexOf('\\n\\n')) !== -1) {
          const event = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (!event.startsWith('data: ')) throw new Error('Invalid login status event.');
          render(JSON.parse(event.slice(6)));
        }
      }
    } finally { reader.releaseLock(); }
    if (!closing) throw new Error('The login page connection was lost.');
  } catch (failure) {
    if (!closing) disconnect(failure.message + ' Reload this page before trying again.');
  }
}
connect();
`;
