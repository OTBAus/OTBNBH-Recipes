# The Prep Book — shared across every device

The book now lives on the site instead of inside one browser. Edit a recipe on
the kitchen iPad and it appears on the phones and the office laptop within
about twenty seconds, or immediately on next open.

```
prep-book/
├── public/
│   ├── index.html          the book
│   └── photos/             the 12 photographs in the reel
├── netlify/functions/
│   └── api.mjs             the shared store
├── netlify.toml
└── package.json
```

---

## Deploy

**1. Put these files in a Git repo** and connect it to your Netlify site
(Site configuration → Build & deploy → Link repository). Or drag the folder
onto Netlify for a one-off deploy — but a repo is worth it, because the
passcode step below needs the environment variable to stick.

**2. Set the passcode.** Site configuration → Environment variables → Add:

| Key | Value |
| --- | --- |
| `PREP_PASSCODE` | your existing kitchen passcode |

This is the one step the site cannot do for you. Until it's set, unlocking
returns "no passcode set" and nothing can be saved.

**3. Deploy.** Netlify installs `@netlify/blobs`, builds the function, and
publishes `public/`. No build command is needed.

**4. First unlock publishes the book.** Open the site, hit **Edit**, enter the
passcode. The copy in your browser is sent up and becomes the shared book.
Do this once, from a device whose copy you trust — see *Before you deploy*
below.

---

## Before you deploy: whose copy wins?

Every device that has used the old site is holding its own edits in its own
browser. Whoever unlocks first after deploying publishes **their** copy, and
that becomes the book for everyone.

So, first: go to the device with the most up-to-date recipes, hit **Download
backup**, and keep that file. After deploying, unlock on that same device
(or on any device, then **Restore backup** with that file). Everything else
falls in line from there.

---

## How it behaves

**Saving.** Edits write to the device instantly, then go up to the site about
a second later. The edit bar shows a dot: green *Saved to all devices*, yellow
*Saving*, pink *Offline*.

**Other devices.** They check for changes every twenty seconds, and whenever
you switch back to the tab. A device sitting on a recipe page will update
itself as long as nobody is part-way through typing on it.

**No wifi.** Everything keeps working, saved on the device. The moment the
connection returns the changes go up. If you close the tab first, they're
still there when you reopen it — they are not thrown away.

**Two chefs at once.** Each save records which version it was based on. If
someone else saved while you were editing, your save is refused rather than
silently overwriting them, and a yellow band appears:

> Someone else saved changes. Keep this device's version, or take the one on
> the site?

**Keep mine** makes your copy the book. **Use theirs** takes the other one.
Nothing is lost without someone choosing.

**Photos.** The 12 photographs in the reel ship as files and are served from
Netlify's CDN. Photos added through **Add photos** are shrunk in the browser,
uploaded, and cached permanently. Added with no connection, a photo stays on
that device until it reconnects.

**Locking.** **Lock** forgets the passcode on that device. Do it on any shared
tablet at the end of service.

---

## Worth knowing

- **The passcode is stored on the device after unlocking**, so a tablet stays
  editable between shifts. That is convenient and it is also the weak point:
  anyone holding an unlocked tablet can edit the book. **Lock** clears it.
- **Everyone shares one passcode**, so the book records *what* changed but not
  *who* changed it. If you want per-chef logins and a history of edits, that's
  a bigger change — say the word.
- **Backups still work** and are still worth taking. **Download backup** now
  gives you the shared book; **Restore backup** replaces it for everyone.
- **`index.html` is 2.6 MB**, mostly the chapter illustrations baked into the
  file. It loads once and then caches. Moving those out to files as well would
  get it under 300 KB if the tablets are on slow wifi.
- **Reset to original** restores the recipes that shipped in the file, and then
  syncs that to every device. It is not an undo — take a backup first.

---

## If something looks wrong

**"Not published yet"** — nobody has unlocked and saved since deploying. Unlock
once.

**Unlocking says the passcode is wrong, but it's right** — `PREP_PASSCODE`
isn't set on the site, or was changed after the last deploy. Check it in
Netlify, then redeploy.

**A device is stuck showing old recipes** — it is probably offline; the dot in
the edit bar will say so. Otherwise reload it.

**You want to wipe everything and start again** — delete the `prep-book` blob
store in Netlify (Site configuration → Blobs), then unlock on a good device to
republish.
