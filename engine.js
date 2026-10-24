/*
 * RedditMD engine — pure data + fetch core shared by the page and the Web Worker.
 * No DOM access. Safe to importScripts() in a worker, <script> in the page,
 * or require() in Node for tests. Browser-only APIs (fetch, indexedDB,
 * AbortController) are referenced inside functions, never at load time.
 */
(function (root) {
  "use strict";

  var ARCTIC = "https://arctic-shift.photon-reddit.com/api";
  var PULLPUSH = "https://api.pullpush.io/reddit";
  var VERSION = "2.2";

  var enc = encodeURIComponent;

  /* ------------------------------------------------------------------ */
  /* URL / ID parsing                                                    */
  /* ------------------------------------------------------------------ */

  // Pull the first Reddit URL out of messy paste text (share sheets, chat, etc.).
  function extractRedditUrl(input) {
    if (!input) return "";
    var text = String(input).trim();
    // Prefer share/short or comments URLs if several appear.
    var patterns = [
      /https?:\/\/(?:www\.|old\.|new\.|np\.|amp\.|m\.)?reddit\.com\/[^\s)\]>'"]+/gi,
      /https?:\/\/redd\.it\/[^\s)\]>'"]+/gi,
      /https?:\/\/(?:www\.)?reddit\.app\.link\/[^\s)\]>'"]+/gi,
      /(?:^|\s)((?:www\.|old\.|new\.|np\.)?reddit\.com\/[^\s)\]>'"]+)/gi,
      /(?:^|\s)(redd\.it\/[^\s)\]>'"]+)/gi,
    ];
    for (var p = 0; p < patterns.length; p++) {
      var m = text.match(patterns[p]);
      if (m && m.length) {
        var cand = m[0].trim().replace(/[.,;:!?)]+$/, "");
        if (/^https?:\/\//i.test(cand)) return cand;
        return "https://" + cand.replace(/^\/*/, "");
      }
    }
    return text;
  }

  function stripTracking(urlObj) {
    var drop = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_name",
      "share_id",
      "ref",
      "ref_source",
      "ref_campaign",
      "context",
      "rdt",
      "feature",
      "correlation_id",
    ];
    drop.forEach(function (k) {
      urlObj.searchParams.delete(k);
    });
    // Drop leftover empty query.
    if (![...urlObj.searchParams.keys()].length) urlObj.search = "";
    return urlObj;
  }

  function parseRedditUrl(input) {
    if (!input) return null;
    var value = extractRedditUrl(input);
    if (!value) return null;
    if (/^[a-z0-9]{4,10}$/i.test(value)) {
      return { postId: value.toLowerCase(), commentId: null, subreddit: null, shortPath: null, kind: "id" };
    }
    try {
      if (!/^https?:\/\//i.test(value)) value = "https://" + value.replace(/^\/*/, "");
      var url = stripTracking(new URL(value));
      var host = url.hostname.replace(/^www\./, "").toLowerCase();

      // redd.it/<id>
      if (host === "redd.it") {
        var rid = url.pathname.replace(/\//g, "");
        return rid ? { postId: rid.toLowerCase(), commentId: null, subreddit: null, shortPath: null, kind: "redd.it" } : null;
      }

      // Known Reddit hosts + mobile/share wrappers that keep a reddit path.
      var redditHost =
        /(^|\.)reddit\.com$/.test(host) ||
        host === "reddit.app.link" ||
        host === "click.redditmail.com";

      if (!redditHost) return null;

      var parts = url.pathname.split("/").filter(Boolean);

      // /r/<sub>/s/<code>  (iOS/Android share short links)
      // /u/<user>/s/<code>
      // /s/<code>
      if (parts[0] === "r" && parts[2] === "s" && parts[3]) {
        return {
          postId: null,
          commentId: null,
          subreddit: parts[1],
          shortPath: "/r/" + parts[1] + "/s/" + parts[3],
          kind: "share",
        };
      }
      if (parts[0] === "u" && parts[2] === "s" && parts[3]) {
        return {
          postId: null,
          commentId: null,
          subreddit: null,
          shortPath: "/u/" + parts[1] + "/s/" + parts[3],
          kind: "share",
        };
      }
      if (parts[0] === "s" && parts[1]) {
        return { postId: null, commentId: null, subreddit: null, shortPath: "/s/" + parts[1], kind: "share" };
      }

      // /r/<sub>/comments/<id>/...
      // /comments/<id>/...
      var at = parts.indexOf("comments");
      if (at >= 0 && parts[at + 1]) {
        return {
          postId: parts[at + 1].toLowerCase(),
          commentId: parts[at + 3] ? parts[at + 3].toLowerCase() : null,
          subreddit: parts[0] === "r" ? parts[1] : null,
          shortPath: null,
          kind: "comments",
        };
      }

      // Gallery / media deep links sometimes still include the post id as a query.
      var qId = url.searchParams.get("post") || url.searchParams.get("article");
      if (qId && /^[a-z0-9]{4,10}$/i.test(qId)) {
        return { postId: qId.toLowerCase(), commentId: null, subreddit: null, shortPath: null, kind: "query" };
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // Pretty-print a cleaned canonical URL after paste.
  function canonicalizeInput(input) {
    var parsed = parseRedditUrl(input);
    if (!parsed) return extractRedditUrl(input) || String(input || "").trim();
    if (parsed.shortPath) return "https://www.reddit.com" + parsed.shortPath;
    if (parsed.postId) {
      var base = parsed.subreddit
        ? "https://www.reddit.com/r/" + parsed.subreddit + "/comments/" + parsed.postId + "/"
        : "https://www.reddit.com/comments/" + parsed.postId + "/";
      if (parsed.commentId) base += "_/" + parsed.commentId + "/";
      return base;
    }
    return extractRedditUrl(input);
  }

  function scrapePostId(text) {
    if (!text) return null;
    var s = String(text);
    var patterns = [
      /https?:\/\/(?:www\.|old\.|new\.|np\.|amp\.|m\.)?reddit\.com\/r\/[^/\s"']+\/comments\/([a-z0-9]{4,10})\b/i,
      /https?:\/\/(?:www\.|old\.|new\.|np\.|amp\.|m\.)?reddit\.com\/comments\/([a-z0-9]{4,10})\b/i,
      /\/r\/[^/\s"']+\/comments\/([a-z0-9]{4,10})\b/i,
      /\/comments\/([a-z0-9]{4,10})\b/i,
      /"id"\s*:\s*"([a-z0-9]{4,10})"/i,
      /redd\.it\/([a-z0-9]{4,10})\b/i,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = s.match(patterns[i]);
      if (m) return m[1].toLowerCase();
    }
    return null;
  }

  function slug(s) {
    return (
      String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "post"
    );
  }

  function filenameFor(post, parsed) {
    var sub = slug((post && post.subreddit) || (parsed && parsed.subreddit) || "reddit");
    var id = (post && post.id) || (parsed && parsed.postId) || "thread";
    var title = slug((post && post.title) || "post").slice(0, 48);
    return "r-" + sub + "-" + id + "-" + title;
  }

  function fmtTime(utc) {
    if (!utc) return null;
    var d = new Date(Number(utc) * 1000);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }

  /* ------------------------------------------------------------------ */
  /* Normalized index                                                    */
  /* ------------------------------------------------------------------ */

  function newIndex(postId) {
    return {
      postId: postId,
      byId: new Map(),
      childIds: new Map(),
      rootIds: [],
      unresolved: [],
      moreIds: new Set(),
      seen: new Set(),
      sweepAfter: 0,
      failed: 0,
    };
  }

  function toRecord(raw) {
    var parent = raw.parent_id || "";
    var parentId = null;
    if (/^t1_/.test(parent)) parentId = parent.slice(3);
    else if (/^t3_/.test(parent)) parentId = null;
    else if (parent) parentId = parent;
    var score = raw.score != null ? raw.score : raw.ups != null ? raw.ups : null;
    return {
      id: raw.id,
      parentId: parentId,
      author: raw.author || null,
      score: score,
      created: Number(raw.created_utc || raw.created || 0),
      body: typeof raw.body === "string" ? raw.body : "",
      permalink: raw.permalink || null,
      distinguished: raw.distinguished || null,
      stickied: !!raw.stickied,
      isSubmitter: !!raw.is_submitter,
      edited: raw.edited ? Number(raw.edited) || true : false,
      flair: raw.author_flair_text || null,
    };
  }

  function addRaws(index, list) {
    var added = 0;
    for (var i = 0; i < (list ? list.length : 0); i++) {
      var raw = list[i] && list[i].data ? list[i].data : list[i];
      if (!raw || !raw.id) continue;
      var rec = toRecord(raw);
      var prev = index.byId.get(rec.id);
      if (!prev) {
        index.byId.set(rec.id, rec);
        index.seen.add(rec.id);
        added++;
      } else if ((rec.body ? rec.body.length : 0) > (prev.body ? prev.body.length : 0)) {
        index.byId.set(rec.id, rec);
      }
      index.moreIds.delete(rec.id);
    }
    return added;
  }

  function addMore(index, ids) {
    for (var i = 0; i < (ids ? ids.length : 0); i++) {
      var id = ids[i];
      if (id && !index.seen.has(id)) index.moreIds.add(id);
    }
  }

  // Flatten a Reddit/Arctic comment tree into raw records + collapsed ids.
  function collectRawFromTree(nodes) {
    var raws = [];
    var moreIds = [];
    var stack = (nodes || []).slice();
    while (stack.length) {
      var node = stack.pop();
      if (!node) continue;
      if (node.kind === "more") {
        var kids = (node.data && node.data.children) || [];
        for (var i = 0; i < kids.length; i++) moreIds.push(kids[i]);
        continue;
      }
      var data = node.data || node;
      if (data && data.id && (data.body != null || data.author != null)) raws.push(data);
      var replies = data && data.replies;
      var children = [];
      if (replies && typeof replies === "object") children = (replies.data && replies.data.children) || [];
      for (var j = 0; j < children.length; j++) stack.push(children[j]);
    }
    return { raws: raws, moreIds: moreIds };
  }

  function push2(map, key, value) {
    var arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(value);
  }

  function comparator(sort) {
    return function (a, b) {
      if (!a || !b) return 0;
      if (sort === "new") return b.created - a.created || String(a.id).localeCompare(String(b.id));
      if (sort === "old") return a.created - b.created || String(a.id).localeCompare(String(b.id));
      var sa = Number(a.score == null ? 0 : a.score);
      var sb = Number(b.score == null ? 0 : b.score);
      return sb - sa || a.created - b.created;
    };
  }

  function finalize(index, sort) {
    index.childIds = new Map();
    index.rootIds = [];
    index.unresolved = [];
    var it = index.byId.values();
    var step = it.next();
    while (!step.done) {
      var rec = step.value;
      if (rec.parentId == null) index.rootIds.push(rec.id);
      else if (index.byId.has(rec.parentId)) push2(index.childIds, rec.parentId, rec.id);
      else index.unresolved.push(rec.id);
      step = it.next();
    }
    var cmp = comparator(sort);
    var byId = index.byId;
    var wrap = function (x, y) {
      return cmp(byId.get(x), byId.get(y));
    };
    index.rootIds.sort(wrap);
    var vals = index.childIds.values();
    var vstep = vals.next();
    while (!vstep.done) {
      vstep.value.sort(wrap);
      vstep = vals.next();
    }
    index.unresolved.sort(wrap);
    return index;
  }

  function counts(index) {
    return { loaded: index.byId.size, collapsed: index.moreIds.size, unresolved: index.unresolved.length };
  }

  function isDeleted(rec) {
    return !rec.body || rec.body === "[deleted]" || rec.body === "[removed]";
  }

  /* ------------------------------------------------------------------ */
  /* Filtering / view (iterative, no cloning)                            */
  /* ------------------------------------------------------------------ */

  function computeView(index, opts) {
    var cap = opts.maxComments == null ? Infinity : opts.maxComments;
    var depthCap = opts.maxDepth == null ? Infinity : opts.maxDepth;
    var minScore = opts.minScore || 0;
    var ordered = [];
    var authors = new Set();
    var maxDepth = 0;
    var capped = false;

    function pass(rec) {
      if (!rec) return false;
      if (isDeleted(rec) && !opts.includeDeleted) return false;
      if (Number(rec.score == null ? 0 : rec.score) < minScore) return false;
      return true;
    }

    var roots = index.rootIds;
    var stack = [];
    for (var i = roots.length - 1; i >= 0; i--) stack.push({ id: roots[i], depth: 0 });
    while (stack.length) {
      if (ordered.length >= cap) {
        capped = true;
        break;
      }
      var frame = stack.pop();
      var rec = index.byId.get(frame.id);
      if (!rec) continue;
      var kids = index.childIds.get(frame.id) || [];
      if (!pass(rec)) {
        if (!opts.topLevelOnly && frame.depth <= depthCap) {
          for (var k = kids.length - 1; k >= 0; k--) stack.push({ id: kids[k], depth: frame.depth });
        }
        continue;
      }
      ordered.push({ id: frame.id, depth: frame.depth });
      authors.add(rec.author || "[deleted]");
      if (frame.depth > maxDepth) maxDepth = frame.depth;
      var recurse = !opts.topLevelOnly && frame.depth < depthCap;
      if (recurse) {
        for (var c = kids.length - 1; c >= 0; c--) stack.push({ id: kids[c], depth: frame.depth + 1 });
      }
    }

    var unplaced = [];
    if (opts.includeUnresolved !== false) {
      for (var u = 0; u < index.unresolved.length && ordered.length + unplaced.length < cap; u++) {
        var rr = index.byId.get(index.unresolved[u]);
        if (pass(rr)) {
          unplaced.push({ id: index.unresolved[u], depth: 0 });
          authors.add(rr.author || "[deleted]");
        }
      }
    }

    return {
      ordered: ordered,
      unplaced: unplaced,
      authors: authors,
      shown: ordered.length + unplaced.length,
      maxDepth: maxDepth,
      capped: capped,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function stripMedia(text) {
    return String(text)
      .replace(/!\[gif\]\([^)]+\)/gi, "")
      .replace(/!\[[^\]]*]\([^)]+\)/g, "")
      .replace(/https?:\/\/\S+\.(?:gif|png|jpe?g|webp|mp4)(?:\?\S+)?/gi, "")
      .replace(/https?:\/\/(?:i|preview)\.redd\.it\/\S+/gi, "")
      .replace(/https?:\/\/media\d*\.giphy\.com\/\S+/gi, "")
      .replace(/https?:\/\/(?:www\.)?giphy\.com\/\S+/gi, "");
  }

  function formatBody(text, opts) {
    var out = String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
    if (opts && opts.stripMedia) out = stripMedia(out);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  function oneLine(text, opts) {
    return formatBody(text, opts).replace(/\n+/g, " / ");
  }

  function meta(rec, opts, op) {
    var link = rec.permalink ? "https://www.reddit.com" + rec.permalink : null;
    return [
      rec.author ? "u/" + rec.author : "u/[deleted]",
      opts.markOp && rec.author && rec.author === op ? "OP" : null,
      rec.score != null ? "[" + rec.score + "]" : null,
      opts.timestamps ? fmtTime(rec.created) : null,
      rec.distinguished || null,
      rec.stickied ? "stickied" : null,
      opts.commentLinks && link ? link : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  function writeNodes(lines, ordered, index, opts, op) {
    for (var i = 0; i < ordered.length; i++) {
      var rec = index.byId.get(ordered[i].id);
      if (!rec) continue;
      var depth = ordered[i].depth;
      var m = meta(rec, opts, op);
      var body = formatBody(rec.body || "[deleted]", opts);
      if (opts.style === "tree") {
        var tpad = depth === 0 ? "##### " : "├" + repeat("─", depth) + " ";
        lines.push(tpad + oneLine(body, opts) + " — " + m);
      } else if (opts.style === "list") {
        var lpad = repeat("  ", depth) + "- ";
        var indented = body.split("\n").map(function (ln, idx) {
          return idx === 0 ? lpad + ln : repeat("  ", depth) + "  " + ln;
        });
        lines.push(indented.join("\n"));
        lines.push(repeat("  ", depth) + "  — " + m);
      } else {
        var pad = repeat("  ", depth);
        lines.push(pad + m);
        var parts = body.split("\n");
        for (var p = 0; p < parts.length; p++) lines.push(pad + parts[p]);
      }
      if (depth === 0 && opts.spaceTop) lines.push("");
    }
  }

  function repeat(s, n) {
    return n > 0 ? new Array(n + 1).join(s) : "";
  }

  function summaryLine(post, view, index, opts) {
    var bits = [
      "exported " + view.shown + " of " + index.byId.size + " fetched comments",
      view.authors.size + " authors",
      "max depth " + view.maxDepth,
    ];
    if (index.unresolved.length) bits.push(index.unresolved.length + " unplaced");
    if (index.moreIds.size) bits.push(index.moreIds.size + " still collapsed");
    var filters = ["sort " + opts.sort];
    if (opts.minScore) filters.push("min score " + opts.minScore);
    if (opts.maxDepth != null && isFinite(opts.maxDepth)) filters.push("max depth " + opts.maxDepth);
    if (opts.maxComments != null && isFinite(opts.maxComments)) filters.push("first " + opts.maxComments);
    if (opts.topLevelOnly) filters.push("top-level only");
    if (!opts.includeDeleted) filters.push("no deleted");
    return "Thread summary: " + bits.join(" · ") + ". Filters: " + filters.join(", ") + ".";
  }

  function renderMarkdown(index, post, opts, view) {
    view = view || computeView(index, opts);
    var lines = [];
    var when = fmtTime(post.created_utc);
    var permalink = post.permalink
      ? "https://www.reddit.com" + post.permalink
      : "https://www.reddit.com/comments/" + post.id;
    lines.push("# " + (post.title || "(untitled)"));
    lines.push("");
    lines.push(
      [
        post.subreddit ? "r/" + post.subreddit : null,
        post.author ? "u/" + post.author : null,
        when,
        isFinite(Number(post.score)) ? "score " + post.score : null,
        post.upvote_ratio != null ? Math.round(post.upvote_ratio * 100) + "% upvoted" : null,
        post.link_flair_text ? "flair: " + post.link_flair_text : null,
      ]
        .filter(Boolean)
        .join(" · ")
    );
    lines.push(permalink);
    if (post.url && !post.is_self && post.url !== permalink) lines.push(post.url);
    lines.push("");
    if (post.selftext) {
      lines.push(formatBody(post.selftext, opts));
      lines.push("");
    }
    if (opts.threadStats) {
      lines.push(summaryLine(post, view, index, opts));
      lines.push("");
    }
    lines.push("---");
    lines.push("");
    writeNodes(lines, view.ordered, index, opts, post.author);
    if (view.unplaced.length) {
      lines.push("");
      lines.push("## Unplaced comments (parent not captured)");
      lines.push("");
      writeNodes(lines, view.unplaced, index, opts, post.author);
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  function nest(ordered, index) {
    var rootOut = [];
    var stack = [];
    for (var i = 0; i < ordered.length; i++) {
      var rec = index.byId.get(ordered[i].id);
      if (!rec) continue;
      var depth = ordered[i].depth;
      var node = {
        id: rec.id,
        author: rec.author || "[deleted]",
        score: rec.score,
        created_utc: rec.created,
        permalink: rec.permalink ? "https://www.reddit.com" + rec.permalink : null,
        body: rec.body || "",
        depth: depth,
        replies: [],
      };
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      if (stack.length) stack[stack.length - 1].node.replies.push(node);
      else rootOut.push(node);
      stack.push({ depth: depth, node: node });
    }
    return rootOut;
  }

  function buildJson(index, post, opts, view) {
    view = view || computeView(index, opts);
    return {
      title: post.title,
      subreddit: post.subreddit,
      author: post.author,
      score: post.score,
      upvote_ratio: post.upvote_ratio,
      created_utc: post.created_utc,
      permalink: post.permalink ? "https://www.reddit.com" + post.permalink : null,
      url: post.url || null,
      selftext: post.selftext || "",
      source: index.source || null,
      stats: {
        fetched: index.byId.size,
        exported: view.shown,
        authors: view.authors.size,
        max_depth: view.maxDepth,
        unplaced: index.unresolved.length,
        collapsed_remaining: index.moreIds.size,
      },
      comments: nest(view.ordered, index),
      unplaced: nest(view.unplaced, index),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Resilient fetch                                                     */
  /* ------------------------------------------------------------------ */

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(resolve, ms);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(t);
          reject(abortError());
          return;
        }
        signal.addEventListener(
          "abort",
          function () {
            clearTimeout(t);
            reject(abortError());
          },
          { once: true }
        );
      }
    });
  }

  function abortError() {
    try {
      return new DOMException("Aborted", "AbortError");
    } catch (e) {
      var err = new Error("Aborted");
      err.name = "AbortError";
      return err;
    }
  }

  function FatalHttp(message, status) {
    this.name = "FatalHttp";
    this.message = message;
    this.status = status;
  }
  FatalHttp.prototype = Object.create(Error.prototype);

  async function fetchJson(url, ctx) {
    ctx = ctx || {};
    var signal = ctx.signal;
    var tries = ctx.tries || 4;
    var timeoutMs = ctx.timeoutMs || 25000;
    var attempt = 0;
    while (true) {
      attempt++;
      if (signal && signal.aborted) throw abortError();
      var ac = new AbortController();
      var onAbort = function () {
        ac.abort();
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      var timer = setTimeout(function () {
        ac.abort();
      }, timeoutMs);
      try {
        var res = await fetch(url, { headers: { Accept: "application/json" }, signal: ac.signal });
        if (res.status === 429 || res.status === 422 || res.status === 408) {
          var limitedBody = "";
          if (attempt >= tries) {
            limitedBody = await res.text().catch(function () {
              return "";
            });
            throw new FatalHttp(res.status + " " + limitedBody.slice(0, 120), res.status);
          }
          var reset = Number(res.headers.get("x-ratelimit-reset") || res.headers.get("retry-after") || 0);
          var wait = res.status === 429 ? Math.min(Math.max(reset || 3, 1), 30) * 1000 : Math.min(1500 * attempt, 5000);
          if (ctx.emit) {
            ctx.emit({
              phase: "wait",
              message: (res.status === 429 ? "Rate limited — waiting " : "Archive is slow — waiting ") + Math.ceil(wait / 1000) + "s…",
            });
          }
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          await sleep(wait, signal);
          continue;
        }
        if (res.status >= 500) throw new Error("HTTP " + res.status);
        if (!res.ok) {
          var body = await res.text().catch(function () {
            return "";
          });
          throw new FatalHttp(res.status + " " + body.slice(0, 120), res.status);
        }
        return await res.json();
      } catch (err) {
        if (signal && signal.aborted) throw abortError();
        if (err && err.name === "FatalHttp") throw err;
        if (attempt >= tries) throw err;
        var backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000) + Math.floor(Math.random() * 400);
        if (ctx.emit) ctx.emit({ phase: "retry", message: "Retrying (" + attempt + "/" + tries + ")…" });
        await sleep(backoff, signal);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }
  }

  function aborted(ctx) {
    return ctx && ctx.signal && ctx.signal.aborted;
  }

  /* ------------------------------------------------------------------ */
  /* Acquisition                                                         */
  /* ------------------------------------------------------------------ */

  // Arctic matches short-link paths literally. Encoding the slashes makes a
  // known link come back as an empty result.
  function arcticPathsParam(path) {
    return String(path || "")
      .split("/")
      .map(function (part) {
        return encodeURIComponent(part);
      })
      .join("/");
  }

  function destinationFromRedirect(location, body) {
    var loc = location || "";
    if (!loc && body) {
      var match = String(body).match(/href="([^"]+)"/i);
      if (match) loc = match[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    }
    if (!loc) return null;
    if (loc.charAt(0) === "/") loc = "https://www.reddit.com" + loc;
    var parsed = parseRedditUrl(loc);
    if (parsed && parsed.postId) return parsed;
    var id = scrapePostId(loc);
    if (!id) return null;
    return { postId: id, commentId: null, subreddit: null, shortPath: null, kind: "share" };
  }

  async function resolveViaArcticShortLinks(shortPath, ctx) {
    var res = await fetchJson(ARCTIC + "/short_links?paths=" + arcticPathsParam(shortPath), ctx);
    var rows = (res && res.data) || [];
    if (!Array.isArray(rows)) rows = [rows];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      var dest =
        (typeof row === "string" && row) ||
        row.resolved_path ||
        row.url ||
        row.permalink ||
        row.path ||
        null;
      if (!dest) continue;
      if (dest.charAt(0) === "/") dest = "https://www.reddit.com" + dest;
      var next = parseRedditUrl(dest);
      if (next && next.postId) return next;
      var scraped = scrapePostId(dest);
      if (scraped) return { postId: scraped, commentId: null, subreddit: null, shortPath: null, kind: "share" };
    }
    return null;
  }

  // Reddit answers /r/<sub>/s/<code> with a 301 whose Location (and HTML href)
  // is the canonical comments URL. Browsers hide that cross-origin redirect;
  // runtimes that can read it, including this app's tests, resolve it here.
  async function resolveViaDirectRedirect(shortPath, ctx) {
    var target = "https://www.reddit.com" + shortPath;
    if (ctx && ctx.signal && ctx.signal.aborted) throw abortError();
    var res = await fetch(target, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      },
      signal: ctx && ctx.signal,
    });
    if (!res || res.type === "opaqueredirect" || res.status === 0) return null;
    var loc = "";
    try {
      loc = res.headers.get("Location") || "";
    } catch (e) {
      loc = "";
    }
    var body = "";
    if (!loc) {
      try {
        body = await res.text();
      } catch (e2) {
        body = "";
      }
    }
    return destinationFromRedirect(loc, body) || (res.url && res.url !== target ? destinationFromRedirect(res.url, "") : null);
  }

  // Follow Reddit share redirects through CORS-friendly proxies and scrape the post id.
  async function resolveViaRedirectProxies(shortPath, ctx) {
    var target = "https://www.reddit.com" + shortPath;
    var proxies = [
      function (u) {
        return "https://api.allorigins.win/raw?url=" + enc(u);
      },
      function (u) {
        return "https://api.allorigins.win/get?url=" + enc(u);
      },
      function (u) {
        return "https://corsproxy.io/?" + enc(u);
      },
      function (u) {
        return "https://api.codetabs.com/v1/proxy?quest=" + enc(u);
      },
    ];
    for (var i = 0; i < proxies.length; i++) {
      if (ctx && ctx.signal && ctx.signal.aborted) throw abortError();
      var ac = new AbortController();
      var onAbort = function () {
        ac.abort();
      };
      if (ctx && ctx.signal) ctx.signal.addEventListener("abort", onAbort, { once: true });
      var timer = setTimeout(function () {
        ac.abort();
      }, 8000);
      try {
        if (ctx && ctx.emit) ctx.emit({ phase: "resolve", message: "Expanding share link…" });
        var res = await fetch(proxies[i](target), {
          headers: { Accept: "application/json, text/html, */*" },
          signal: ac.signal,
        });
        if (!res.ok) continue;
        var text = await res.text();
        try {
          var j = JSON.parse(text);
          if (j && typeof j.contents === "string") text = j.contents;
          else if (j && typeof j.content === "string") text = j.content;
        } catch (e) {
          /* plain text/html */
        }
        var id = scrapePostId(text);
        if (id) return { postId: id, commentId: null, subreddit: null, shortPath: null, kind: "share" };
      } catch (err) {
        if (ctx && ctx.signal && ctx.signal.aborted) throw err;
        continue;
      } finally {
        clearTimeout(timer);
        if (ctx && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      }
    }
    return null;
  }

  async function resolvePost(input, ctx) {
    var parsed = parseRedditUrl(input);
    if (!parsed) throw new Error("That does not look like a Reddit post URL.");
    if (parsed.postId) return parsed;
    if (parsed.shortPath) {
      if (ctx && ctx.emit) ctx.emit({ phase: "resolve", message: "Resolving share link…" });
      var fromArchive = null;
      try {
        fromArchive = await resolveViaArcticShortLinks(parsed.shortPath, ctx);
      } catch (err) {
        if (ctx && ctx.signal && ctx.signal.aborted) throw err;
      }
      if (fromArchive && fromArchive.postId) return fromArchive;

      var fromRedirect = null;
      try {
        fromRedirect = await resolveViaDirectRedirect(parsed.shortPath, ctx);
      } catch (err) {
        if (ctx && ctx.signal && ctx.signal.aborted) throw err;
      }
      if (fromRedirect && fromRedirect.postId) return fromRedirect;

      throw new Error("Couldn't expand that Reddit share link (/s/…).");
    }
    throw new Error("Could not find a post ID in that URL.");
  }

  function takeFromSet(set, n) {
    var out = [];
    var it = set.values();
    var step = it.next();
    while (!step.done && out.length < n) {
      out.push(step.value);
      step = it.next();
    }
    return out;
  }

  // Arctic Shift now requires date-form cursor values for search endpoints;
  // numeric Unix timestamps (including 0) produce HTTP 400. Keep the cursor
  // internally as seconds so old cached datasets remain compatible.
  function arcticDateCursor(seconds) {
    var value = Number(seconds);
    if (!isFinite(value) || value < 0) value = 0;
    return new Date(Math.floor(value) * 1000).toISOString();
  }

  async function expandAll(index, ctx) {
    var attempts = 0;
    while (index.moreIds.size && attempts < 400 && !aborted(ctx)) {
      attempts++;
      var batch = takeFromSet(index.moreIds, 500);
      if (ctx.emit)
        ctx.emit({ phase: "expand", message: "Expanding collapsed comments…", loaded: index.byId.size, collapsed: index.moreIds.size });
      var res;
      try {
        res = await fetchJson(ARCTIC + "/comments/ids?ids=" + batch.join(","), ctx);
      } catch (err) {
        if (aborted(ctx)) throw err;
        for (var i = 0; i < batch.length; i++) index.moreIds.delete(batch[i]);
        index.failed += batch.length;
        continue;
      }
      for (var j = 0; j < batch.length; j++) index.moreIds.delete(batch[j]);
      addRaws(index, (res && res.data) || []);
    }
  }

  async function gapSweep(index, post, ctx) {
    var expected = Number(post && post.num_comments) || 0;
    var missing = expected > 0 ? expected - index.byId.size : 0;
    // A one-comment difference is normal (removed comments, a count that moved).
    // Searching for it is what currently times out and used to fail the export.
    var suspect = index.moreIds.size > 0 || missing > 1;
    if (!suspect) return;
    var after = index.sweepAfter || 0;
    var guard = 0;
    var sweepCtx = Object.assign({}, ctx, { tries: 2, timeoutMs: 15000 });
    while (guard < 600 && !aborted(ctx)) {
      guard++;
      var res;
      try {
        res = await fetchJson(
          ARCTIC + "/comments/search?link_id=" + enc(index.postId) + "&limit=100&sort=asc&after=" + enc(arcticDateCursor(after)),
          sweepCtx
        );
      } catch (err) {
        if (aborted(ctx)) throw err;
        index.incomplete = true;
        break;
      }
      var batch = (res && res.data) || [];
      if (!batch.length) break;
      var maxCreated = after;
      var before = index.byId.size;
      for (var i = 0; i < batch.length; i++) {
        var cu = Number(batch[i].created_utc) || 0;
        if (cu > maxCreated) maxCreated = cu;
      }
      addRaws(index, batch);
      var gained = index.byId.size - before;
      if (ctx.emit)
        ctx.emit({ phase: "sweep", message: "Sweeping for missed comments…", loaded: index.byId.size, collapsed: index.moreIds.size });
      if (batch.length < 100) break;
      // Guarantee forward progress even when a single second holds >100 comments.
      if (gained === 0 || maxCreated <= after) after = after + 1;
      else after = maxCreated;
      index.sweepAfter = after;
    }
  }

  async function acquireArctic(parsed, opts, ctx) {
    if (ctx.emit) ctx.emit({ phase: "post", message: "Fetching post…" });
    var postRes = await fetchJson(ARCTIC + "/posts/ids?ids=" + enc(parsed.postId), ctx);
    var post = postRes && postRes.data && postRes.data[0];
    if (!post) throw new Error("Arctic Shift does not have that post yet.");

    if (ctx.emit) ctx.emit({ phase: "tree", message: "Fetching comment tree…" });
    var treeRes;
    try {
      treeRes = await fetchJson(
        ARCTIC + "/comments/tree?link_id=" + enc(parsed.postId) + "&limit=25000&start_breadth=100&start_depth=40",
        ctx
      );
    } catch (err) {
      if (aborted(ctx)) throw err;
      if (ctx.emit) ctx.emit({ phase: "tree", message: "Full tree unavailable — loading reduced tree…" });
      treeRes = await fetchJson(
        ARCTIC + "/comments/tree?link_id=" + enc(parsed.postId) + "&limit=2000&start_breadth=20&start_depth=12",
        ctx
      );
    }

    var index = newIndex(parsed.postId);
    var collected = collectRawFromTree((treeRes && treeRes.data) || []);
    addRaws(index, collected.raws);
    addMore(index, collected.moreIds);
    if (ctx.emit) ctx.emit({ phase: "built", message: "Building thread…", loaded: index.byId.size, collapsed: index.moreIds.size });

    if (opts.loadAll) {
      try {
        await expandAll(index, ctx);
        await gapSweep(index, post, ctx);
      } catch (err) {
        if (aborted(ctx)) throw err;
        index.incomplete = true;
      }
    }
    index.source = "arctic-shift";
    return { post: post, index: index };
  }

  async function acquirePullpush(parsed, opts, ctx) {
    if (ctx.emit) ctx.emit({ phase: "post", message: "Trying PullPush…" });
    var postRes = await fetchJson(PULLPUSH + "/search/submission/?ids=" + enc(parsed.postId), ctx);
    var post = postRes && postRes.data && postRes.data[0];
    if (!post) throw new Error("PullPush does not have that post.");
    var index = newIndex(parsed.postId);
    var after = 0;
    var guard = 0;
    while (guard < 600 && !aborted(ctx)) {
      guard++;
      var res = await fetchJson(
        PULLPUSH + "/search/comment/?link_id=" + enc(parsed.postId) + "&size=100&sort=asc&sort_type=created_utc&after=" + after,
        ctx
      );
      var batch = (res && res.data) || [];
      if (!batch.length) break;
      var maxCreated = after;
      var before = index.byId.size;
      for (var i = 0; i < batch.length; i++) {
        var cu = Number(batch[i].created_utc) || 0;
        if (cu > maxCreated) maxCreated = cu;
      }
      addRaws(index, batch);
      var gained = index.byId.size - before;
      if (ctx.emit) ctx.emit({ phase: "sweep", message: "Loading comments…", loaded: index.byId.size, collapsed: 0 });
      if (batch.length < 100) break;
      if (gained === 0 || maxCreated <= after) after = after + 1;
      else after = maxCreated;
    }
    index.source = "pullpush";
    return { post: post, index: index };
  }

  function indexFromRedditListing(data) {
    if (!Array.isArray(data) || data.length < 2) throw new Error("Need the usual Reddit listing JSON: [post, comments].");
    var post = data[0] && data[0].data && data[0].data.children && data[0].data.children[0] && data[0].data.children[0].data;
    if (!post) throw new Error("No post object in that JSON.");
    var index = newIndex(post.id);
    var collected = collectRawFromTree((data[1] && data[1].data && data[1].data.children) || []);
    addRaws(index, collected.raws);
    addMore(index, collected.moreIds);
    index.source = "pasted-json";
    return { post: post, index: index };
  }

  async function acquire(parsed, opts, ctx) {
    ctx = ctx || {};
    try {
      return await acquireArctic(parsed, opts, ctx);
    } catch (arcticErr) {
      if (aborted(ctx)) throw arcticErr;
      if (ctx.emit) ctx.emit({ phase: "fallback", message: "Archive missed — trying PullPush…" });
      try {
        return await acquirePullpush(parsed, opts, ctx);
      } catch (ppErr) {
        if (aborted(ctx)) throw ppErr;
        throw new Error(
          "Could not load that thread automatically (" +
            (arcticErr && arcticErr.message) +
            "). For brand-new posts, open the Reddit URL, add .json, and paste the JSON."
        );
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bulk subreddit mode                                                 */
  /* ------------------------------------------------------------------ */

  function parseSubredditInput(input) {
    if (!input) return null;
    var v = String(input).trim();
    if (/^https?:\/\//i.test(v) || /reddit\.com/i.test(v)) {
      try {
        var url = new URL(/^https?:\/\//i.test(v) ? v : "https://" + v);
        var parts = url.pathname.split("/").filter(Boolean);
        var at = parts.indexOf("r");
        if (at >= 0 && parts[at + 1]) return sanitizeSub(parts[at + 1]);
      } catch (e) {
        /* fall through */
      }
    }
    return sanitizeSub(v.replace(/^\/?r\//i, "").replace(/^\/+|\/+$/g, ""));
  }

  function sanitizeSub(name) {
    return /^[A-Za-z0-9][A-Za-z0-9_]{1,50}$/.test(name) ? name : null;
  }

  async function searchLatestPosts(subreddit, n, ctx) {
    var wanted = Math.max(1, Math.min(Number(n) || 10, 2000));
    var posts = [];
    var seen = new Set();
    var before = "";
    var guard = 0;
    while (posts.length < wanted && guard < 40 && !aborted(ctx)) {
      guard++;
      var pageSize = Math.min(100, wanted - posts.length);
      var url =
        ARCTIC +
        "/posts/search?subreddit=" +
        enc(subreddit) +
        "&sort=desc&limit=" +
        pageSize +
        (before !== "" && before != null ? "&before=" + enc(arcticDateCursor(before)) : "");
      var res = await fetchJson(url, ctx);
      var batch = (res && res.data) || [];
      if (!batch.length) break;
      var minCreated = before ? Number(before) : Infinity;
      for (var i = 0; i < batch.length; i++) {
        var p = batch[i];
        if (!p || !p.id || seen.has(p.id)) continue;
        seen.add(p.id);
        posts.push(p);
        var cu = Number(p.created_utc) || 0;
        if (cu < minCreated) minCreated = cu;
      }
      if (ctx.emit) ctx.emit({ phase: "list", message: "Listing posts… " + posts.length + "/" + wanted });
      if (batch.length < pageSize) break;
      before = String(minCreated);
    }
    return posts.slice(0, wanted);
  }

  async function acquireSubreddit(subreddit, n, opts, ctx) {
    ctx = ctx || {};
    var posts = await searchLatestPosts(subreddit, n, ctx);
    if (!posts.length) throw new Error("No posts found for r/" + subreddit + " in the archive.");
    var threads = [];
    for (var i = 0; i < posts.length; i++) {
      if (aborted(ctx)) throw abortError();
      var p = posts[i];
      if (ctx.emit)
        ctx.emit({ phase: "thread", message: "Thread " + (i + 1) + "/" + posts.length + ": " + (p.title || p.id).slice(0, 60), index: i, total: posts.length });
      var index = newIndex(p.id);
      try {
        var treeRes = await fetchJson(
          ARCTIC + "/comments/tree?link_id=" + enc(p.id) + "&limit=25000&start_breadth=100&start_depth=40",
          ctx
        );
        var collected = collectRawFromTree((treeRes && treeRes.data) || []);
        addRaws(index, collected.raws);
        addMore(index, collected.moreIds);
        if (opts.loadAll) {
          await expandAll(index, ctx);
          await gapSweep(index, p, ctx);
        }
      } catch (err) {
        if (aborted(ctx)) throw err;
        index.error = (err && err.message) || String(err);
      }
      index.source = "arctic-shift";
      threads.push({ post: p, index: index });
    }
    return { subreddit: subreddit, threads: threads };
  }

  function renderBulkMarkdown(threads, opts) {
    var out = [];
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      finalize(t.index, opts.sort);
      out.push(renderMarkdown(t.index, t.post, opts));
      out.push("\n\n<!-- ───────────────────────────── -->\n\n");
    }
    return out.join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
  }

  /* ------------------------------------------------------------------ */
  /* Minimal ZIP (STORE, no compression) — dependency-free              */
  /* ------------------------------------------------------------------ */

  var CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    CRC_TABLE = table;
    return table;
  }

  function crc32(bytes) {
    var table = crcTable();
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeZipBlob(files) {
    var encoder = new TextEncoder();
    var chunks = [];
    var central = [];
    var offset = 0;

    function u16(v) {
      return [v & 0xff, (v >>> 8) & 0xff];
    }
    function u32(v) {
      return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    }

    for (var i = 0; i < files.length; i++) {
      var nameBytes = encoder.encode(files[i].name);
      var dataBytes = files[i].data instanceof Uint8Array ? files[i].data : encoder.encode(String(files[i].data));
      var crc = crc32(dataBytes);
      var local = []
        .concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(dataBytes.length), u32(dataBytes.length), u16(nameBytes.length), u16(0));
      var localHeader = new Uint8Array(local);
      chunks.push(localHeader, nameBytes, dataBytes);
      var localSize = localHeader.length + nameBytes.length + dataBytes.length;
      central.push({ nameBytes: nameBytes, crc: crc, size: dataBytes.length, offset: offset });
      offset += localSize;
    }

    var centralChunks = [];
    var centralSize = 0;
    for (var c = 0; c < central.length; c++) {
      var e = central[c];
      var header = []
        .concat(
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(e.crc),
          u32(e.size),
          u32(e.size),
          u16(e.nameBytes.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(e.offset)
        );
      var headerBytes = new Uint8Array(header);
      centralChunks.push(headerBytes, e.nameBytes);
      centralSize += headerBytes.length + e.nameBytes.length;
    }

    var end = []
      .concat(
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(central.length),
        u16(central.length),
        u32(centralSize),
        u32(offset),
        u16(0)
      );
    var all = chunks.concat(centralChunks, [new Uint8Array(end)]);
    return new Blob(all, { type: "application/zip" });
  }

  /* ------------------------------------------------------------------ */
  /* Serialization for cache / worker transfer                           */
  /* ------------------------------------------------------------------ */

  function serializeDataset(post, index) {
    return {
      version: VERSION,
      savedAt: Date.now(),
      post: post,
      source: index.source || null,
      records: Array.from(index.byId.values()),
      moreIds: Array.from(index.moreIds),
      sweepAfter: index.sweepAfter || 0,
    };
  }

  function rebuildIndex(dataset) {
    var post = dataset.post || {};
    var index = newIndex(post.id);
    index.source = dataset.source || null;
    index.sweepAfter = dataset.sweepAfter || 0;
    var recs = dataset.records || [];
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (!r || !r.id) continue;
      index.byId.set(r.id, r);
      index.seen.add(r.id);
    }
    addMore(index, dataset.moreIds || []);
    return { post: post, index: index };
  }

  var api = {
    VERSION: VERSION,
    ARCTIC: ARCTIC,
    PULLPUSH: PULLPUSH,
    parseRedditUrl: parseRedditUrl,
    extractRedditUrl: extractRedditUrl,
    canonicalizeInput: canonicalizeInput,
    scrapePostId: scrapePostId,
    slug: slug,
    filenameFor: filenameFor,
    fmtTime: fmtTime,
    resolvePost: resolvePost,
    acquire: acquire,
    acquireArctic: acquireArctic,
    acquirePullpush: acquirePullpush,
    acquireSubreddit: acquireSubreddit,
    searchLatestPosts: searchLatestPosts,
    arcticDateCursor: arcticDateCursor,
    arcticPathsParam: arcticPathsParam,
    destinationFromRedirect: destinationFromRedirect,
    parseSubredditInput: parseSubredditInput,
    renderBulkMarkdown: renderBulkMarkdown,
    makeZipBlob: makeZipBlob,
    indexFromRedditListing: indexFromRedditListing,
    finalize: finalize,
    computeView: computeView,
    renderMarkdown: renderMarkdown,
    buildJson: buildJson,
    counts: counts,
    serializeDataset: serializeDataset,
    rebuildIndex: rebuildIndex,
    fetchJson: fetchJson,
    // exposed for tests
    _internal: {
      newIndex: newIndex,
      toRecord: toRecord,
      addRaws: addRaws,
      addMore: addMore,
      collectRawFromTree: collectRawFromTree,
      comparator: comparator,
      nest: nest,
      formatBody: formatBody,
      stripMedia: stripMedia,
      isDeleted: isDeleted,
      crc32: crc32,
    },
  };

  root.RedditMD = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
