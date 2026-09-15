"use strict";

const test = require("node:test");
const assert = require("node:assert");
const RedditMD = require("../engine.js");

const { newIndex, addRaws, addMore, collectRawFromTree, nest, stripMedia } = RedditMD._internal;

function buildFrom(raws, moreIds, postId) {
  const index = newIndex(postId || "post1");
  addRaws(index, raws);
  if (moreIds) addMore(index, moreIds);
  RedditMD.finalize(index, "old");
  return index;
}

function c(id, parent, extra) {
  return Object.assign(
    { id: id, parent_id: parent, author: "u" + id, body: "body " + id, score: 1, created_utc: 1000 },
    extra || {}
  );
}

/* ---------------- URL parsing ---------------- */

test("parseRedditUrl handles common shapes", () => {
  const p = RedditMD.parseRedditUrl("https://www.reddit.com/r/meirl/comments/1wggafy/meirl/");
  assert.equal(p.postId, "1wggafy");
  assert.equal(p.subreddit, "meirl");
  assert.equal(RedditMD.parseRedditUrl("https://redd.it/1wggafy").postId, "1wggafy");
  assert.equal(RedditMD.parseRedditUrl("1wggafy").postId, "1wggafy");
  const withComment = RedditMD.parseRedditUrl("reddit.com/r/foo/comments/abc123/title/def456");
  assert.equal(withComment.postId, "abc123");
  assert.equal(withComment.commentId, "def456");
  assert.equal(RedditMD.parseRedditUrl("not a url at all !!"), null);
});

test("parseRedditUrl cleans app share / UTM clutter", () => {
  const messy =
    "https://www.reddit.com/r/apple/comments/1wgwt1r/iphone_18_pro_preorders_off_to_a_muted_start/?share_id=aDoQDHoRvrvVXOZyL9GIR&utm_content=1&utm_medium=ios_app&utm_name=ioscss&utm_source=share&utm_term=1";
  const p = RedditMD.parseRedditUrl(messy);
  assert.equal(p.postId, "1wgwt1r");
  assert.equal(p.subreddit, "apple");
  assert.equal(p.kind, "comments");
});

test("parseRedditUrl recognizes iOS share short links", () => {
  const p = RedditMD.parseRedditUrl("https://www.reddit.com/r/apple/s/I5KvCCY7bE");
  assert.equal(p.shortPath, "/r/apple/s/I5KvCCY7bE");
  assert.equal(p.kind, "share");
  assert.equal(p.postId, null);
});

test("extractRedditUrl pulls a URL out of pasted share-sheet text", () => {
  const blob = "Check this out\nhttps://www.reddit.com/r/apple/s/I5KvCCY7bE\nSent from my iPhone";
  assert.match(RedditMD.extractRedditUrl(blob), /\/r\/apple\/s\/I5KvCCY7bE/);
});

test("canonicalizeInput strips tracking params", () => {
  const messy =
    "https://www.reddit.com/r/apple/comments/1wgwt1r/title/?utm_source=share&share_id=abc";
  assert.equal(
    RedditMD.canonicalizeInput(messy),
    "https://www.reddit.com/r/apple/comments/1wgwt1r/"
  );
});

test("scrapePostId finds comments id in HTML-ish text", () => {
  const html = '<link rel="canonical" href="https://www.reddit.com/r/apple/comments/1wgwt1r/iphone/">';
  assert.equal(RedditMD.scrapePostId(html), "1wgwt1r");
});

test("parseSubredditInput normalizes", () => {
  assert.equal(RedditMD.parseSubredditInput("r/AskReddit"), "AskReddit");
  assert.equal(RedditMD.parseSubredditInput("AskReddit"), "AskReddit");
  assert.equal(RedditMD.parseSubredditInput("https://www.reddit.com/r/aww/"), "aww");
  assert.equal(RedditMD.parseSubredditInput("!!"), null);
});

/* ---------------- Tree flatten + index ---------------- */

