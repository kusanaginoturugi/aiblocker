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
  const token = body?.turnstileToken;

  if (!/^[0-9a-f]{64}$/.test(hash)) return json({ error: "bad hash" }, 400);
  if (kind !== "url" && kind !== "domain") return json({ error: "bad kind" }, 400);
  if (reporter.length < 8 || reporter.length > 64) return json({ error: "bad reporter" }, 400);

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

  // 二重投票は UNIQUE(hash, reporter) で弾く
  await env.DB.prepare(
    "INSERT OR IGNORE INTO reports (hash, kind, reporter, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(hash, kind, reporter, now)
    .run();

  const countRow = await env.DB.prepare(
    "SELECT COUNT(DISTINCT reporter) AS n FROM reports WHERE hash = ?"
  )
    .bind(hash)
    .first<{ n: number }>();
  const count = countRow?.n ?? 0;
  const status = count >= threshold ? "active" : "pending";

  await env.DB.prepare(
    `INSERT INTO entries (hash, kind, prefix, report_count, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET
       report_count = excluded.report_count,
       status = excluded.status,
       updated_at = excluded.updated_at`
  )
    .bind(hash, kind, prefix, count, status, now)
    .run();

  return json({ ok: true, count, status }, 201);
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
