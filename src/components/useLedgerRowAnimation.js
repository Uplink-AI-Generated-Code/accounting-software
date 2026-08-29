import { useEffect, useLayoutEffect, useRef } from "react";

/* ---------------------------------------------------------
   Shared row-reorder animation, used by both the cash ledger and
   the stock ledger. Handles the FLIP slide for ordinary rows and the
   scroll-synced "ledger slides underneath" treatment for whichever
   row is being edited (or just finished being edited/cancelled).
   Each row must carry its own stable `key` (a record's transaction id,
   or "line-<id>" for a standalone one — see AccountLedger.jsx's
   rowKey()).
--------------------------------------------------------- */
export function useLedgerRowAnimation(rows, editingKey) {
  const rowRefs = useRef({});
  const prevTop = useRef({});
  const scrollAnimRef = useRef(null);
  const pendingSettleId = useRef(null);

  function absTop(el) {
    return el.getBoundingClientRect().top + window.scrollY;
  }

  function settleRowWithScroll(el, startTransform, duration = 320) {
    if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);

    el.style.transition = "none";
    el.style.transform = `translateY(${startTransform}px)`;
    void el.offsetHeight;
    el.style.transition = "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
    el.style.transform = "translateY(0px)";

    const start = performance.now();
    let lastTop = absTop(el);

    function frame(now) {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const curTop = absTop(el);
      const drift = curTop - lastTop;
      if (Math.abs(drift) > 0.01) {
        window.scrollTo(0, Math.max(0, Math.min(maxScroll, window.scrollY + drift)));
      }
      lastTop = absTop(el);

      if (now - start < duration + 60) {
        scrollAnimRef.current = requestAnimationFrame(frame);
      } else {
        scrollAnimRef.current = null;
      }
    }
    scrollAnimRef.current = requestAnimationFrame(frame);
  }

  useLayoutEffect(() => {
    const newTops = {};
    rows.forEach((r) => {
      const el = rowRefs.current[r.key];
      if (el) newTops[r.key] = absTop(el);
    });
    rows.forEach((r) => {
      const el = rowRefs.current[r.key];
      const prev = prevTop.current[r.key];
      const next = newTops[r.key];
      if (!el || prev === undefined || next === undefined || prev === next) return;

      if (r.key === editingKey || r.key === pendingSettleId.current) {
        settleRowWithScroll(el, prev - next);
      } else {
        const delta = prev - next;
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
          el.style.transform = "translateY(0px)";
        });
      }
    });
    prevTop.current = newTops;
    pendingSettleId.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.key + "|" + r.line.date).join(",")]);

  useEffect(() => {
    return () => {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
    };
  }, []);

  return { rowRefs, pendingSettleId };
}
