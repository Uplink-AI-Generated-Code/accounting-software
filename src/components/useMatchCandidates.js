import { useEffect, useState } from "react";
import { getMatchCandidates } from "../api";

const DEBOUNCE_MS = 300;

// Debounced wrapper around getMatchCandidates for the "primary leg" search
// in AccountLedger/StockLedger — pass null to disable (nothing typed yet,
// already linked, etc.), or the search params to run. See otherLines.jsx
// for the per-split-leg equivalent, which searches several legs at once
// into a keyed map instead of a single array.
export function useMatchCandidates(params) {
  const [candidates, setCandidates] = useState([]);

  useEffect(() => {
    if (!params) {
      setCandidates([]);
      return;
    }
    const handle = setTimeout(() => {
      getMatchCandidates(params).then(setCandidates).catch(() => setCandidates([]));
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params)]);

  return candidates;
}
