import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { C } from "../lib/theme";
import { buildNestedGroups, flattenAllAccounts, leafMatchesQuery } from "../lib/grouping";
import { miniInput } from "./ui";

function accountLabel(a) {
  return `${a.name} (${a.type === "investment" ? a.symbol : a.currency})`;
}

// Recursive group renderer for browse mode (no active search) — mirrors
// the nesting `buildNestedGroups` already produces for the sidebar/
// Overview, so the picker's tree always matches whatever grouping the
// user currently has active there.
function GroupNodeList({ nodes, depth, onSelect }) {
  return nodes.map((node) => (
    <div key={node.key}>
      <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.5, padding: `3px 6px 3px ${6 + depth * 12}px` }}>
        {node.label}
      </div>
      {node.leaf
        ? node.items.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              className="w-full text-left"
              style={{ display: "block", padding: `4px 6px 4px ${6 + (depth + 1) * 12}px`, borderRadius: 4, fontSize: 12.5, color: C.ink }}
            >
              {accountLabel(a)}
            </button>
          ))
        : <GroupNodeList nodes={node.children} depth={depth + 1} onSelect={onSelect} />}
    </div>
  ));
}

// Replaces a plain `<select>` of every account with a combobox that, when
// idle, browses the *same* nested tree the sidebar/Overview currently show
// (via `groupLevels` + `buildNestedGroups` — see CLAUDE.md's "UI
// conventions"), and when the user types, searches across all four
// dimensions (Type, Institution, Subtype, Currency) at once regardless of
// which ones the active grouping actually nests by — see
// `flattenAllAccounts`. `accounts` is the already-filtered candidate list
// (e.g. minus the ledger's own account); `allAccounts` is the full list,
// needed to resolve an ISA subaccount's inherited institution correctly.
export function AccountPicker({ accounts, allAccounts, symbols, groupLevels, value, onChange, placeholder = "Select account…" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const selected = accounts.find((a) => a.id === value) || allAccounts.find((a) => a.id === value);
  const tree = useMemo(() => buildNestedGroups(accounts, groupLevels, allAccounts, symbols), [accounts, groupLevels, allAccounts, symbols]);
  const leaves = useMemo(() => (query.trim() ? flattenAllAccounts(accounts, allAccounts, symbols) : null), [accounts, allAccounts, symbols, query]);
  const filtered = leaves ? leaves.filter((l) => leafMatchesQuery(l, query)) : null;

  function select(id) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ ...miniInput, width: 190, textAlign: "left", cursor: "pointer", color: selected ? C.ink : C.inkFaint }}
      >
        {selected ? accountLabel(selected) : placeholder}
      </button>
    );
  }

  return (
    <div ref={containerRef} style={{ width: 260, position: "relative" }}>
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 5, background: C.card, padding: 6 }}>
        <div className="flex items-center gap-1.5" style={{ borderBottom: `1px solid ${C.lineSoft}`, paddingBottom: 5, marginBottom: 4 }}>
          <Search size={13} color={C.inkFaint} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setOpen(false); setQuery(""); }
              if (e.key === "Enter" && filtered && filtered.length) select(filtered[0].account.id);
            }}
            placeholder="Search accounts…"
            style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 12.5, color: C.ink }}
          />
          <button type="button" onClick={() => { setOpen(false); setQuery(""); }}><X size={13} color={C.inkFaint} /></button>
        </div>
        <div style={{ maxHeight: 220, overflowY: "auto" }}>
          {filtered ? (
            filtered.length ? (
              filtered.map((l) => (
                <button
                  key={l.account.id}
                  type="button"
                  onClick={() => select(l.account.id)}
                  className="flex flex-col w-full text-left"
                  style={{ padding: "4px 6px", borderRadius: 4 }}
                >
                  <span style={{ fontSize: 12.5, color: C.ink }}>{accountLabel(l.account)}</span>
                  <span style={{ fontSize: 10.5, color: C.inkFaint }}>{l.path.join(" › ")}</span>
                </button>
              ))
            ) : (
              <div style={{ fontSize: 12, color: C.inkFaint, padding: "4px 6px" }}>No matches</div>
            )
          ) : (
            <GroupNodeList nodes={tree} depth={0} onSelect={select} />
          )}
        </div>
      </div>
    </div>
  );
}
