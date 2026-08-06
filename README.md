# The Mise — gated build

## Files

```
index.html                      front door (themise.com.au)
north-byron/index.html          the recipe app — recipes NO LONGER in the file
netlify/functions/api.mjs       replaces your existing function
_headers
netlify.toml                    yours, unchanged
```

## Set three environment variables first

Netlify → Site configuration → Environment variables. **Do this before
deploying** — the function fails closed, so without them nobody gets in.

| Variable | Value | Who it's for |
|---|---|---|
| `PREP_PASSCODE` | your existing chef passcode | chefs — lets them **write** |
| `MISE_STAFF_CODE` | a 6-digit number, e.g. `271828` | staff — lets them **read** |
| `MISE_SESSION_SECRET` | 40+ random characters | nobody — signs the cookie |

Generate the secret with:

```
openssl rand -base64 32
```

Never reuse the staff code or the passcode as the secret. If the secret leaks,
anyone can mint their own session cookie and the gate is off.

Changing `MISE_SESSION_SECRET` signs everyone out immediately. That's your
panic button if a code gets out — rotate the secret and the staff code
together, and every device has to sign in again.

## What changed

**Reads are now authenticated.** `GET /api/book`, `/api/rev` and `/api/photo/*`
return `401` without a valid session cookie or a chef passcode. Previously
anyone with the URL could download all 141 recipes as JSON.

**The recipes are no longer in the HTML.** They used to ship inside the page as
`var SEED`, so gating the API alone would have achieved nothing. The page now
carries only the chapter names and the gallery — structure, not content — and
fetches the book once it has a session.

**Guessing is throttled.** Eight wrong codes from one IP and that IP is locked
out for 15 minutes, right code included. Without this a six-digit code is a
million guesses a script walks in minutes.

**Writes are unchanged.** Still `PREP_PASSCODE` via `x-prep-pass`, still with
revision checks and 409 conflicts. A session cookie alone cannot write.
A chef passcode alone *can* read, so chefs don't need two codes.

## The trade-off you're accepting

A device that has opened the book before keeps working offline — the book is
cached in `localStorage` as it always was.

What breaks is the **first** load: a brand-new device, or one that's been
signed out, needs a working connection and a valid code before it shows
anything. Previously any device could open the page cold and read the whole
book with no network at all.

That is the cost of real gating, and it is unavoidable — if the recipes are in
the file, they aren't gated. Worth knowing before a Friday service.

## Rolling it out

1. Set the three variables.
2. Deploy.
3. Open `themise.com.au`, enter the staff code, confirm you land on the
   recipes and they load.
4. Go round the tablets and sign each one in **while you're on good wifi**.
   The cookie lasts 30 days and renews on each sign-in.

To check the gate is really on, open this in a private window:

```
themise.com.au/api/book
```

You should get `{"error":"session"}` and nothing else.
