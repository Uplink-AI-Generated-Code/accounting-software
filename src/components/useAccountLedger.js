import { useCallback, useEffect, useState } from "react";
import { getAccountLedger } from "../api";

// Fetches one account's own transactions on mount and whenever the
// account changes, and exposes reload() so a ledger screen can refresh
// itself after its own mutations succeed — this is the "fetch per screen,
// discard on navigating away" piece of the app's data model. `loaded`
// distinguishes "empty because there's nothing yet" from "haven't heard
// back yet", so the ledger doesn't flash "No entries yet" while a fetch
// is still in flight.
export function useAccountLedger(accountId) {
  const [transactions, setTransactions] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await getAccountLedger(accountId);
      setTransactions(data.transactions || []);
    } catch (e) {
      // Leave whatever was already loaded in place on a transient failure
      // rather than blanking the screen.
    } finally {
      setLoaded(true);
    }
  }, [accountId]);

  useEffect(() => {
    setLoaded(false);
    setTransactions([]);
    reload();
  }, [accountId, reload]);

  return { transactions, loaded, reload };
}
