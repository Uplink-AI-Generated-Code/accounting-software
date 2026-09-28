import { useEffect, useLayoutEffect, useRef } from "react";
import { sameDateRange } from "../lib/grouping";
import { C } from "../lib/theme";

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

// The translateY an element is *currently* showing — mid-transition
// included, which is why this reads the computed style rather than
// el.style.transform (that's only the transition's target).
function currentTranslateY(el) {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  return new DOMMatrixReadOnly(t).m42;
}

// The element the ledger actually scrolls inside — App.jsx's <main> is
// its own overflow container, so it's usually that rather than the
// window. Picked by overflow style alone, not by whether it currently
// overflows, so the coordinate space doesn't flip between renders as the
// ledger grows or shrinks. null means the window itself.
function scrollerOf(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

function scrollPos(scroller) {
  return scroller ? scroller.scrollTop : window.scrollY;
}

function scrollByPx(scroller, dy) {
  if (scroller) scroller.scrollTop += dy;
  else window.scrollBy(0, dy);
}

// Top of the element within its scroller's content — unaffected by how
// far that scroller is currently scrolled, so positions recorded before
// the user scrolled still compare correctly with positions measured
// after.
function contentTop(el, scroller) {
  const top = el.getBoundingClientRect().top;
  return scroller ? top - scroller.getBoundingClientRect().top + scroller.scrollTop : top + window.scrollY;
}

// Where the element's layout box sits, ignoring any transform on it — so
// a position recorded mid-animation (or mid-drag) is still the real slot
// the row occupies, not wherever it's visually passing through.
function layoutTop(el, scroller) {
  return contentTop(el, scroller) - currentTranslateY(el);
}

/* ---------------------------------------------------------
   Shared row-reorder animation, used by both the cash ledger and
   the stock ledger. Handles the FLIP slide for ordinary rows and the
   scroll-synced "ledger slides underneath" treatment for whichever
   row is being edited (or just finished being edited/cancelled, or was
   just moved with a same-date up/down button — set pendingSettleId to
   its key before the change that moves it). Each row must carry its own
   stable `key` (a record's transaction id, or "line-<id>" for a
   standalone one — see AccountLedger.jsx's rowKey()) and its own
   `line.date`.

   Also owns drag-to-reorder among same-date rows (startDrag, wired to a
   row's drag handle's onPointerDown): the dragged row follows the
   pointer, clamped to its same-date group, while its neighbours slide
   aside to open a gap where it would land; holding it near the top or
   bottom edge of the visible area auto-scrolls, for a group taller than
   the screen. On release it calls
   onReorder(fromIdx, toIdx) and — because the drag's transforms are
   still in place when the new order renders — the FLIP pass below
   glides the dropped row from wherever it was let go into its slot.
--------------------------------------------------------- */
export function useLedgerRowAnimation(rows, editingKey, { onReorder } = {}) {
  const rowRefs = useRef({});
  const prevTop = useRef({});
  const prevSignature = useRef(null);
  const scrollAnimRef = useRef(null);
  const pendingSettleId = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);

  // Keeps `el` fixed on screen while it slides into its new slot, by
  // scrolling its scroller along with it — so the rest of the ledger
  // appears to slide underneath it instead.
  function settleRowWithScroll(el, scroller, startTransform, duration = 320) {
    if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);

    el.style.transition = "none";
    el.style.transform = `translateY(${startTransform}px)`;
    void el.offsetHeight;
    el.style.transition = `transform ${duration}ms ${EASE}`;
    el.style.transform = "translateY(0px)";

    const start = performance.now();
    let lastTop = contentTop(el, scroller);

    function frame(now) {
      const drift = contentTop(el, scroller) - lastTop;
      if (Math.abs(drift) > 0.01) scrollByPx(scroller, drift);
      lastTop = contentTop(el, scroller);

      if (now - start < duration + 60) {
        scrollAnimRef.current = requestAnimationFrame(frame);
      } else {
        scrollAnimRef.current = null;
      }
    }
    scrollAnimRef.current = requestAnimationFrame(frame);
  }

  // Runs after every render, not just when the order changes, so the
  // recorded positions never go stale — e.g. an edit row expanding or
  // collapsing without reordering anything still shifts every row below
  // it, and the next real reorder has to start from where rows actually
  // are. Only an actual change in order/dates animates anything.
  const signature = rows.map((r) => r.key + "|" + r.line.date).join(",");
  useLayoutEffect(() => {
    const firstEl = rows.map((r) => rowRefs.current[r.key]).find(Boolean);
    const scroller = firstEl ? scrollerOf(firstEl) : null;
    const newTops = {};
    rows.forEach((r) => {
      const el = rowRefs.current[r.key];
      if (el) newTops[r.key] = layoutTop(el, scroller);
    });

    if (prevSignature.current !== null && prevSignature.current !== signature && !dragRef.current) {
      rows.forEach((r) => {
        const el = rowRefs.current[r.key];
        const prev = prevTop.current[r.key];
        const next = newTops[r.key];
        if (!el || prev === undefined || next === undefined) return;
        // Where the row visually was just before this change (its old
        // slot plus whatever transform it was still showing), relative
        // to its new slot.
        const delta = prev + currentTranslateY(el) - next;

        if (r.key === editingKey || r.key === pendingSettleId.current) {
          if (Math.abs(delta) > 0.5) settleRowWithScroll(el, scroller, delta);
        } else if (Math.abs(delta) > 0.5) {
          el.style.transition = "none";
          el.style.transform = `translateY(${delta}px)`;
          requestAnimationFrame(() => {
            el.style.transition = `transform 320ms ${EASE}`;
            el.style.transform = "translateY(0px)";
          });
        } else if (el.style.transform) {
          // Already visually in its new slot (e.g. a neighbour that slid
          // aside during a drag) — drop the transform without a jump.
          el.style.transition = "none";
          el.style.transform = "";
        }
      });
    }

    prevTop.current = newTops;
    prevSignature.current = signature;
    pendingSettleId.current = null;
  });

  function startDrag(e, key) {
    if (e.button !== 0 || dragRef.current) return;
    const fromIdx = rows.findIndex((r) => r.key === key);
    if (fromIdx < 0) return;
    const { start, end } = sameDateRange(rows, fromIdx);
    if (start === end) return;
    e.preventDefault();
    e.stopPropagation();

    const scroller = scrollerOf(rowRefs.current[key]);
    const group = [];
    for (let i = start; i <= end; i++) {
      const el = rowRefs.current[rows[i].key];
      if (!el) return;
      // Settle anything still mid-animation so every measurement below
      // is its real slot.
      el.style.transition = "none";
      el.style.transform = "";
      group.push({ el, top: contentTop(el, scroller), height: el.getBoundingClientRect().height });
    }
    const local = fromIdx - start;
    const dragged = group[local];
    const groupTop = group[0].top;
    const groupBottom = group[group.length - 1].top + group[group.length - 1].height;

    // Rows' own backgrounds are translucent tints (or transparent), so
    // back the lifted row with the card colour while it passes over its
    // neighbours.
    const savedBackground = dragged.el.style.background;
    const tint = getComputedStyle(dragged.el).backgroundColor;
    dragged.el.style.background = `linear-gradient(${tint}, ${tint}), ${C.card}`;
    dragged.el.style.position = "relative";
    dragged.el.style.zIndex = "2";
    dragged.el.style.boxShadow = "0 6px 18px rgba(0,0,0,0.14)";
    group.forEach((g, i) => {
      if (i !== local) g.el.style.transition = `transform 180ms ${EASE}`;
    });
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    const startY = e.clientY + scrollPos(scroller);
    const drag = { target: local };
    dragRef.current = drag;

    let clientY = e.clientY;
    function onMove(ev) {
      clientY = ev.clientY;
      update();
    }

    // Edge auto-scroll, for a same-date group taller than the visible
    // area: holding the pointer within EDGE px of the scroller's visible
    // top/bottom scrolls it, faster the closer to (or further past) the
    // edge — and the scroll listener below keeps the row under the
    // pointer as it does. Stops once the row is already pinned at that
    // end of its group, since there's nowhere further to take it.
    const EDGE = 60, MAX_SPEED = 1.2; // px per ms at full depth
    let autoScrollFrame = null, lastFrame = null, carry = 0;
    function visibleBounds() {
      const r = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) };
    }
    function autoScroll(now) {
      const dt = lastFrame === null ? 16 : Math.min(now - lastFrame, 50);
      lastFrame = now;
      const { top, bottom } = visibleBounds();
      const rowTop = dragged.top + currentTranslateY(dragged.el);
      let depth = 0;
      if (clientY < top + EDGE && rowTop > groupTop + 0.5) depth = -Math.min(1, (top + EDGE - clientY) / EDGE);
      else if (clientY > bottom - EDGE && rowTop + dragged.height < groupBottom - 0.5) depth = Math.min(1, (clientY - (bottom - EDGE)) / EDGE);
      // Accumulate sub-pixel amounts — scrollTop can round a small
      // increment away entirely, stalling a slow scroll near the edge.
      carry = depth === 0 ? 0 : carry + depth * Math.abs(depth) * MAX_SPEED * dt;
      const step = Math.trunc(carry);
      if (step !== 0) { scrollByPx(scroller, step); carry -= step; }
      autoScrollFrame = requestAnimationFrame(autoScroll);
    }
    autoScrollFrame = requestAnimationFrame(autoScroll);
    // Scrolling mid-drag (e.g. the mouse wheel) moves the rows under a
    // stationary pointer, so it needs the same update a pointer move does.
    const scrollTarget = scroller || window;
    function update() {
      const dy = Math.max(groupTop - dragged.top, Math.min(groupBottom - dragged.height - dragged.top, clientY + scrollPos(scroller) - startY));
      dragged.el.style.transform = `translateY(${dy}px)`;

      // Landing slot: how many other rows end up before the dragged one.
      // A row below it moves above once the dragged row's bottom edge
      // passes that row's midpoint; a row above it stays above until the
      // dragged row's top edge passes back over its midpoint.
      const top = dragged.top + dy;
      const others = group.filter((_, i) => i !== local);
      drag.target = group.filter((g, i) => {
        const mid = g.top + g.height / 2;
        if (i < local) return top >= mid;
        if (i > local) return top + dragged.height > mid;
        return false;
      }).length;

      // Lay the group out in its would-be order and shift each other row
      // to its would-be top.
      const order = [...others];
      order.splice(drag.target, 0, dragged);
      let y = groupTop;
      order.forEach((g) => {
        if (g !== dragged) g.el.style.transform = `translateY(${y - g.top}px)`;
        y += g.height;
      });
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      scrollTarget.removeEventListener("scroll", update);
      cancelAnimationFrame(autoScrollFrame);
      dragged.el.style.boxShadow = "";
      // Stay on top, opaque, until it's finished gliding into its slot.
      setTimeout(() => {
        dragged.el.style.zIndex = "";
        dragged.el.style.position = "";
        dragged.el.style.background = savedBackground;
      }, 360);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragRef.current = null;
      // The pointerup can land on the row itself, whose click opens it
      // for editing — swallow that one click.
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);

      if (drag.target !== local && onReorder) {
        onReorder(fromIdx, start + drag.target);
      } else {
        group.forEach((g) => {
          g.el.style.transition = `transform 220ms ${EASE}`;
          g.el.style.transform = "translateY(0px)";
        });
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    scrollTarget.addEventListener("scroll", update);
  }

  // True for the click that immediately follows a drag's release.
  function isDragClick() {
    return suppressClickRef.current;
  }

  useEffect(() => {
    return () => {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
    };
  }, []);

  return { rowRefs, pendingSettleId, startDrag, isDragClick };
}
