// 通信を担う唯一の場所。/filter を起動時と定期(alarm)に DL して storage に焼く。
// 閲覧時の照合はここが保持する Bloom filter だけで行い、ネットワーク通信はしない。
// content からは「現ホスト」だけを受け取り、ヒット可否を返す（生 URL は受けない）。

import { normalizeHost, sha256Hex } from "./normalize.js";
import { BloomFilter } from "./bloom.js";

const API_BASE = "https://aiblocker-api.kusanaginoturugi.workers.dev";
const FILTER_URL = `${API_BASE}/filter`;
const REFRESH_ALARM = "aiblocker-refresh";
const REFRESH_PERIOD_MIN = 360; // 6 時間ごと

// /filter を DL して storage に焼く。503(未ビルド)やオフラインは黙ってスキップ。
async function refreshFilter() {
  try {
    const res = await fetch(FILTER_URL, { cache: "no-cache" });
    if (!res.ok) return;
    const version = res.headers.get("x-filter-version") || "";
    const buf = new Uint8Array(await res.arrayBuffer());
    await chrome.storage.local.set({
      bloom: Array.from(buf), // storage は JSON 化するので配列で持つ
      version,
      fetchedAt: Date.now(),
    });
    cached = null; // 次の getFilter で作り直す
  } catch {
    // オフライン等は無視。次回 alarm で再試行。
  }
}

let cached = null; // { version, filter }

async function getFilter() {
  const { bloom, version } = await chrome.storage.local.get(["bloom", "version"]);
  if (!bloom) return null;
  if (cached && cached.version === version) return cached.filter;
  const filter = BloomFilter.fromBytes(Uint8Array.from(bloom));
  cached = { version, filter };
  return filter;
}

// content から複数ホストをまとめて受け、各ホストのヒット可否を返す。
// 入力(raw)をそのままキーにして返す（content 側はそのキーで引く）。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "checkMany") return;
  (async () => {
    const filter = await getFilter();
    const results = {};
    if (filter && Array.isArray(msg.hosts)) {
      for (const raw of msg.hosts) {
        const host = normalizeHost(raw);
        if (!host) { results[raw] = false; continue; }
        const hash = await sha256Hex(host);
        results[raw] = filter.test(hash);
      }
    }
    sendResponse({ results });
  })();
  return true; // 非同期 sendResponse を使うため
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MIN });
  refreshFilter();
});
chrome.runtime.onStartup.addListener(refreshFilter);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === REFRESH_ALARM) refreshFilter();
});
