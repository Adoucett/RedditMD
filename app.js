const ARCTIC = "https://arctic-shift.photon-reddit.com/api";
const PULLPUSH = "https://api.pullpush.io/reddit";

const $ = (id) => document.getElementById(id);

const onReady = () => {
  $("exportBtn").addEventListener("click", () => exportFromUrl());
  $("jsonBtn").addEventListener("click", () => exportFromJson());
  $("copyBtn").addEventListener("click", copyMarkdown);
  $("url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") exportFromUrl();
  });
  const preset = new URLSearchParams(location.search).get("url");
  if (preset) {
    $("url").value = preset;
    exportFromUrl();
  }
};

document.addEventListener("DOMContentLoaded", onReady);

function setStatus(message, kind = "") {
  const el = $("status");
  el.hidden = !message;
  el.className = `status ${kind}`;
  el.textContent = message || "";
}

async function exportFromUrl() {
  const raw = $("url").value.trim();
  if (!raw) {
    setStatus("Paste a Reddit post URL first.", "bad");
    return;
  }
  setBusy(true);
  setStatus("Looking up the thread…");
  try {
    const parsed = await resolvePost(raw);
    const thread = await loadThread(parsed);
    finish(thread, parsed);
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), "bad");
  } finally {
    setBusy(false);
  }
}

function exportFromJson() {
  const text = $("jsonInput").value.trim();
  if (!text) {
    setStatus("Paste Reddit JSON first.", "bad");
    return;
  }
  try {
    const data = JSON.parse(text);
    const thread = threadFromRedditListing(data);
    const parsed = parseRedditUrl($("url").value.trim()) || inferParsed(thread);
    finish(thread, parsed);
  } catch (err) {
    setStatus(`JSON parse failed: ${err.message}`, "bad");
  }
}

function finish(thread, parsed) {
  sortTree(thread.comments, selectedSort());
  const md = renderMarkdown(thread, selectedStyle());
  $("output").textContent = md;
  $("outputBlock").hidden = false;
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const name = filenameFor(thread, parsed);
  const dl = $("downloadBtn");
  dl.href = URL.createObjectURL(blob);
  dl.download = name;
  dl.removeAttribute("aria-disabled");
  $("copyBtn").disabled = false;
  const stats = tally(thread);
  $("stats").hidden = false;
  $("stats").textContent = `${stats.comments} comments · ${stats.authors} authors · depth ${stats.depth} · source ${thread.source}`;
  setStatus(`Exported ${stats.comments} comments.`, "ok");
}

function setBusy(busy) {
  $("exportBtn").disabled = busy;
  $("jsonBtn").disabled = busy;
}

function selectedStyle() {
  return document.querySelector('input[name="style"]:checked')?.value || "compact";
}

function selectedSort() {
  return document.querySelector('input[name="sort"]:checked')?.value || "score";
}

async function copyMarkdown() {
  await navigator.clipboard.writeText($("output").textContent);
  setStatus("Copied to clipboard.", "ok");
}

function filenameFor(thread, parsed) {
  const sub = slug(thread.post.subreddit || parsed.subreddit || "reddit");
  const id = thread.post.id || parsed.postId || "thread";
  const title = slug(thread.post.title || "post").slice(0, 48);
  return `r-${sub}-${id}-${title}.md`;
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "post";
}

/* ---------- URL / ID ---------- */

