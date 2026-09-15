/*
 * RedditMD worker — runs acquisition, filtering, and export generation off the
 * main thread. Falls back to the page thread automatically if a browser blocks
 * workers (e.g. some file:// contexts). Keeps the acquired dataset in memory so
 * filter changes never refetch.
 */
/* global RedditMD */
importScripts("./engine.js");

let current = null; // { post, index } for single mode
let bulk = null; // { subreddit, threads } for bulk mode
let controller = null;

function emit(update) {
  postMessage({ type: "progress", update: update });
}

function ctx() {
  controller = new AbortController();
  return { signal: controller.signal, emit: emit };
}

async function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("redditmd", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("threads");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function cacheGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const t = db.transaction("threads", "readonly").objectStore("threads").get(key);
      t.onsuccess = () => resolve(t.result || null);
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    return null;
  }
}
async function cachePut(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const t = db.transaction("threads", "readwrite").objectStore("threads").put(value, key);
      t.onsuccess = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    /* ignore cache errors */
  }
}

function finishSingle(opts, id) {
  RedditMD.finalize(current.index, opts.sort);
  const view = RedditMD.computeView(current.index, opts);
  const md = RedditMD.renderMarkdown(current.index, current.post, opts, view);
  postMessage({
    type: "result",
    id: id,
    mode: "single",
    md: md,
    post: current.post,
    filename: RedditMD.filenameFor(current.post, { postId: current.index.postId }),
    stats: {
      fetched: current.index.byId.size,
      exported: view.shown,
      authors: view.authors.size,
      maxDepth: view.maxDepth,
      unplaced: current.index.unresolved.length,
      collapsed: current.index.moreIds.size,
      source: current.index.source,
      capped: view.capped,
    },
  });
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === "cancel") {
      if (controller) controller.abort();
      return;
    }

    if (msg.type === "export") {
      const c = ctx();
      const parsed = await RedditMD.resolvePost(msg.input, c);
      const key = "single:" + parsed.postId;
      let dataset = null;
      if (!msg.refresh) {
        const cached = await cacheGet(key);
        if (cached && cached.records) {
          dataset = cached;
          emit({ phase: "cache", message: "Loaded cached thread — refreshing gaps…" });
        }
      }
      if (dataset) {
        const rebuilt = RedditMD.rebuildIndex(dataset);
        current = rebuilt;
        if (msg.opts.loadAll) {
          // resume/expand any remaining gaps
          try {
            const c2 = { signal: c.signal, emit: emit };
            await RedditMD.acquireArctic(parsed, msg.opts, c2).then((fresh) => {
              // merge fresh into cached
              fresh.index.byId.forEach((rec, id) => {
                if (!current.index.byId.has(id)) {
                  current.index.byId.set(id, rec);
                  current.index.seen.add(id);
                }
              });
              current.post = fresh.post;
            });
          } catch (err) {
            if (c.signal.aborted) throw err;
          }
        }
      } else {
        current = await RedditMD.acquire(parsed, msg.opts, c);
      }
      await cachePut(key, RedditMD.serializeDataset(current.post, current.index));
      finishSingle(msg.opts, msg.id);
      return;
    }

    if (msg.type === "reformat") {
      if (!current) return;
      finishSingle(msg.opts, msg.id);
      return;
    }

    if (msg.type === "json") {
      if (!current) return;
      RedditMD.finalize(current.index, msg.opts.sort);
      const json = JSON.stringify(RedditMD.buildJson(current.index, current.post, msg.opts), null, 2);
      postMessage({ type: "json", id: msg.id, json: json });
      return;
    }

    if (msg.type === "bulk") {
      const c = ctx();
      const subreddit = RedditMD.parseSubredditInput(msg.input);
      if (!subreddit) throw new Error("That does not look like a subreddit.");
      bulk = await RedditMD.acquireSubreddit(subreddit, msg.count, msg.opts, c);
      const md = RedditMD.renderBulkMarkdown(bulk.threads, msg.opts);
      let totalComments = 0;
      bulk.threads.forEach((t) => (totalComments += t.index.byId.size));
      postMessage({
        type: "bulkResult",
        id: msg.id,
        subreddit: subreddit,
        md: md,
        posts: bulk.threads.length,
        comments: totalComments,
        titles: bulk.threads.map((t) => ({ id: t.post.id, title: t.post.title, comments: t.index.byId.size, error: t.index.error || null })),
      });
      return;
    }

    if (msg.type === "bulkZip") {
      if (!bulk) return;
      const files = bulk.threads.map((t) => {
        RedditMD.finalize(t.index, msg.opts.sort);
        return {
          name: RedditMD.filenameFor(t.post, { postId: t.post.id }) + ".md",
          data: RedditMD.renderMarkdown(t.index, t.post, msg.opts),
        };
      });
      const blob = RedditMD.makeZipBlob(files);
      postMessage({ type: "bulkZip", id: msg.id, blob: blob, subreddit: bulk.subreddit });
      return;
    }
  } catch (err) {
    postMessage({ type: "error", id: msg.id, message: (err && err.message) || String(err), aborted: err && err.name === "AbortError" });
  }
};
