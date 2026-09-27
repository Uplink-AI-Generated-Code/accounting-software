import { useEffect, useState } from "react";
import { getMatchCandidates } from "../api";
import { scaleForCurrency } from "../lib/format";
import { fractionDigits } from "../lib/decimal";

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
    // PHASE 1 ONLY — storage is still scaled integers, so the backend
    // 400s a search whose `amount` has more decimal places than the
    // target currency's own scale (console noise, no candidates would
    // ever match anyway). Phase 2 removes this limit entirely.
    if (fractionDigits(params.amount) > scaleForCurrency(params.currency)) {
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
