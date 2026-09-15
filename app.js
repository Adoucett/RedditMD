/* global RedditMD */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var PREVIEW_LIMIT = 400000; // characters rendered into the <pre>; full text still downloads
  var mode = "single";
  var lastResult = null; // { md } for current single/bulk output
  var objectUrls = [];
  var reqId = 0;

  /* ------------------------------------------------------------------ */
  /* Backend: Web Worker when possible, main-thread engine otherwise     */
  /* ------------------------------------------------------------------ */

  function makeBackend(onProgress) {
    var worker = null;
    try {
      worker = new Worker("./reddit-worker.js");
    } catch (e) {
      worker = null;
    }

    if (worker) {
      var pending = {};
      worker.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === "progress") {
          onProgress(m.update);
          return;
        }
        var p = pending[m.id];
        if (!p) return;
        if (m.type === "error") {
          delete pending[m.id];
          p.reject(Object.assign(new Error(m.message), { aborted: m.aborted }));
        } else {
          delete pending[m.id];
          p.resolve(m);
        }
      };
      worker.onerror = function () {
        /* surfaced per-request via error messages */
      };
      var send = function (payload) {
        return new Promise(function (resolve, reject) {
          payload.id = ++reqId;
          pending[payload.id] = { resolve: resolve, reject: reject };
          worker.postMessage(payload);
        });
      };
      return {
        kind: "worker",
        export: function (input, opts, refresh) {
          return send({ type: "export", input: input, opts: opts, refresh: refresh });
        },
        reformat: function (opts) {
          return send({ type: "reformat", opts: opts });
        },
        json: function (opts) {
          return send({ type: "json", opts: opts }).then(function (m) {
            return m.json;
          });
        },
        bulk: function (input, count, opts) {
          return send({ type: "bulk", input: input, count: count, opts: opts });
        },
        bulkZip: function (opts) {
          return send({ type: "bulkZip", opts: opts }).then(function (m) {
            return m.blob;
          });
        },
        cancel: function () {
          worker.postMessage({ type: "cancel" });
        },
      };
    }

    return makeLocalBackend(onProgress);
  }

  // Main-thread fallback (file:// or blocked workers). Same behavior, no isolation.
  function makeLocalBackend(onProgress) {
    var current = null;
    var bulk = null;
    var controller = null;
    var ctx = function () {
      controller = new AbortController();
      return { signal: controller.signal, emit: onProgress };
    };
    var yield_ = function () {
      return new Promise(function (r) {
        setTimeout(r, 0);
      });
    };
    function singleResult(opts) {
      RedditMD.finalize(current.index, opts.sort);
      var view = RedditMD.computeView(current.index, opts);
      var md = RedditMD.renderMarkdown(current.index, current.post, opts, view);
      return {
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
      };
    }
    return {
      kind: "local",
      export: async function (input, opts) {
        var c = ctx();
        var parsed = await RedditMD.resolvePost(input, c);
        current = await RedditMD.acquire(parsed, opts, c);
        await yield_();
        return singleResult(opts);
      },
      reformat: async function (opts) {
        if (!current) return null;
        await yield_();
        return singleResult(opts);
      },
      json: async function (opts) {
        if (!current) return "";
        RedditMD.finalize(current.index, opts.sort);
        return JSON.stringify(RedditMD.buildJson(current.index, current.post, opts), null, 2);
      },
      bulk: async function (input, count, opts) {
        var c = ctx();
        var sub = RedditMD.parseSubredditInput(input);
        if (!sub) throw new Error("That does not look like a subreddit.");
        bulk = await RedditMD.acquireSubreddit(sub, count, opts, c);
        var md = RedditMD.renderBulkMarkdown(bulk.threads, opts);
        var total = 0;
        bulk.threads.forEach(function (t) {
          total += t.index.byId.size;
        });
        return {
          mode: "bulk",
          subreddit: sub,
          md: md,
          posts: bulk.threads.length,
          comments: total,
          titles: bulk.threads.map(function (t) {
            return { id: t.post.id, title: t.post.title, comments: t.index.byId.size, error: t.index.error || null };
          }),
        };
      },
      bulkZip: async function (opts) {
        if (!bulk) return null;
        var files = bulk.threads.map(function (t) {
          RedditMD.finalize(t.index, opts.sort);
          return {
            name: RedditMD.filenameFor(t.post, { postId: t.post.id }) + ".md",
            data: RedditMD.renderMarkdown(t.index, t.post, opts),
          };
        });
        return RedditMD.makeZipBlob(files);
      },
      cancel: function () {
        if (controller) controller.abort();
      },
    };
  }

  var backend = null;

  /* ------------------------------------------------------------------ */
  /* UI plumbing                                                         */
  /* ------------------------------------------------------------------ */

  function setStatus(message, kind) {
    var el = $("status");
    el.hidden = !message;
    el.className = "status " + (kind || "");
    el.textContent = message || "";
  }

  function showProgress(update) {
    var bar = $("progressBar");
    var wrap = $("progress");
    wrap.hidden = false;
    if (update && update.total) {
      var pct = Math.min(100, Math.round(((update.index + 1) / update.total) * 100));
      bar.style.width = pct + "%";
      bar.classList.remove("indeterminate");
    } else {
      bar.classList.add("indeterminate");
    }
    var msg = update && update.message ? update.message : "Working…";
    if (update && update.loaded != null) {
      msg += " (" + update.loaded + " loaded" + (update.collapsed ? ", " + update.collapsed + " collapsed" : "") + ")";
    }
    setStatus(msg);
  }

  function hideProgress() {
    $("progress").hidden = true;
    $("progressBar").classList.remove("indeterminate");
    $("progressBar").style.width = "0%";
  }

  function setBusy(busy) {
    $("exportBtn").disabled = busy;
    $("jsonBtn").disabled = busy;
    $("cancelBtn").hidden = !busy;
    document.querySelectorAll(".chip").forEach(function (b) {
      b.disabled = busy;
    });
  }

  function clearObjectUrls() {
    objectUrls.forEach(function (u) {
      URL.revokeObjectURL(u);
    });
    objectUrls = [];
  }

  function armDownload(id, blob, name) {
    var el = $(id);
    var url = URL.createObjectURL(blob);
    objectUrls.push(url);
    el.href = url;
    el.download = name;
    el.removeAttribute("aria-disabled");
    el.hidden = false;
  }

  function numOr(value, fallback) {
    if (String(value).trim() === "") return fallback;
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function readOptions() {
    return {
      includeDeleted: $("includeDeleted").checked,
      spaceTop: $("spaceTop").checked,
      timestamps: $("timestamps").checked,
      commentLinks: $("commentLinks").checked,
      markOp: $("markOp").checked,
      stripMedia: $("stripMedia").checked,
      threadStats: $("threadStats").checked,
      topLevelOnly: $("topLevelOnly").checked,
      loadAll: $("loadAll").checked,
      minScore: numOr($("minScore").value, 0),
      maxComments: numOr($("maxComments").value, null),
      maxDepth: numOr($("maxDepth").value, null),
      style: (document.querySelector('input[name="style"]:checked') || {}).value || "compact",
      sort: (document.querySelector('input[name="sort"]:checked') || {}).value || "score",
    };
  }

  function renderPreview(md) {
    var note = $("previewNote");
    if (md.length > PREVIEW_LIMIT) {
      $("output").textContent = md.slice(0, PREVIEW_LIMIT) + "\n\n… preview truncated — use Download for the full file.";
      note.hidden = false;
      note.textContent = "Preview shows the first " + Math.round(PREVIEW_LIMIT / 1000) + "k characters. The download contains everything.";
    } else {
      $("output").textContent = md;
      note.hidden = true;
    }
    $("outputBlock").hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  async function runExport(refresh) {
    var opts = readOptions();
    if (mode === "bulk") return runBulk(opts);
    var input = $("url").value.trim();
    if (!input) {
      setStatus("Paste a Reddit post URL first.", "bad");
      return;
    }
    setBusy(true);
    clearObjectUrls();
    setStatus("Looking up the thread…");
    try {
      var result = await backend.export(input, opts, refresh);
      lastResult = result;
      renderPreview(result.md);
      armDownload("downloadBtn", new Blob([result.md], { type: "text/markdown;charset=utf-8" }), result.filename + ".md");
      $("jsonBtnDl").removeAttribute("aria-disabled");
      $("zipBtn").hidden = true;
      $("copyBtn").disabled = false;
      showStats(result.stats);
    } catch (err) {
      if (err && err.aborted) setStatus("Cancelled.", "");
      else setStatus(err.message || String(err), "bad");
    } finally {
      setBusy(false);
      hideProgress();
    }
  }

  async function runBulk(opts) {
    var input = $("subreddit").value.trim();
    var count = numOr($("bulkCount").value, 10);
    if (!input) {
      setStatus("Enter a subreddit first.", "bad");
      return;
    }
    setBusy(true);
    clearObjectUrls();
    setStatus("Listing posts…");
    try {
      var result = await backend.bulk(input, count, opts);
      lastResult = result;
      renderPreview(result.md);
      armDownload("downloadBtn", new Blob([result.md], { type: "text/markdown;charset=utf-8" }), "r-" + result.subreddit + "-latest-" + result.posts + ".md");
      $("jsonBtnDl").setAttribute("aria-disabled", "true");
      $("zipBtn").hidden = false;
      $("zipBtn").setAttribute("aria-disabled", "true");
      $("copyBtn").disabled = false;
      var errs = result.titles.filter(function (t) {
        return t.error;
      }).length;
      $("stats").hidden = false;
      $("stats").textContent =
        result.posts + " posts · " + result.comments + " comments" + (errs ? " · " + errs + " failed" : "");
      setStatus("Pulled " + result.posts + " posts from r/" + result.subreddit + ".", "ok");
      // Pre-arm the zip lazily on click
    } catch (err) {
      if (err && err.aborted) setStatus("Cancelled.", "");
      else setStatus(err.message || String(err), "bad");
    } finally {
      setBusy(false);
      hideProgress();
    }
  }

  function showStats(s) {
    $("stats").hidden = false;
    var parts = [
      s.exported + " shown",
      s.fetched + " fetched",
      s.authors + " authors",
      "depth " + s.maxDepth,
    ];
    if (s.unplaced) parts.push(s.unplaced + " unplaced");
    if (s.collapsed) parts.push(s.collapsed + " still collapsed");
    parts.push(s.source);
    $("stats").textContent = parts.join(" · ");
    var warn = s.collapsed || s.unplaced;
    setStatus(
      "Exported " + s.exported + " of " + s.fetched + " fetched comments." + (warn ? " Some comments could not be fully resolved (see summary)." : ""),
      warn ? "" : "ok"
    );
  }

  var reformatTimer = null;
  function scheduleReformat() {
    if (!lastResult || mode !== "single") return;
    clearTimeout(reformatTimer);
    reformatTimer = setTimeout(async function () {
      var opts = readOptions();
      try {
        var result = await backend.reformat(opts);
        if (!result) return;
        lastResult = result;
        clearObjectUrls();
        renderPreview(result.md);
        armDownload("downloadBtn", new Blob([result.md], { type: "text/markdown;charset=utf-8" }), result.filename + ".md");
        $("jsonBtnDl").removeAttribute("aria-disabled");
        showStats(result.stats);
      } catch (err) {
        setStatus(err.message || String(err), "bad");
      }
    }, 180);
  }

  async function downloadJson() {
    if (!lastResult || mode !== "single") return;
    setStatus("Building JSON…");
    try {
      var json = await backend.json(readOptions());
      var blob = new Blob([json], { type: "application/json" });
      triggerDownload(blob, (lastResult.filename || "thread") + ".json");
      setStatus("JSON ready.", "ok");
    } catch (err) {
      setStatus(err.message || String(err), "bad");
    }
  }

  async function downloadZip() {
    if (mode !== "bulk" || !lastResult) return;
    setStatus("Zipping per-post files…");
    try {
      var blob = await backend.bulkZip(readOptions());
      triggerDownload(blob, "r-" + lastResult.subreddit + "-latest-" + lastResult.posts + ".zip");
      setStatus("ZIP ready.", "ok");
    } catch (err) {
      setStatus(err.message || String(err), "bad");
    }
  }

  function triggerDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    objectUrls.push(url);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function exportFromJson() {
    var text = $("jsonInput").value.trim();
    if (!text) {
      setStatus("Paste Reddit JSON first.", "bad");
      return;
    }
    if (text.length > 60000000) {
      setStatus("That JSON is very large — try a smaller thread.", "bad");
      return;
    }
    var opts = readOptions();
    try {
      var data = JSON.parse(text);
      var built = RedditMD.indexFromRedditListing(data);
      RedditMD.finalize(built.index, opts.sort);
      var view = RedditMD.computeView(built.index, opts);
      var md = RedditMD.renderMarkdown(built.index, built.post, opts, view);
      lastResult = { md: md, filename: RedditMD.filenameFor(built.post, { postId: built.index.postId }), local: built };
      mode = "single";
      clearObjectUrls();
      renderPreview(md);
      armDownload("downloadBtn", new Blob([md], { type: "text/markdown;charset=utf-8" }), lastResult.filename + ".md");
      $("copyBtn").disabled = false;
      showStats({
        exported: view.shown,
        fetched: built.index.byId.size,
        authors: view.authors.size,
        maxDepth: view.maxDepth,
        unplaced: built.index.unresolved.length,
        collapsed: built.index.moreIds.size,
        source: "pasted-json",
      });
    } catch (err) {
      setStatus("JSON parse failed: " + (err.message || err), "bad");
    }
  }

  async function copyOutput() {
    try {
      var text = lastResult ? lastResult.md : $("output").textContent;
      await navigator.clipboard.writeText(text);
      setStatus("Copied to clipboard.", "ok");
    } catch (err) {
      setStatus("Copy failed — use Download instead.", "bad");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Presets + mode                                                      */
  /* ------------------------------------------------------------------ */

  var PRESETS = {
    ai: { style: "compact", minScore: "", maxComments: "", maxDepth: "", topLevelOnly: false, includeDeleted: false, stripMedia: true, timestamps: false, commentLinks: false, threadStats: true, sort: "score" },
    full: { style: "compact", minScore: "", maxComments: "", maxDepth: "", topLevelOnly: false, includeDeleted: true, stripMedia: false, timestamps: true, commentLinks: true, threadStats: true, sort: "old" },
    pulse: { style: "compact", minScore: "", maxComments: "", maxDepth: "0", topLevelOnly: true, includeDeleted: false, stripMedia: true, timestamps: false, commentLinks: false, threadStats: true, sort: "score" },
    highlights: { style: "compact", minScore: "5", maxComments: "", maxDepth: "", topLevelOnly: false, includeDeleted: false, stripMedia: true, timestamps: false, commentLinks: false, threadStats: true, sort: "score" },
  };

  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    $("minScore").value = p.minScore;
    $("maxComments").value = p.maxComments;
    $("maxDepth").value = p.maxDepth;
    $("topLevelOnly").checked = p.topLevelOnly;
    $("includeDeleted").checked = p.includeDeleted;
    $("stripMedia").checked = p.stripMedia;
    $("timestamps").checked = p.timestamps;
    $("commentLinks").checked = p.commentLinks;
    $("threadStats").checked = p.threadStats;
    setRadio("style", p.style);
    setRadio("sort", p.sort);
    scheduleReformat();
  }

  function setRadio(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function switchMode(next) {
    mode = next;
    var single = next === "single";
    $("singlePane").hidden = !single;
    $("bulkPane").hidden = single;
    $("jsonBox").hidden = !single;
    $("tabSingle").classList.toggle("active", single);
    $("tabBulk").classList.toggle("active", !single);
    $("exportBtn").textContent = single ? "Export thread" : "Pull subreddit";
    $("zipBtn").hidden = single;
  }

  /* ------------------------------------------------------------------ */
  /* Wire up                                                             */
  /* ------------------------------------------------------------------ */

  function onReady() {
    backend = makeBackend(showProgress);

    $("exportBtn").addEventListener("click", function () {
      runExport(false);
    });
    $("cancelBtn").addEventListener("click", function () {
      backend.cancel();
      setStatus("Cancelling…");
    });
    $("copyBtn").addEventListener("click", copyOutput);
    $("jsonBtnDl").addEventListener("click", function (e) {
      if (mode === "single") {
        e.preventDefault();
        downloadJson();
      }
    });
    $("zipBtn").addEventListener("click", function (e) {
      e.preventDefault();
      downloadZip();
    });
    $("jsonBtn").addEventListener("click", exportFromJson);
    $("tabSingle").addEventListener("click", function () {
      switchMode("single");
    });
    $("tabBulk").addEventListener("click", function () {
      switchMode("bulk");
    });
    $("url").addEventListener("keydown", function (e) {
      if (e.key === "Enter") runExport(false);
    });
    $("subreddit").addEventListener("keydown", function (e) {
      if (e.key === "Enter") runExport(false);
    });

    document.querySelectorAll(".chip").forEach(function (b) {
      b.addEventListener("click", function () {
        applyPreset(b.getAttribute("data-preset"));
      });
    });

    document.querySelectorAll("#optsPanel input").forEach(function (el) {
      if (el.id === "loadAll") return; // needs a fresh fetch, not a reformat
      var evt = el.type === "number" ? "input" : "change";
      el.addEventListener(evt, scheduleReformat);
    });

    var preset = new URLSearchParams(location.search);
    if (preset.get("sub")) {
      switchMode("bulk");
      $("subreddit").value = preset.get("sub");
      if (preset.get("n")) $("bulkCount").value = preset.get("n");
    } else if (preset.get("url")) {
      $("url").value = preset.get("url");
      runExport(false);
    }

    if (backend.kind === "local") {
      setStatus("Running in-page (workers unavailable here). Large threads may briefly pause the UI.", "");
    }
  }

  document.addEventListener("DOMContentLoaded", onReady);
})();
