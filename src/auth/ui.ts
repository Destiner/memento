export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function page(content: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memento</title><link rel="stylesheet" href="/oauth/app.css"><script src="/oauth/app.js" defer></script></head><body><main><h1>Memento</h1>${content}<p id="error" role="alert"></p></main></body></html>`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}

export const style = `
:root { color-scheme: light dark; font: 16px/1.6 system-ui, sans-serif; background: light-dark(#f5f6f8, #15171b); color: light-dark(#232832, #e7eaf0); }
body { margin: 0; padding: 48px 20px; }
main { max-width: 620px; margin: 0 auto; padding: 32px; border: 1px solid light-dark(#dfe3e9, #343941); border-radius: 16px; background: light-dark(#fff, #1e2228); }
h1 { margin: 0 0 24px; font-size: 28px; letter-spacing: -.04em; }
h2 { font-size: 18px; margin-top: 28px; }
p { overflow-wrap: anywhere; }
code { font-size: 13px; padding: 3px 5px; background: light-dark(#f0f2f6, #2b3039); border-radius: 4px; overflow-wrap: anywhere; }
button { font: inherit; font-size: 14px; padding: 8px 14px; margin: 4px 4px 4px 0; border: 1px solid light-dark(#ccd2dd, #525b6b); border-radius: 8px; background: light-dark(#f8f9fc, #2c3441); color: inherit; cursor: pointer; }
button:hover { background: light-dark(#e9edf5, #3b4659); }
button:focus-visible { outline: 3px solid #6a8bde; outline-offset: 3px; }
button:disabled { opacity: .6; cursor: wait; }
ul { padding-left: 20px; }
li { margin: 12px 0; overflow-wrap: anywhere; }
#error { color: light-dark(#a12a24, #ffaaa4); }
#error:empty { display: none; }
@media (max-width: 480px) { body { padding: 20px 12px; } main { padding: 24px 20px; } }
`;

export const script = `
const error = document.getElementById('error');
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Request failed. Please try signing in again.');
  return r.status === 204 ? {} : r.json();
}
document.addEventListener('click', async event => {
  const b = event.target.closest('button');
  if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.provider) {
      const q = location.pathname === '/oauth/login' ? (new URLSearchParams(location.search).get('oauth_query') || location.search.slice(1)) : null;
      const result = await post('/api/auth/sign-in/social', { provider: b.dataset.provider, ...(q ? { oauth_query: q } : {}) });
      const u = new URL(result.url);
      if (u.protocol !== 'https:') throw new Error('Invalid sign-in destination');
      location.assign(u.href);
    } else if (b.dataset.consent) {
      const result = await post('/api/auth/oauth2/consent', { accept: b.dataset.consent === 'yes', oauth_query: new URLSearchParams(location.search).get('oauth_query') || location.search.slice(1) });
      // OAuth redirects are protocol destinations validated by the authorization server.
      location.assign(result.url);
    } else if (b.dataset.revoke) {
      await post('/oauth/revoke', { id: b.dataset.revoke }); location.assign('/');
    } else if (b.dataset.signout) {
      await post('/api/auth/sign-out', {}); location.assign('/');
    }
  } catch (e) { error.textContent = e.message; b.disabled = false; }
});
`;
