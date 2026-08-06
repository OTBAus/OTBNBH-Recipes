/* ==========================================================================
   THE MISE — shared store
   One book, one set of photos, shared by every device that opens the site.

     POST   /api/session     exchange the staff code for a session cookie
     DELETE /api/session     sign out
     GET    /api/book        the whole book + its revision number   (session)
     GET    /api/rev         just the revision number (cheap poll)  (session)
     PUT    /api/book        save the book                          (passcode)
     POST   /api/unlock      check the chef passcode
     POST   /api/photo       upload a photo                         (passcode)
     GET    /api/photo/:id   serve an uploaded photo                (session)

   Two different keys, doing two different jobs:

     MISE_STAFF_CODE  six digits. Lets you READ the book. Given to the floor.
     PREP_PASSCODE    lets you WRITE. Given to chefs.

   A passcode holder can always read — a chef shouldn't need two codes to open
   the book they are about to edit.

   Writes carry the revision they were based on. If the book moved on in the
   meantime the write is refused with 409 and the current book comes back, so
   two chefs editing at once can't quietly overwrite each other.
   ========================================================================== */
import { getStore } from '@netlify/blobs';

/* strong consistency: a save on the iPad must be visible to the next device
   that asks, not eventually visible */
const books = () => getStore({ name: 'prep-book', consistency: 'strong' });

const MAX_BOOK  = 12 * 1024 * 1024;
const MAX_PHOTO = 3 * 1024 * 1024;

const SESSION_DAYS = 30;
const COOKIE       = 'mise_session';

/* A six digit code is a million guesses. Unthrottled, a script walks the whole
   space in minutes and the gate may as well not be there. Failures are counted
   per IP and the door shuts for a while once they add up. */
const RL_MAX    = 8;
const RL_WINDOW = 15 * 60 * 1000;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  });

const enc = (s) => new TextEncoder().encode(s);

/* Compare in constant time so a wrong value doesn't leak how much was right. */
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function passOk(req) {
  const expected = process.env.PREP_PASSCODE || '';
  if (!expected) return false;
  return safeEqual(req.headers.get('x-prep-pass'), expected);
}

async function sha(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* --- sessions -------------------------------------------------------------
   The cookie is <expiry>.<signature>. There is nothing secret inside it; the
   signature is what makes it unforgeable, and the expiry is covered by the
   signature so it can't be extended by editing the cookie. */
async function signSession(expMs) {
  const secret = process.env.MISE_SESSION_SECRET || '';
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    'raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc('v1.' + expMs));
  return expMs + '.' + b64url(sig);
}

async function sessionOk(req) {
  const raw = (req.headers.get('cookie') || '')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.startsWith(COOKIE + '='))
    .map(s => s.slice(COOKIE.length + 1))[0];
  if (!raw) return false;

  const dot = raw.indexOf('.');
  if (dot < 1) return false;
  const expMs = raw.slice(0, dot);
  if (!/^\d{10,16}$/.test(expMs)) return false;
  if (Number(expMs) < Date.now()) return false;

  const expected = await signSession(expMs);
  return expected ? safeEqual(raw, expected) : false;
}

/* a session, or a chef passcode, is enough to read */
async function canRead(req) {
  return (await sessionOk(req)) || passOk(req);
}

function cookieHeader(token, maxAgeSec) {
  return [
    COOKIE + '=' + (token || ''),
    'Path=/',
    'Max-Age=' + maxAgeSec,
    'HttpOnly',                 /* not readable by page scripts */
    'Secure',
    'SameSite=Lax'
  ].join('; ');
}

