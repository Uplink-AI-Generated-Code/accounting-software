import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAccountLedger } from "../api";

// Fetches one account's own records (standalone lines and linked
// transactions it's part of — see LedgerStateService::accountLedger()) on
// mount and whenever the account changes, and exposes reload() so a
// ledger screen can refresh itself after its own mutations succeed — this
// is the "fetch per screen, discard on navigating away" piece of the
// app's data model. `loaded` distinguishes "empty because there's nothing
// yet" from "haven't heard back yet", so the ledger doesn't flash "No
// entries yet" while a fetch is still in flight.
//
// reorder() is the one optimistic write in either ledger (see CLAUDE.md's
// "None of the write handlers are optimistic"): a same-date reorder only
// ever changes `order` on lines already on screen, with no cascade for
// the backend to decide, so its new order is overlaid on `records`
// immediately — letting the row animate the moment it's moved or dropped
// instead of after a network round trip — and the overlay is dropped once
// every in-flight reorder has saved and been reloaded, at which point the
// fetched records carry the same order anyway.
export function useAccountLedger(accountId) {
  const [fetched, setFetched] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [orderOverrides, setOrderOverrides] = useState({});
  const pendingReorders = useRef(0);

  const reload = useCallback(async () => {
    try {
      const data = await getAccountLedger(accountId);
      setFetched(data.records || []);
    } catch (e) {
      // Leave whatever was already loaded in place on a transient failure
      // rather than blanking the screen.
    } finally {
      setLoaded(true);
    }
  }, [accountId]);

  useEffect(() => {
    setLoaded(false);
    setFetched([]);
    setOrderOverrides({});
    reload();
  }, [accountId, reload]);

  // `patches` is lib/grouping.js's reorderSameDate() output; `save` sends
  // it to the backend and returns a promise.
  const reorder = useCallback((patches, save) => {
    setOrderOverrides((prev) => {
      const next = { ...prev };
      patches.forEach((p) => { next[p.lineId] = p.line.order; });
      return next;
    });
    pendingReorders.current++;
    return Promise.resolve()
      .then(save)
      .then(reload)
      .finally(() => {
        pendingReorders.current--;
        if (pendingReorders.current === 0) setOrderOverrides({});
      });
  }, [reload]);

  const records = useMemo(() => {
    if (Object.keys(orderOverrides).length === 0) return fetched;
    return fetched.map((r) => {
      if (!r.lines.some((l) => l.id in orderOverrides)) return r;
      return { ...r, lines: r.lines.map((l) => (l.id in orderOverrides ? { ...l, order: orderOverrides[l.id] } : l)) };
    });
  }, [fetched, orderOverrides]);

  return { records, loaded, reload, reorder };
}
