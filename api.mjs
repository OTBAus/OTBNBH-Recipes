/* ==========================================================================
   THE PREP BOOK — shared store
   One book, one set of photos, shared by every device that opens the site.

     GET  /api/book        the whole book + its revision number
     GET  /api/rev         just the revision number (cheap poll)
     PUT  /api/book        save the book          (passcode required)
     POST /api/unlock      check a passcode
     POST /api/photo       upload a photo         (passcode required)
     GET  /api/photo/:id   serve an uploaded photo

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

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  });

/* Constant-time-ish compare so a wrong passcode doesn't leak its length. */
function passOk(req) {
  const expected = process.env.PREP_PASSCODE || '';
  const given = req.headers.get('x-prep-pass') || '';
  if (!expected) return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function sha(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const store = books();

  try {
    /* --- passcode check, so the lock screen can say yes or no ------------- */
    if (path === 'unlock') {
      if (req.method !== 'POST') return json({ error: 'method' }, 405);
      if (!process.env.PREP_PASSCODE) return json({ error: 'no-passcode-set' }, 503);
      return passOk(req) ? json({ ok: true }) : json({ error: 'passcode' }, 401);
    }

    /* --- the book -------------------------------------------------------- */
    if (path === 'book' || path === 'rev') {
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
      const id = path.slice('photo/'.length);
      if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(id)) return json({ error: 'not-found' }, 404);

      const blob = await store.getWithMetadata('photo/' + id, { type: 'arrayBuffer' });
      if (!blob) return json({ error: 'not-found' }, 404);

      return new Response(blob.data, {
        headers: {
          'content-type': (blob.metadata && blob.metadata.type) || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable'
        }
      });
    }

    return json({ error: 'not-found' }, 404);
  } catch (err) {
    console.error('prep-book api', err);
    return json({ error: 'server' }, 500);
  }
};

export const config = {
  path: ['/api/book', '/api/rev', '/api/unlock', '/api/photo', '/api/photo/*']
};
