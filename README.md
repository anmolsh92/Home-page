# anmolshrivastava.in

- `index.html` is the whole page.
- `api/posts.js` is the Vercel function. The page calls `/api/posts` on every load.
- `posts.config.json` is the only file you edit: starting lists per header, hide list, overrides, keyword rules, min and max.

## Deploy
Push this folder to the GitHub repo connected to the Vercel project. No build step and no dependencies.

## How the four rows are filled
1. Posts pinned on Substack that belong to a header come first (newest first).
2. Then the starting list for that header, in the order written in `posts.config.json`.
3. If a header would have fewer than `min` (3), the newest matching posts top it up.
4. Cut to `max` (6). If Substack can't be reached, the starting lists are shown.

## Common edits (all in posts.config.json)
- Post landed under the wrong header: add `"post-slug": "multiplayer | gtm | roi | misc"` to `overrides`.
- Keep a post off the site: add its slug to `hide`.
- Change how many show: edit `min` / `max`.
- A slug is the last part of the post link, after `/p/`.

## Check it works
Open `https://<your-site>/api/posts`. `"source": "archive"` means it read Substack with pins.
`"rss"` means the archive was unreachable (no pins). `"seed"` means neither worked and the starting lists are shown.
