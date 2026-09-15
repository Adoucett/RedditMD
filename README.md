# RedditMD

Export Reddit threads — or a whole subreddit's latest posts — to compact markdown you can feed to an AI. Built to paste a whole conversation into a model and ask what people are talking about.

The official Reddit JSON API is blocked in the browser now, and the old CORS-proxy approach from [farnots/RedditToMarkdown](https://github.com/farnots/RedditToMarkdown) is dead. This version reads the public [Arctic Shift](https://arctic-shift.photon-reddit.com) archive instead, with [PullPush](https://pullpush.io) as a backup. No server, no API keys.

Live: **https://adoucett.github.io/RedditMD/**

## Use it

1. Open `index.html` locally, or use the live GitHub Pages link.
2. **Single thread:** paste a Reddit post URL, click Export.
3. **Bulk subreddit:** switch tabs, enter a subreddit and how many latest posts, click Pull subreddit.
4. Copy, download `.md` / `.json`, or (bulk) download a `.zip` of per-post files.

Presets: Compact for AI, Full archive, Top-level pulse, Highlights. After a thread loads, filters (min score, max comments, max depth, top-level only, timestamps, permalinks, OP tags, media stripping) reformat instantly without refetching.

`?url=` auto-exports a thread; `?sub=NAME&n=25` opens bulk mode pre-filled:

```
https://adoucett.github.io/RedditMD/?url=https://www.reddit.com/r/xxx/comments/abc123/
https://adoucett.github.io/RedditMD/?sub=dataisbeautiful&n=25
```

## How it holds up on big threads

- The fetch/parse/filter/render engine runs in a Web Worker so the UI never freezes; it falls back to the page thread automatically where workers are blocked (some `file://` contexts).
- Comment data is a flat normalized index (no recursion, no per-keystroke cloning). A ~5,500-comment thread loads in a few seconds and reformats in milliseconds.
- Resilient fetching: timeouts, retry with backoff, and `429` rate-limit waiting using Arctic Shift's reset headers. A Cancel button aborts in-flight pulls.
- Collapsed (`more`) comments are expanded in batches; a search sweep fills gaps with safe same-second pagination and deduplication.
- Completeness is reported honestly: exported vs fetched counts, plus any comments still collapsed or that could not be placed under a parent (shown in an "Unplaced comments" section rather than faked as top-level).
- Threads are cached in IndexedDB by post ID, so re-exports and filter changes don't refetch.

## Files

- `index.html` / `app.js` / `engine.js` / `reddit-worker.js` / `styles.css` — the full app.
- `RedditMDlite.html` — a minimal single-file backup exporter (Arctic Shift only, no worker).
- `tests/engine.test.js` — dependency-free tests: `node --test`.

## Limits (static app, no backend)

This is a zero-backend GitHub Pages site, so it depends entirely on public archives:

- Very new posts and comments can lag in the archive (often up to ~a day). If a thread is missing, open the Reddit URL, add `.json`, copy it, and use "Paste Reddit JSON instead."
- Archives can be rate-limited or temporarily down. The app retries and falls back, but uptime and 100% completeness cannot be guaranteed without a backend.
- Scores/comment counts can read as 0–1 for the first ~36 hours after posting; the tool treats those as advisory and reports what it actually fetched.
- Sorting is by score/new/old — not Reddit's "best/controversial" confidence ranking.
- Bulk mode with large counts produces large files; run it on desktop.

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` / `/ (root)`.

## License

MIT. Inspired by [farnots/RedditToMarkdown](https://github.com/farnots/RedditToMarkdown).