test("collectRawFromTree flattens nested replies and collects more ids", () => {
  const tree = [
    {
      kind: "t1",
      data: {
        id: "a",
        parent_id: "t3_post1",
        body: "root",
        author: "ua",
        replies: { kind: "Listing", data: { children: [{ kind: "t1", data: { id: "b", parent_id: "t1_a", body: "child", author: "ub" } }, { kind: "more", data: { children: ["x", "y"] } }] } },
      },
    },
  ];
  const { raws, moreIds } = collectRawFromTree(tree);
  assert.equal(raws.length, 2);
  assert.deepEqual(moreIds.sort(), ["x", "y"]);
});

test("finalize builds parent/child structure from parent_id", () => {
  const index = buildFrom([c("a", "t3_post1"), c("b", "t1_a"), c("c", "t1_a"), c("d", "t1_b")]);
  assert.deepEqual(index.rootIds, ["a"]);
  assert.deepEqual(index.childIds.get("a").sort(), ["b", "c"]);
  assert.deepEqual(index.childIds.get("b"), ["d"]);
  assert.equal(index.unresolved.length, 0);
});

test("orphans go to unresolved, not promoted to root", () => {
  const index = buildFrom([c("a", "t3_post1"), c("orphan", "t1_missing")]);
  assert.deepEqual(index.rootIds, ["a"]);
  assert.deepEqual(index.unresolved, ["orphan"]);
});

test("addRaws deduplicates and prefers longer body", () => {
  const index = newIndex("post1");
  addRaws(index, [c("a", "t3_post1", { body: "" })]);
  addRaws(index, [c("a", "t3_post1", { body: "the real body" })]);
  addRaws(index, [c("a", "t3_post1", { body: "the real body" })]);
  assert.equal(index.byId.size, 1);
  assert.equal(index.byId.get("a").body, "the real body");
});

test("addRaws resolves a pending more id", () => {
  const index = newIndex("post1");
  addMore(index, ["a", "b"]);
  assert.equal(index.moreIds.size, 2);
  addRaws(index, [c("a", "t3_post1")]);
  assert.equal(index.moreIds.has("a"), false);
  assert.equal(index.moreIds.size, 1);
});

/* ---------------- Filtering ---------------- */

test("computeView promotes children of a filtered-out parent", () => {
  const index = buildFrom([
    c("a", "t3_post1", { score: 0 }),
    c("b", "t1_a", { score: 10 }),
  ]);
  const view = RedditMD.computeView(index, { minScore: 1, sort: "old" });
  const ids = view.ordered.map((o) => o.id);
  assert.deepEqual(ids, ["b"]);
  assert.equal(view.ordered[0].depth, 0, "promoted child rises to depth 0");
});

test("topLevelOnly drops descendants and filtered parents' subtrees", () => {
  const index = buildFrom([c("a", "t3_post1"), c("b", "t1_a"), c("c", "t3_post1")]);
  const view = RedditMD.computeView(index, { topLevelOnly: true, sort: "old" });
  assert.deepEqual(view.ordered.map((o) => o.id), ["a", "c"]);
});

test("maxDepth caps recursion but still emits at the cap", () => {
  const index = buildFrom([c("a", "t3_post1"), c("b", "t1_a"), c("d", "t1_b")]);
  const view = RedditMD.computeView(index, { maxDepth: 1, sort: "old" });
  assert.deepEqual(view.ordered.map((o) => o.id), ["a", "b"]);
});

test("maxComments caps total emitted", () => {
  const index = buildFrom([c("a", "t3_post1"), c("b", "t3_post1"), c("d", "t3_post1")]);
  const view = RedditMD.computeView(index, { maxComments: 2, sort: "old" });
  assert.equal(view.ordered.length, 2);
  assert.equal(view.capped, true);
});

test("minScore filter respects includeDeleted", () => {
  const index = buildFrom([c("a", "t3_post1", { body: "[deleted]", score: 50 })]);
  const hidden = RedditMD.computeView(index, { sort: "old" });
  assert.equal(hidden.ordered.length, 0);
  const shown = RedditMD.computeView(index, { includeDeleted: true, sort: "old" });
  assert.equal(shown.ordered.length, 1);
});

/* ---------------- Sorting ---------------- */

