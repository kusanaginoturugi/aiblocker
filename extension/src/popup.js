// ツールバーアイコンの popup。現タブの host を表示し、報告ページを開くだけ。
// ネットワーク通信はしない（リスト照合は background、報告は新タブの Worker ページ）。

async function currentHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    return new URL(tab.url).hostname;
  } catch {
    return "";
  }
}

function open(host, vote) {
  chrome.runtime.sendMessage({ type: "openReport", host, vote });
  window.close();
}

(async () => {
  const host = await currentHost();
  document.getElementById("host").textContent = host || "(このページは報告できません)";

  // 現ホストが既にリスト入りかを表示（任意）
  if (host) {
    chrome.runtime.sendMessage({ type: "checkMany", hosts: [host] }, (r) => {
      if (chrome.runtime.lastError) return;
      const listed = r?.results?.[host];
      document.getElementById("state").textContent = listed
        ? "現在: リスト入り（blur 対象）"
        : "現在: 未登録";
    });
  }

  const disabled = !host;
  for (const id of ["ai", "notai"]) {
    const el = document.getElementById(id);
    el.disabled = disabled;
  }
  document.getElementById("ai").addEventListener("click", () => open(host, 1));
  document.getElementById("notai").addEventListener("click", () => open(host, -1));
})();
