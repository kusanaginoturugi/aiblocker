import { BloomFilter } from "./bloom";

export interface Env {
  DB: D1Database;
  DIST: KVNamespace;
  PROMOTE_THRESHOLD: string;
  PREFIX_LEN: string;
  TURNSTILE_SECRET?: string;
}

interface ActiveEntry {
  hash: string;
  kind: "url" | "domain";
}

const FILTER_KEY = "filter:current";
const META_KEY = "meta";
const PREFIX_TTL = 7200; // 旧ビルドのプレフィックスキーは TTL で自己消滅
const FILTER_FPR = 0.001; // Bloom 目標偽陽性率

// ---- ルーティング --------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/report-page") {
        return cors(reportPage());
      }
      if (req.method === "GET" && url.pathname === "/filter") {
        return cors(await getFilter(env));
      }
      if (req.method === "GET" && url.pathname === "/list") {
        return cors(await getList(env, url));
      }
      if (req.method === "POST" && url.pathname === "/report") {
        return cors(await postReport(req, env));
      }
      return cors(json({ error: "not found" }, 404));
    } catch (e) {
      console.error(e);
      return cors(json({ error: "internal" }, 500));
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await rebuild(env);
  },
};

// ---- GET /filter ---------------------------------------------------------

async function getFilter(env: Env): Promise<Response> {
  const meta = await readMeta(env);
  const body = await env.DIST.get(FILTER_KEY, "arrayBuffer");
  if (!body || !meta) return json({ error: "filter not built yet" }, 503);

  const etag = `"${meta.version}"`;
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "x-filter-version": String(meta.version),
      etag,
      "cache-control": "public, max-age=3600",
    },
  });
}

// ---- GET /list?prefix=xxxxx ---------------------------------------------

async function getList(env: Env, url: URL): Promise<Response> {
  const prefix = (url.searchParams.get("prefix") || "").toLowerCase();
  const prefixLen = Number(env.PREFIX_LEN);
  if (!/^[0-9a-f]+$/.test(prefix) || prefix.length !== prefixLen) {
    return json({ error: `prefix must be ${prefixLen} hex chars` }, 400);
  }

  const meta = await readMeta(env);
  if (!meta) return json({ url: [], domain: [] });

  const key = prefixKey(meta.version, prefix);
  const data = await env.DIST.get(key, "json");
  return json(data ?? { url: [], domain: [] });
}

// ---- POST /report --------------------------------------------------------

