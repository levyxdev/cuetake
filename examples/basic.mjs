// example.com only supplies a stable HTTPS origin. prepare() replaces the page
// with a self-contained fixture, so this take never depends on that site's markup.
export const config = { name: 'basic', url: 'https://example.com' };

const fixture = `<!doctype html>
<style>
  body { margin:0; height:100vh; display:grid; place-items:center; font:16px/1.5 system-ui, sans-serif;
    background:linear-gradient(135deg,#eef2ff,#fdf2f8); color:#111827 }
  .card { width:460px; padding:32px; border-radius:20px; background:white; box-shadow:0 20px 50px #1f29371f }
  h1 { margin:0 0 4px; font-size:24px } p { margin:0 0 24px; color:#6b7280 }
  label { display:block; margin-bottom:6px; font-size:14px; font-weight:600 }
  input { box-sizing:border-box; width:100%; padding:12px 14px; border:1px solid #d1d5db; border-radius:10px; font:inherit }
  input:focus { outline:2px solid #6366f1; border-color:transparent }
  button { margin-top:20px; width:100%; padding:14px; border:0; border-radius:10px; background:#4f46e5; color:white; font:600 16px system-ui }
  .toast { margin-top:20px; padding:12px 14px; border-radius:10px; background:#ecfdf5; color:#065f46; display:none }
</style>
<main class="card">
  <h1>Invite a teammate</h1>
  <p>They will get access to the Launch workspace.</p>
  <label for="email">Email</label>
  <input id="email" type="email" placeholder="name@company.com">
  <button>Send invite</button>
  <div class="toast" role="status"></div>
</main>
<script>
  document.querySelector('button').onclick = () => {
    const toast = document.querySelector('.toast');
    toast.textContent = 'Invite sent to ' + document.querySelector('#email').value;
    toast.style.display = 'block';
  };
</script>`;

export async function prepare(page) {
  await page.setContent(fixture);
}

export async function run(d) {
  await d.move(720, 640, 0);
  await d.at(0.8);
  await d.type(d.page.getByLabel('Email'), 'ada@example.com');
  await d.wait(400);
  await d.click(d.page.getByRole('button', { name: 'Send invite' }));
  await d.wait(3000);
  const status = await d.page.getByRole('status').textContent();
  if (status !== 'Invite sent to ada@example.com') throw new Error(`Unexpected status: ${status}`);
  return { status };
}