test("finalize sorts children by score desc by default", () => {
  const index = newIndex("post1");
  addRaws(index, [c("a", "t3_post1"), c("hi", "t1_a", { score: 99 }), c("lo", "t1_a", { score: 1 })]);
  RedditMD.finalize(index, "score");
  assert.deepEqual(index.childIds.get("a"), ["hi", "lo"]);
});

/* ---------------- Rendering ---------------- */

test("renderMarkdown emits nested compact output with metadata", () => {
  const index = buildFrom([c("a", "t3_post1", { author: "alice", score: 12 }), c("b", "t1_a", { author: "bob", score: 3 })]);
  const post = { id: "post1", title: "Hello", subreddit: "test", author: "alice", created_utc: 1000, permalink: "/r/test/comments/post1/hello/" };
  const md = RedditMD.renderMarkdown(index, post, { style: "compact", markOp: true, sort: "old", threadStats: true });
  assert.match(md, /# Hello/);
  assert.match(md, /u\/alice OP \[12\]/);
  assert.match(md, /  u\/bob \[3\]/);
  assert.match(md, /Thread summary:/);
});

test("stripMedia removes gif/image markdown and links", () => {
  const s = stripMedia("look ![gif](giphy|abc|downsized) and https://i.redd.it/foo.gif done");
  assert.equal(/giphy|i\.redd\.it/.test(s), false);
  assert.match(s, /look\s+and\s+done/);
});

test("unresolved comments render in their own section", () => {
  const index = buildFrom([c("a", "t3_post1"), c("orphan", "t1_missing", { body: "lost reply" })]);
  const post = { id: "post1", title: "T", permalink: "/r/x/comments/post1/t/" };
  const md = RedditMD.renderMarkdown(index, post, { style: "compact", sort: "old" });
  assert.match(md, /## Unplaced comments/);
  assert.match(md, /lost reply/);
});

/* ---------------- JSON ---------------- */

test("buildJson nests by depth and reports stats", () => {
  const index = buildFrom([c("a", "t3_post1"), c("b", "t1_a"), c("d", "t1_b")]);
  const post = { id: "post1", title: "T", permalink: "/r/x/comments/post1/t/", num_comments: 3 };
  const json = RedditMD.buildJson(index, post, { sort: "old" });
  assert.equal(json.comments.length, 1);
  assert.equal(json.comments[0].replies.length, 1);
  assert.equal(json.comments[0].replies[0].replies[0].id, "d");
  assert.equal(json.stats.fetched, 3);
});

test("nest reconstructs sibling promotion correctly", () => {
  // a filtered out -> b and c (its children) become siblings at depth 0
  const ordered = [
    { id: "b", depth: 0 },
    { id: "c", depth: 0 },
  ];
  const index = buildFrom([c("b", "t1_a"), c("c", "t1_a")]);
  const nested = nest(ordered, index);
  assert.equal(nested.length, 2);
});

/* ---------------- Round-trip from Reddit listing ---------------- */

test("indexFromRedditListing parses [post, comments] shape", () => {
  const listing = [
    { data: { children: [{ data: { id: "post1", title: "Pasted", subreddit: "x", author: "op", created_utc: 1 } }] } },
    {
      data: {
        children: [
          { kind: "t1", data: { id: "a", parent_id: "t3_post1", body: "hi", author: "op", score: 5 } },
          { kind: "t1", data: { id: "b", parent_id: "t1_a", body: "yo", author: "u2", score: 2 } },
        ],
      },
    },
  ];
  const built = RedditMD.indexFromRedditListing(listing);
  RedditMD.finalize(built.index, "old");
  assert.equal(built.post.title, "Pasted");
  assert.equal(built.index.byId.size, 2);
  assert.deepEqual(built.index.rootIds, ["a"]);
});

/* ---------------- ZIP ---------------- */

test("makeZipBlob produces a valid local-file signature", async () => {
  const blob = RedditMD.makeZipBlob([{ name: "a.md", data: "hello" }]);
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "PK local file header");
  assert.equal(buf.indexOf(Buffer.from("a.md")) > 0, true);
  assert.equal(buf.indexOf(Buffer.from("hello")) > 0, true);
});

test("crc32 matches known value", () => {
  const bytes = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
  assert.equal(RedditMD._internal.crc32(bytes) >>> 0, 0x414fa339);
});