/* --- throttling ----------------------------------------------------------- */
function clientIp(req) {
  return req.headers.get('x-nf-client-connection-ip') ||
         (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
         'unknown';
}

async function rateKey(req) {
  /* hashed so the store never holds a plain list of visitor IPs */
  return 'rl/' + (await sha(enc(clientIp(req) + '|' + (process.env.MISE_SESSION_SECRET || '')))).slice(0, 24);
}

async function rateCheck(store, key) {
  const rec = await store.get(key, { type: 'json' }).catch(() => null);
  if (!rec) return { blocked: false, n: 0 };
  if (Date.now() - rec.first > RL_WINDOW) return { blocked: false, n: 0 };
  return { blocked: rec.n >= RL_MAX, n: rec.n, first: rec.first };
}

async function rateBump(store, key, state) {
  const first = state.first && (Date.now() - state.first <= RL_WINDOW) ? state.first : Date.now();
  await store.setJSON(key, { n: (state.n || 0) + 1, first }).catch(() => {});
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const store = books();

  try {
    /* --- staff session --------------------------------------------------- */
    if (path === 'session') {
      if (req.method === 'DELETE') {
        return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
      }
      if (req.method !== 'POST') return json({ error: 'method' }, 405);

      const staff = process.env.MISE_STAFF_CODE || '';
      if (!staff || !process.env.MISE_SESSION_SECRET) {
        return json({ error: 'not-configured' }, 503);
      }

      const key = await rateKey(req);
      const state = await rateCheck(store, key);
      if (state.blocked) {
        const mins = Math.ceil((RL_WINDOW - (Date.now() - state.first)) / 60000);
        return json({ error: 'too-many', retryInMinutes: mins }, 429);
      }

      let given = '';
      try { given = String((await req.json()).code || ''); } catch { /* empty */ }

      if (!safeEqual(given, staff)) {
        await rateBump(store, key, state);
        const left = Math.max(0, RL_MAX - (state.n + 1));
        return json({ error: 'code', triesLeft: left }, 401);
      }

      await store.delete(key).catch(() => {});
      const maxAge = SESSION_DAYS * 24 * 60 * 60;
      const token = await signSession(Date.now() + maxAge * 1000);
      return json({ ok: true }, 200, { 'set-cookie': cookieHeader(token, maxAge) });
    }

    /* --- chef passcode, so the lock screen can say yes or no -------------- */
    if (path === 'unlock') {
      if (req.method !== 'POST') return json({ error: 'method' }, 405);
      if (!process.env.PREP_PASSCODE) return json({ error: 'no-passcode-set' }, 503);
      return passOk(req) ? json({ ok: true }) : json({ error: 'passcode' }, 401);
    }

    /* --- the book -------------------------------------------------------- */
    if (path === 'book' || path === 'rev') {
      if (req.method === 'GET' && !(await canRead(req))) {
        return json({ error: 'session' }, 401);
      }

      const current = await store.get('book', { type: 'json' });

      if (req.method === 'GET') {
        if (path === 'rev') return json({ rev: current ? current.rev : 0 });
        return current
          ? json({ rev: current.rev, updatedAt: current.updatedAt, book: current.book })
          : json({ rev: 0, book: null });
      }

      if (req.method === 'PUT') {
        if (!passOk(req)) return json({ error: 'passcode' }, 401);

        const text = await req.text();
        if (text.length > MAX_BOOK) return json({ error: 'too-large' }, 413);

        let book;
        try { book = JSON.parse(text); }
        catch { return json({ error: 'bad-json' }, 400); }
        if (!book || !Array.isArray(book.recipes) || !Array.isArray(book.chapters)) {
          return json({ error: 'not-a-book' }, 400);
        }

        /* refuse a save built on a stale copy, unless it's a deliberate overwrite */
        const sentRev = req.headers.get('x-prep-rev');
        const curRev = current ? current.rev : 0;
        if (sentRev !== 'force' && current && String(curRev) !== String(sentRev)) {
          return json(
            { error: 'conflict', rev: curRev, updatedAt: current.updatedAt, book: current.book },
            409
          );
        }

        const next = { rev: curRev + 1, updatedAt: new Date().toISOString(), book };
        await store.setJSON('book', next);
        return json({ rev: next.rev, updatedAt: next.updatedAt });
      }

      return json({ error: 'method' }, 405);
    }

    /* --- photos ---------------------------------------------------------- */
    if (path === 'photo' && req.method === 'POST') {
      if (!passOk(req)) return json({ error: 'passcode' }, 401);

      const type = (req.headers.get('content-type') || '').split(';')[0];
      if (!EXT[type]) return json({ error: 'not-an-image' }, 415);

      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return json({ error: 'empty' }, 400);
      if (buf.byteLength > MAX_PHOTO) return json({ error: 'too-large' }, 413);

      /* name the photo after its contents: the same photo uploaded twice
         costs nothing, and the URL can then be cached forever */
      const id = (await sha(buf)).slice(0, 24) + '.' + EXT[type];
      await store.set('photo/' + id, buf, { metadata: { type } });
      return json({ url: '/api/photo/' + id });
    }

    if (path.startsWith('photo/') && req.method === 'GET') {
      if (!(await canRead(req))) return json({ error: 'session' }, 401);

      const id = path.slice('photo/'.length);
      if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(id)) return json({ error: 'not-found' }, 404);

      const blob = await store.getWithMetadata('photo/' + id, { type: 'arrayBuffer' });
      if (!blob) return json({ error: 'not-found' }, 404);

      return new Response(blob.data, {
        headers: {
          'content-type': (blob.metadata && blob.metadata.type) || 'image/jpeg',
          /* private, not public: the contents are gated now, so a shared CDN
             must not keep a copy it would hand to an unauthenticated caller */
          'cache-control': 'private, max-age=31536000, immutable'
        }
      });
    }

    return json({ error: 'not-found' }, 404);
  } catch (err) {
    console.error('mise api', err);
    return json({ error: 'server' }, 500);
  }
};

export const config = {
  path: ['/api/book', '/api/rev', '/api/unlock', '/api/session',
         '/api/photo', '/api/photo/*']
};