function parseRedditUrl(input) {
  if (!input) return null;
  let value = input.trim();
  if (/^[a-z0-9]{5,8}$/i.test(value)) {
    return { postId: value.toLowerCase(), commentId: null, subreddit: null, shortPath: null };
  }
  try {
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "redd.it") {
      const id = url.pathname.replace(/\//g, "");
      return id ? { postId: id, commentId: null, subreddit: null, shortPath: null } : null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "r" && parts[2] === "s" && parts[3]) {
      return { postId: null, commentId: null, subreddit: parts[1], shortPath: `/r/${parts[1]}/s/${parts[3]}` };
    }
    const commentsAt = parts.indexOf("comments");
    if (commentsAt >= 0 && parts[commentsAt + 1]) {
      return {
        postId: parts[commentsAt + 1],
        commentId: parts[commentsAt + 3] || null,
        subreddit: parts[0] === "r" ? parts[1] : null,
        shortPath: null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function resolvePost(input) {
  const parsed = parseRedditUrl(input);
  if (!parsed) throw new Error("That does not look like a Reddit post URL.");
  if (parsed.postId) return parsed;
  if (parsed.shortPath) {
    setStatus("Resolving short link…");
    const res = await getJson(`${ARCTIC}/short_links?paths=${encodeURIComponent(parsed.shortPath)}`);
    const dest = res?.data?.[parsed.shortPath] || res?.data?.[0] || res?.[parsed.shortPath];
    const next = parseRedditUrl(typeof dest === "string" ? dest : dest?.url || dest?.permalink);
    if (!next?.postId) throw new Error("Could not resolve that Reddit short link.");
    return next;
  }
  throw new Error("Could not find a post ID in that URL.");
}

function inferParsed(thread) {
  return {
    postId: thread.post.id,
    subreddit: thread.post.subreddit,
    commentId: null,
    shortPath: null,
  };
}

/* ---------- Fetch ---------- */

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} from ${url} ${text.slice(0, 160)}`);
  }
  return res.json();
}

async function loadThread(parsed) {
  try {
    setStatus("Fetching post + comment tree…");
    return await loadFromArctic(parsed);
  } catch (arcticErr) {
    console.warn("Arctic Shift failed", arcticErr);
    setStatus("Archive missed. Trying PullPush…");
    try {
      return await loadFromPullpush(parsed);
    } catch (ppErr) {
      console.warn("PullPush failed", ppErr);
      throw new Error(
        `Could not load that thread automatically (${arcticErr.message}). For brand-new posts, open the Reddit URL, add .json, and paste the JSON below.`
      );
    }
  }
}

async function loadFromArctic(parsed) {
  const postRes = await getJson(`${ARCTIC}/posts/ids?ids=${encodeURIComponent(parsed.postId)}`);
  const post = postRes?.data?.[0];
  if (!post) throw new Error("Arctic Shift does not have that post yet.");

  let treeRes;
  try {
    treeRes = await getJson(
      `${ARCTIC}/comments/tree?link_id=${encodeURIComponent(parsed.postId)}&limit=25000&start_breadth=80&start_depth=30`
    );
  } catch (err) {
    console.warn("full tree failed, retrying smaller", err);
    treeRes = await getJson(
      `${ARCTIC}/comments/tree?link_id=${encodeURIComponent(parsed.postId)}&limit=2000&start_breadth=20&start_depth=12`
    );
  }
  let comments = normalizeListing(treeRes?.data || []);
  if ($("loadAll").checked) {
    comments = await expandMore(parsed.postId, comments);
    comments = await fillMissing(parsed.postId, comments, post.num_comments);
  }
  return { post, comments, source: "arctic-shift" };
}

async function expandMore(postId, comments) {
  const ids = [];
  walkComments(comments, (node) => {
    if (node.kind === "more") {
      for (const id of node.data?.children || []) ids.push(id);
    }
  });
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return stripMore(comments);

  setStatus(`Pulling ${unique.length} extra comments…`);
  const extras = [];
  for (const chunk of chunked(unique, 100)) {
    const res = await getJson(`${ARCTIC}/comments/ids?ids=${chunk.join(",")}`);
    extras.push(...(res?.data || []));
  }
  return mergeFlatIntoTree(comments, extras, `t3_${postId}`);
}

async function fillMissing(postId, comments, expected) {
  const have = countComments(comments);
  if (!expected || have >= expected * 0.9 || have >= 20000) return comments;
  setStatus(`Have ${have}/${expected}. Scanning remaining comments…`);
  const extras = [];
  let after = 0;
  for (let i = 0; i < 30; i++) {
    const url = `${ARCTIC}/comments/search?link_id=${encodeURIComponent(postId)}&limit=100&sort=asc${after ? `&after=${after}` : ""}`;
    const res = await getJson(url);
    const batch = res?.data || [];
    if (!batch.length) break;
    extras.push(...batch);
    const last = batch[batch.length - 1]?.created_utc;
    if (!last || batch.length < 100) break;
    after = Number(last) + 1;
  }
  return mergeFlatIntoTree(comments, extras, `t3_${postId}`);
}

async function loadFromPullpush(parsed) {
  const postRes = await getJson(`${PULLPUSH}/search/submission/?ids=${encodeURIComponent(parsed.postId)}`);
  const post = postRes?.data?.[0];
  if (!post) throw new Error("PullPush does not have that post.");
  const extras = [];
  let after = "";
  for (let i = 0; i < 40; i++) {
    const url = `${PULLPUSH}/search/comment/?link_id=${encodeURIComponent(parsed.postId)}&size=100&sort=asc&sort_type=created_utc${after ? `&after=${after}` : ""}`;
    const res = await getJson(url);
    const batch = res?.data || [];
    if (!batch.length) break;
    extras.push(...batch);
    const last = batch[batch.length - 1]?.created_utc;
    if (!last || String(last) === after || batch.length < 100) break;
    after = String(last);
  }
  const comments = mergeFlatIntoTree([], extras, `t3_${parsed.postId}`);
  return { post, comments, source: "pullpush" };
}

function threadFromRedditListing(data) {
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error("Need the usual Reddit listing JSON: [post, comments].");
  }
  const post = data[0]?.data?.children?.[0]?.data;
  const comments = normalizeListing(data[1]?.data?.children || []);
  if (!post) throw new Error("No post object in that JSON.");
  return { post, comments, source: "pasted-json" };
}

/* ---------- Tree helpers ---------- */

function normalizeListing(nodes) {
  return (nodes || []).map((node) => {
    if (node?.kind && node.data) {
      const copy = { kind: node.kind, data: { ...node.data } };
      copy.data.replies = kidsToListing(copy.data.replies);
      return copy;
    }
    const data = { ...node };
    data.replies = kidsToListing(data.replies);
    return { kind: node.kind || (node.body != null ? "t1" : "more"), data };
  });
}

function kidsToListing(replies) {
  if (!replies) return "";
  if (typeof replies === "string") return replies;
  if (Array.isArray(replies)) {
    return { kind: "Listing", data: { children: normalizeListing(replies) } };
  }
  if (replies.kind === "Listing") {
    return { kind: "Listing", data: { children: normalizeListing(replies.data?.children || []) } };
  }
  return replies;
}

function childrenOf(node) {
  const replies = node?.data?.replies;
  if (!replies || typeof replies === "string") return [];
  return replies.data?.children || [];
}

function setChildren(node, kids) {
  node.data.replies = kids.length
    ? { kind: "Listing", data: { children: kids } }
    : "";
}

function stripMore(nodes) {
  return (nodes || [])
    .filter((n) => n.kind !== "more")
    .map((n) => {
      setChildren(n, stripMore(childrenOf(n)));
      return n;
    });
}

function walkComments(nodes, visit) {
  for (const node of nodes || []) {
    visit(node);
    walkComments(childrenOf(node), visit);
  }
}

function countComments(nodes) {
  let n = 0;
  walkComments(nodes, (node) => {
    if (node.kind !== "more" && node.data?.body != null) n += 1;
  });
  return n;
}

function existingIds(nodes) {
  const ids = new Set();
  walkComments(nodes, (node) => {
    if (node.data?.id) ids.add(node.data.id);
  });
  return ids;
}

function mergeFlatIntoTree(tree, flats, rootName) {
  const nodes = new Map();
  const collect = (list) => {
    for (const node of list || []) {
      if (node.kind === "more") continue;
      const id = node.data?.id;
      if (id) nodes.set(id, node);
      collect(childrenOf(node));
    }
  };
  collect(tree);

  for (const raw of flats || []) {
    const data = raw.data || raw;
    if (!data.id || nodes.has(data.id)) continue;
    nodes.set(data.id, { kind: "t1", data: { ...data, replies: "" } });
  }

  const roots = [];
  const pending = new Map();
  const addUnder = (parentId, node) => {
    if (!pending.has(parentId)) pending.set(parentId, []);
    pending.get(parentId).push(node);
  };

  for (const node of nodes.values()) {
    const parent = node.data.parent_id || rootName;
    if (!parent || parent === rootName) roots.push(node);
    else addUnder(parent.replace(/^t1_/, ""), node);
  }

  for (const node of nodes.values()) {
    const extras = pending.get(node.data.id) || [];
    const kids = [...childrenOf(node), ...extras.filter((e) => !childrenOf(node).some((k) => k.data?.id === e.data?.id))];
    setChildren(node, kids);
  }

  const used = new Set();
  walkComments(roots, (n) => used.add(n.data?.id));
  for (const node of nodes.values()) {
    if (!used.has(node.data?.id)) roots.push(node);
  }
  return stripMore(roots);
}

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sortTree(nodes, sort) {
  const score = (n) => Number(n.data?.score ?? n.data?.ups ?? 0);
  const created = (n) => Number(n.data?.created_utc || 0);
  nodes.sort((a, b) => {
    if (sort === "new") return created(b) - created(a);
    if (sort === "old") return created(a) - created(b);
    return score(b) - score(a);
  });
  for (const node of nodes) sortTree(childrenOf(node), sort);
}

/* ---------- Markdown ---------- */

function renderMarkdown(thread, style) {
  const post = thread.post;
  const lines = [];
  const when = fmtTime(post.created_utc);
  const permalink = post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : `https://www.reddit.com/comments/${post.id}`;
  lines.push(`# ${post.title || "(untitled)"}`);
  lines.push("");
  lines.push(
    [
      post.subreddit ? `r/${post.subreddit}` : null,
      post.author ? `u/${post.author}` : null,
      when,
      Number.isFinite(Number(post.score)) ? `score ${post.score}` : null,
      post.upvote_ratio != null ? `${Math.round(post.upvote_ratio * 100)}% upvoted` : null,
      post.num_comments != null ? `${post.num_comments} comments listed` : null,
      post.link_flair_text ? `flair: ${post.link_flair_text}` : null,
    ]
      .filter(Boolean)
      .join(" · ")
  );
  lines.push(permalink);
  if (post.url && !post.is_self && post.url !== permalink) lines.push(post.url);
  lines.push("");
  if (post.selftext) {
    lines.push(post.selftext.trim());
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  const includeDeleted = $("includeDeleted").checked;
  const spaceTop = $("spaceTop").checked;
  writeComments(lines, thread.comments, 0, style, includeDeleted, spaceTop);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function writeComments(lines, nodes, depth, style, includeDeleted, spaceTop) {
  for (const node of nodes || []) {
    if (node.kind === "more") continue;
    const c = node.data || {};
    const deleted = !c.body || c.body === "[deleted]" || c.body === "[removed]";
    if (deleted && !includeDeleted) {
      writeComments(lines, childrenOf(node), depth, style, includeDeleted, spaceTop);
      continue;
    }
    const author = c.author ? `u/${c.author}` : "u/[deleted]";
    const meta = [
      author,
      c.score != null ? `[${c.score}]` : null,
      c.distinguished ? c.distinguished : null,
      c.stickied ? "stickied" : null,
    ]
      .filter(Boolean)
      .join(" ");
    const body = formatBody(c.body || "[deleted]");
    if (style === "tree") {
      const pad = depth === 0 ? "##### " : `├${"─".repeat(depth)} `;
      lines.push(`${pad}${oneLine(body)} — ${meta}`);
    } else if (style === "list") {
      const pad = `${"  ".repeat(depth)}- `;
      const indented = body.split("\n").map((ln, i) => (i === 0 ? `${pad}${ln}` : `${"  ".repeat(depth)}  ${ln}`));
      lines.push(indented.join("\n"));
      lines.push(`${"  ".repeat(depth)}  — ${meta}`);
    } else {
      const pad = "  ".repeat(depth);
      lines.push(`${pad}${meta}`);
      for (const ln of body.split("\n")) lines.push(pad + ln);
    }
    writeComments(lines, childrenOf(node), depth + 1, style, includeDeleted, spaceTop);
    if (depth === 0 && spaceTop) lines.push("");
  }
}

function formatBody(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function oneLine(text) {
  return formatBody(text).replace(/\n+/g, " / ");
}

function fmtTime(utc) {
  if (!utc) return null;
  const d = new Date(Number(utc) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function tally(thread) {
  let comments = 0;
  let depth = 0;
  const authors = new Set();
  const walk = (nodes, d) => {
    depth = Math.max(depth, d);
    for (const node of nodes || []) {
      if (node.kind === "more") continue;
      comments += 1;
      if (node.data?.author) authors.add(node.data.author);
      walk(childrenOf(node), d + 1);
    }
  };
  walk(thread.comments, 1);
  return { comments, authors: authors.size, depth, source: thread.source };
}
