import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { C } from "../lib/theme";
import { todayISO } from "../lib/format";
import { taxYearStartYearFor, taxYearBounds } from "../lib/isa";
import { miniInput } from "./ui";
import * as api from "../api";

const TAX_YEAR_PATTERN = /^(\d{4})-(\d{4})\.sqlite3$/;

// The shared list-or-create-form content — used both inside the header's
// small popover (DatabaseSwitcher) and, fullScreen, as the blocking
// "no active database" state (DatabaseSwitcherBlocking). `entries` is
// GET /api/databases's response, already fetched by the caller (each
// wrapper owns its own fetch — see below for why). `onDone` fires once a
// switch/create/new-year action has actually succeeded server-side; this
// component never reloads the page itself, so it stays usable in both
// contexts — see CLAUDE.md's "The active tax year".
function DatabasePicker({ entries, fullScreen, attemptNavigation, onDone }) {
  const [showAll, setShowAll] = useState(false);
  const [startYear, setStartYear] = useState(() => String(taxYearStartYearFor(todayISO())));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const taxYearEntries = entries.filter((e) => e.isTaxYear);
  const visible = showAll ? entries : taxYearEntries;
  const active = entries.find((e) => e.active);
  const latestTaxYear = taxYearEntries.reduce((max, e) => (!max || e.filename > max.filename ? e : max), null);
  // Only offered from the currently active file, and only when it's the
  // latest tax-year one present — see the design doc's Frontend section.
  // (This condition is naturally false in the fullScreen/no-active-
  // database case too, since no entry has active:true there — the
  // explicit !fullScreen is belt-and-suspenders, matching the spec's
  // explicit requirement.)
  const showStartNewYear = !fullScreen && active && latestTaxYear && active.filename === latestTaxYear.filename;

  function guarded(action) {
    if (attemptNavigation) attemptNavigation(action);
    else action();
  }

  function finish(promise) {
    setBusy(true);
    setError("");
    promise.then(onDone).catch((e) => { setError(e.message); setBusy(false); });
  }

  function pick(filename) {
    guarded(() => finish(api.setActiveDatabase(filename)));
  }

  function startNewYear() {
    guarded(() => finish(api.startNewTaxYear().then((entry) => api.setActiveDatabase(entry.filename))));
  }

  function create() {
    const year = parseInt(startYear, 10);
    if (!Number.isInteger(year)) {
      setError("Enter a whole number for the tax year.");
      return;
    }
    guarded(() => finish(api.createDatabase(year).then((entry) => api.setActiveDatabase(entry.filename))));
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col gap-2" style={{ minWidth: 220 }}>
        <div style={{ fontSize: 12.5, color: C.inkSoft }}>No databases yet — create the first one.</div>
        <label style={{ display: "block" }}>
          <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 }}>Tax year starting</div>
          <input type="number" value={startYear} onChange={(e) => setStartYear(e.target.value)} style={miniInput} />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={create}
          className="px-3 py-1.5 rounded"
          style={{ background: C.ink, color: C.paper, fontSize: 12.5, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Creating…" : "Create"}
        </button>
        {error && <div style={{ fontSize: 12, color: C.debit }}>{error}</div>}
      </div>
    );
  }

  return (
    <div style={{ minWidth: 220 }}>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {visible.map((e) => (
          <button
            key={e.filename}
            type="button"
            disabled={busy}
            onClick={() => pick(e.filename)}
            className="w-full text-left flex items-center justify-between"
            style={{
              padding: "6px 8px",
              borderRadius: 4,
              fontSize: 12.5,
              background: e.active ? C.paperDim : "transparent",
              color: e.active ? C.ink : C.inkSoft,
              fontWeight: e.active ? 600 : 400,
            }}
          >
            <span>{e.label || e.filename}</span>
            {e.active && <span style={{ fontSize: 10.5, color: C.inkFaint }}>active</span>}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1.5" style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Show all files
      </label>
      {showStartNewYear && (
        <button
          type="button"
          disabled={busy}
          onClick={startNewYear}
          className="w-full text-left"
          style={{ padding: "6px 8px", marginTop: 6, borderRadius: 4, fontSize: 12.5, color: C.gold, borderTop: `1px solid ${C.lineSoft}` }}
        >
          {(() => {
            const m = TAX_YEAR_PATTERN.exec(latestTaxYear.filename);
            const label = m ? taxYearBounds(parseInt(m[1], 10) + 1).label : "next year";
            return busy ? "Starting…" : `Start ${label} tax year`;
          })()}
        </button>
      )}
      {error && <div style={{ marginTop: 6, fontSize: 12, color: C.debit }}>{error}</div>}
    </div>
  );
}

// Header trigger + small popover — click-outside-to-close, same pattern
// as AccountPicker.jsx. Fetches its own database list on mount (kept
// separate from DatabasePicker so it can show the active file's label on
// the trigger button itself without the popover needing to be open).
export function DatabaseSwitcher({ attemptNavigation, onSwitched }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(null); // null = still loading
  const containerRef = useRef(null);

  useEffect(() => {
    api.getDatabases().then(setEntries).catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const active = (entries || []).find((e) => e.active);
  const label = active ? active.label || active.filename : "Select database";

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded"
        style={{ border: `1px solid ${C.line}`, padding: "5px 10px", fontSize: 12.5, color: C.inkSoft, background: "transparent" }}
      >
        <span className="ll-mono">{label}</span>
        <ChevronDown size={12} />
      </button>
      {open && entries && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 40,
            background: C.card,
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            padding: 10,
            boxShadow: "0 8px 24px rgba(34,39,31,0.18)",
          }}
        >
          <DatabasePicker
            entries={entries}
            attemptNavigation={attemptNavigation}
            onDone={() => { setOpen(false); onSwitched(); }}
          />
        </div>
      )}
    </div>
  );
}

// Full-screen, non-dismissible variant for when there's no active
// database at all — see App.jsx's noActiveDatabase state and
// MigrationStatusListener's "no_active_database" reason. No
// attemptNavigation here: nothing in the app has loaded yet, so there's
// nothing to guard against navigating away from.
export function DatabaseSwitcherBlocking({ onSwitched }) {
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    api.getDatabases().then(setEntries).catch(() => setEntries([]));
  }, []);

  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: C.paper, zIndex: 100 }}>
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: 22, width: 380, maxWidth: "92vw", boxShadow: "0 12px 40px rgba(34,39,31,0.25)" }}>
        <h3 className="ll-serif" style={{ fontSize: 17, marginBottom: 4 }}>Select a database</h3>
        <p style={{ fontSize: 12.5, color: C.inkFaint, marginBottom: 14 }}>No database is active yet — pick one below, or create your first.</p>
        {null === entries ? (
          <div style={{ fontSize: 12.5, color: C.inkFaint }}>Loading…</div>
        ) : (
          <DatabasePicker entries={entries} fullScreen onDone={onSwitched} />
        )}
      </div>
    </div>
  );
}
