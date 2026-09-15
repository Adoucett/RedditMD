# RedditMD

Export a Reddit post and its comment thread to compact markdown. Built to paste a whole conversation into an AI and ask what people are talking about.

The official Reddit JSON API is blocked in the browser now, and the old CORS-proxy approach from [farnots/RedditToMarkdown](https://github.com/farnots/RedditToMarkdown) is dead. This version reads the public [Arctic Shift](https://arctic-shift.photon-reddit.com) archive instead, with [PullPush](https://pullpush.io) as a backup. No server, no API keys.

## Use it

1. Open `index.html` locally, or enable GitHub Pages on this repo (`main` / root).
2. Paste a Reddit post URL.
3. Click **Export thread**.
4. Copy or download the markdown.

`?url=` on the page URL will auto-export:

`https://YOURNAME.github.io/RedditMD/?url=https://www.reddit.com/r/something/comments/abc123/title/`

Very new posts can take a while to show up in the archive. If export fails, open the Reddit URL, add `.json` before any query string, copy the page, and use **Paste Reddit JSON instead**.

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` / `/ (root)`.

## License

MIT. Inspired by [farnots/RedditToMarkdown](https://github.com/farnots/RedditToMarkdown).
