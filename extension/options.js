const $ = (id) => document.getElementById(id);

(async () => {
  const { token, hoverButton = true } = await chrome.storage.local.get(["token", "hoverButton"]);
  if (token) $("token").value = token;
  $("hover").checked = hoverButton;
})();

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  if (!token) { $("status").textContent = "Paste the token first."; return; }
  await chrome.storage.local.set({ token });
  $("status").textContent = "Testing…";
  const r = await chrome.runtime.sendMessage({ type: "ping" });
  $("status").textContent = r?.ok ? "Connected. You're ready to save." : `Not connected: ${r?.error ?? "unknown error"}`;
});

$("hover").addEventListener("change", () => chrome.storage.local.set({ hoverButton: $("hover").checked }));
