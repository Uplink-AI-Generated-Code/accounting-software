import { useCallback, useEffect, useState } from "react";
import { getTagTotals } from "../api";

// Fetches GET /api/tag-totals for one dimension — see TagService's
// docblock for the (value, currency) grouping and the investment-line
// scope cut. Mirrors useAccountLedger.js's shape: fetch on mount/
// dimension-change, expose reload() for after a ledger write elsewhere
// introduces or changes a tag. A null/empty dimension means "nothing
// picked yet" — stays empty rather than fetching.
export function useTagTotals(dimension) {
  const [totals, setTotals] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!dimension) {
      setTotals([]);
      setLoaded(true);
      return;
    }
    try {
      const data = await getTagTotals(dimension);
      setTotals(data || []);
    } catch (e) {
      // Leave whatever was already loaded in place on a transient failure.
    } finally {
      setLoaded(true);
    }
  }, [dimension]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [dimension, reload]);

  return { totals, loaded, reload };
}
