// A demo across Tabs: a guide opens in a new tab, then a sign-in popup that closes itself.
// example.com only supplies a stable HTTPS origin. prepare() answers every page of it with a
// self-contained fixture, so this take never depends on that site's markup.
export const config = { name: 'tabs', url: 'https://example.com' };

const style = `<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; font:16px/1.5 system-ui, sans-serif; color:#111827 }
  .card { width:460px; padding:32px; border-radius:20px; background:white; box-shadow:0 20px 50px #1f29371f }
  h1 { margin:0 0 4px; font-size:24px } p { margin:0 0 24px; color:#6b7280 }
  a, button { display:block; box-sizing:border-box; width:100%; margin-top:12px; padding:14px; border:0; border-radius:10px;
    background:#4f46e5; color:white; font:600 16px system-ui; text-align:center; text-decoration:none; cursor:pointer }
  a { background:#eef2ff; color:#4338ca }
  .status { margin-top:20px; padding:12px 14px; border-radius:10px; background:#ecfdf5; color:#065f46; display:none }
</style>`;

const pages = {
  '/': `<!doctype html><title>Launch</title>${style}<body style="background:linear-gradient(135deg,#eef2ff,#fdf2f8)">
<main class="card">
  <h1>Launch workspace</h1>
  <p>Read the guide, then connect your repository.</p>
  <a href="/guide" target="_blank">Read the guide</a>
  <button id="connect">Connect GitHub</button>
  <div class="status" role="status"></div>
</main>
<script>
  document.querySelector('#connect').onclick = () => window.open('/connect', 'connect', 'popup,width=480,height=560');
  addEventListener('message', event => {
    if (event.origin !== location.origin) return;
    const status = document.querySelector('.status');
    status.textContent = 'Connected as ' + event.data.user;
    status.style.display = 'block';
  });
</script>`,
  '/guide': `<!doctype html><title>Guide</title>${style}<body style="background:linear-gradient(135deg,#ecfeff,#f0fdf4)">
<main class="card">
  <h1>Getting started</h1>
  <p>Your API key opens the Launch API to your scripts.</p>
  <button id="copy">Copy API key</button>
  <div class="status" role="status">Copied to the clipboard</div>
</main>
<script>document.querySelector('#copy').onclick = () => { document.querySelector('.status').style.display = 'block'; };</script>`,
  '/connect': `<!doctype html><title>Sign in</title>${style}<body style="background:#f9fafb">
<main class="card" style="width:auto;margin:24px;box-shadow:none">
  <h1>Authorize Launch</h1>
  <p>Launch will read your repositories.</p>
  <button id="authorize">Authorize</button>
</main>
<script>
  document.querySelector('#authorize').onclick = () => {
    window.opener.postMessage({ user: 'ada' }, location.origin);
    setTimeout(() => window.close(), 300);
  };
</script>`,
};

export async function prepare(page) {
  await page.context().route('https://example.com/**', route => {
    const body = pages[new URL(route.request().url()).pathname];
    return body ? route.fulfill({ contentType: 'text/html', body }) : route.fulfill({ status: 404 });
  });
  await page.goto('https://example.com/');
}

export async function run(d) {
  const workspace = d.page;
  await d.move(720, 700, 0);
  await d.at(0.8);
  // A link with target="_blank" opens a Tab, which comes in front.
  const guideOpened = workspace.waitForEvent('popup');
  await d.click(workspace.getByRole('link', { name: 'Read the guide' }));
  const guide = await guideOpened;
  await d.click(guide.getByRole('button', { name: 'Copy API key' }));
  await d.wait(1500);
  // Back to the workspace, which stays open behind the guide.
  await d.switchTo(workspace);
  await d.wait(600);
  // window.open opens a popup window over the workspace; it closes itself once authorized.
  const popupOpened = workspace.waitForEvent('popup');
  await d.click(workspace.getByRole('button', { name: 'Connect GitHub' }));
  const popup = await popupOpened;
  await d.wait(500);
  await d.click(popup.getByRole('button', { name: 'Authorize' }));
  await workspace.getByText('Connected as ada').waitFor();
  await d.wait(2500);
  const status = await workspace.getByRole('status').textContent();
  if (status !== 'Connected as ada') throw new Error(`Unexpected status: ${status}`);
  return { status, guideCopied: await guide.getByRole('status').isVisible() };
}