async function postReport(req: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const hash = String(body?.hash || "").toLowerCase();
  const kind = String(body?.kind || "");
  const reporter = String(body?.reporter || "");
  const vote = body?.vote === undefined ? 1 : Number(body.vote); // +1=AI, -1=notAI(unvote)
  const token = body?.turnstileToken;

  if (!/^[0-9a-f]{64}$/.test(hash)) return json({ error: "bad hash" }, 400);
  if (kind !== "url" && kind !== "domain") return json({ error: "bad kind" }, 400);
  if (reporter.length < 8 || reporter.length > 64) return json({ error: "bad reporter" }, 400);
  if (vote !== 1 && vote !== -1) return json({ error: "bad vote" }, 400);

  if (env.TURNSTILE_SECRET) {
    const ip = req.headers.get("cf-connecting-ip") || undefined;
    if (!(await verifyTurnstile(env.TURNSTILE_SECRET, token, ip))) {
      return json({ error: "turnstile failed" }, 403);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const prefixLen = Number(env.PREFIX_LEN);
  const prefix = hash.slice(0, prefixLen);
  const threshold = Number(env.PROMOTE_THRESHOLD);

  // 同一 (hash, reporter) は最新票で上書き（AI↔notAI の変更を許す）
  await env.DB.prepare(
    `INSERT INTO reports (hash, kind, reporter, vote, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hash, reporter) DO UPDATE SET
       kind = excluded.kind,
       vote = excluded.vote,
       created_at = excluded.created_at`
  )
    .bind(hash, kind, reporter, vote, now)
    .run();

  // net = AI票(+1)の人数 − notAI票(−1)の人数。閾値以上で active、下回れば pending に降格。
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) AS pos,
       COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) AS neg
     FROM reports WHERE hash = ?`
  )
    .bind(hash)
    .first<{ pos: number; neg: number }>();
  const net = (row?.pos ?? 0) - (row?.neg ?? 0);
  const status = net >= threshold ? "active" : "pending";

  // report_count には正味スコア(net)を格納する。
  await env.DB.prepare(
    `INSERT INTO entries (hash, kind, prefix, report_count, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET
       report_count = excluded.report_count,
       status = excluded.status,
       updated_at = excluded.updated_at`
  )
    .bind(hash, kind, prefix, net, status, now)
    .run();

  return json({ ok: true, net, status }, 201);
}

// ---- Cron: 配布物の再ビルド ----------------------------------------------

async function rebuild(env: Env): Promise<void> {
  const prefixLen = Number(env.PREFIX_LEN);
  const rows = await env.DB.prepare(
    "SELECT hash, kind FROM entries WHERE status = 'active'"
  ).all<ActiveEntry>();
  const entries = rows.results ?? [];

  const version = Math.floor(Date.now() / 1000);

  // Bloom filter（url/domain 共通の集合）
  const bloom = BloomFilter.create(entries.length, FILTER_FPR);
  for (const e of entries) bloom.add(e.hash);
  await env.DIST.put(FILTER_KEY, bloom.toBytes() as unknown as ArrayBuffer);

  // プレフィックス別マップ（ハイブリッド二次照合用）
  const byPrefix = new Map<string, string[]>();
  for (const e of entries) {
    const p = e.hash.slice(0, prefixLen);
    let bucket = byPrefix.get(p);
    if (!bucket) {
      bucket = [];
      byPrefix.set(p, bucket);
    }
    bucket.push(e.hash);
  }
  await Promise.all(
    [...byPrefix.entries()].map(([p, hashes]) =>
      env.DIST.put(prefixKey(version, p), JSON.stringify({ hashes }), {
        expirationTtl: PREFIX_TTL,
      })
    )
  );

  await env.DIST.put(
    META_KEY,
    JSON.stringify({ version, count: entries.length, m: bloom.m, k: bloom.k })
  );
}

// ---- ヘルパ ---------------------------------------------------------------

interface Meta {
  version: number;
  count: number;
  m: number;
  k: number;
}

async function readMeta(env: Env): Promise<Meta | null> {
  return await env.DIST.get<Meta>(META_KEY, "json");
}

function prefixKey(version: number, prefix: string): string {
  return `p:${version}:${prefix}`;
}

async function verifyTurnstile(
  secret: string,
  token: unknown,
  ip?: string
): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}

// ---- GET /report-page ----------------------------------------------------
// 拡張から新タブで開く報告フォーム。host/vote/reporter は URL fragment(#)で受け、
// サーバーには届かない。ここで hash 化して同一オリジンの /report に投げる。
// Turnstile は workers.dev ドメイン上なので正常に動く。

function reportPage(): Response {
  return new Response(REPORT_PAGE_HTML, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const REPORT_PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aiblocker 報告</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
  body { font-family: system-ui, sans-serif; max-width: 560px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  input[type=text] { width: 100%; padding: .4rem; box-sizing: border-box; }
  .row { margin: .9rem 0; }
  label.vote { display: block; margin: .3rem 0; }
  button { padding: .55rem 1.2rem; font-size: 1rem; cursor: pointer; }
  pre { background: #f4f4f4; padding: 1rem; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
  small { color: #666; }
</style>
</head>
<body>
<h1>サイトを報告</h1>
<p>このサイトが生成AIコンテンツかどうかを報告する。送信前に Turnstile を通すこと。</p>

<div class="row">
  <label>ホスト<br><input type="text" id="host" placeholder="example.com"></label>
</div>
<div class="row">
  <label class="vote"><input type="radio" name="vote" value="1" checked> 生成AIだと報告 (+1)</label>
  <label class="vote"><input type="radio" name="vote" value="-1"> 生成AIじゃない / 取り消し (−1)</label>
</div>

<div class="cf-turnstile" data-sitekey="0x4AAAAAADncg2eAPsF8mQ0T" data-action="aiblocker-report"></div>

<div class="row"><button id="send">送信</button></div>
<pre id="out">（ここに結果が出る）</pre>
<p><small>ホスト名はこのページの内側だけで SHA-256 化され、サーバーには元の文字列を送りません。</small></p>

<script>
const API = location.origin;

function normalizeHost(input) {
  let host = input.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\\/\\//i.test(host)) host = new URL(host).hostname;
    else if (host.includes("/")) host = new URL("http://" + host).hostname;
  } catch (e) { return null; }
  host = host.toLowerCase().replace(/\\.+$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host || null;
}
async function sha256Hex(s) {
  const d = new TextEncoder().encode(s);
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", d));
  let h = ""; for (const x of b) h += x.toString(16).padStart(2, "0"); return h;
}
function fragParams() {
  return new URLSearchParams(location.hash.replace(/^#/, ""));
}

let reporter = "";
window.addEventListener("DOMContentLoaded", function () {
  const p = fragParams();
  const host = p.get("host");
  if (host) document.getElementById("host").value = host;
  if (p.get("vote") === "-1") {
    document.querySelector('input[name=vote][value="-1"]').checked = true;
  }
  reporter = p.get("reporter") || crypto.randomUUID();
});

document.getElementById("send").addEventListener("click", async function () {
  const out = document.getElementById("out");
  const token = window.turnstile && turnstile.getResponse();
  if (!token) { out.textContent = "先に Turnstile を通してください"; return; }
  const host = normalizeHost(document.getElementById("host").value);
  if (!host) { out.textContent = "ホストが不正です"; return; }
  const vote = Number(document.querySelector('input[name=vote]:checked').value);
  const hash = await sha256Hex(host);
  out.textContent = "送信中...";
  try {
    const res = await fetch(API + "/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: hash, kind: "domain", reporter: reporter, vote: vote, turnstileToken: token }),
    });
    const data = await res.json();
    const verb = vote === 1 ? "AI報告" : "取り消し";
    out.textContent = verb + " 完了: host=" + host + " net=" + data.net + " status=" + data.status + " (HTTP " + res.status + ")";
  } catch (e) {
    out.textContent = "エラー: " + e;
  }
  if (window.turnstile) turnstile.reset();
});
</script>
</body>
</html>`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET, POST, OPTIONS");
  h.set("access-control-allow-headers", "content-type");
  return new Response(res.body, { status: res.status, headers: h });
}
