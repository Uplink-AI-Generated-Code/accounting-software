/* ---------------------------------------------------------
   A minimal hash router — no server, so the URL fragment is the only
   thing that survives a refresh unprompted. #/account/<id> selects an
   account; #/ (or nothing) is the overview. pushState (not replaceState)
   so the browser's back/forward buttons move between accounts too.
--------------------------------------------------------- */
export function accountIdFromHash() {
  if (typeof window === "undefined") return null;
  const m = (window.location.hash || "").match(/^#\/account\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
export function setHashForAccount(id) {
  if (typeof window === "undefined") return;
  try {
    const next = id ? `#/account/${encodeURIComponent(id)}` : "#/";
    if (window.location.hash !== next) window.history.pushState(null, "", next);
  } catch (e) {
    // Some embedding contexts restrict history manipulation — the app
    // still works, it just won't survive a refresh in that case.
  }
}
