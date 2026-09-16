import { C, ISA_KINDS } from "../lib/theme";

// The flat equivalent of SidebarGroupTree, shown instead of the tree while
// a search query is active — `leaves` is already filtered
// (lib/grouping.js's flattenGroupLeaves + leafMatchesQuery), each carrying
// its full grouping path so a match against, say, an institution or
// subtype name is still legible even though the tree itself is collapsed
// away.
export function SidebarSearchResults({ leaves, selectedId, onSelect, accountDisplay }) {
  if (leaves.length === 0) {
    return <p style={{ fontSize: 12.5, color: C.inkFaint, padding: "4px 8px" }}>No accounts match.</p>;
  }
  return leaves.map(({ account: a, path }) => (
    <button
      key={a.id}
      onClick={() => onSelect(a.id)}
      className="w-full text-left px-2 py-1.5 rounded flex flex-col"
      style={{ background: selectedId === a.id ? C.paperDim : "transparent", marginBottom: 1 }}
    >
      <span className="flex items-center justify-between">
        <span style={{ fontSize: 13.5, color: C.ink, display: "flex", alignItems: "center", gap: 5 }}>
          {a.name}
          {a.isaKind && <span title={ISA_KINDS.find((k) => k.key === a.isaKind)?.label} style={{ fontSize: 9.5, fontWeight: 700, color: C.gold, border: `1px solid ${C.goldDim}`, borderRadius: 3, padding: "1px 3px", letterSpacing: 0.3 }}>ISA</span>}
        </span>
        <span className="ll-mono" style={{ fontSize: a.type === "investment" ? 11 : 12, color: (a.balance || 0) < 0 ? C.debit : C.inkSoft }}>{accountDisplay(a)}</span>
      </span>
      <span style={{ fontSize: 10.5, color: C.inkFaint }}>{path.join(" › ")}</span>
    </button>
  ));
}

// Renders nested groups in the sidebar — indented headers down to
// whichever level is a leaf, where actual clickable account rows appear.
export function SidebarGroupTree({ groups, depth, selectedId, onSelect, accountDisplay }) {
  return groups.map((g) => (
    <div key={g.key} className="mb-3" style={{ marginLeft: depth * 8 }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: C.inkFaint, padding: "4px 8px" }}>{g.label}</div>
      {g.leaf ? (
        g.items.map((a) => (
          <button key={a.id} onClick={() => onSelect(a.id)} className="w-full text-left px-2 py-1.5 rounded flex items-center justify-between" style={{ background: selectedId === a.id ? C.paperDim : "transparent" }}>
            <span style={{ fontSize: 13.5, color: C.ink, display: "flex", alignItems: "center", gap: 5 }}>
              {a.name}
              {a.isaKind && <span title={ISA_KINDS.find((k) => k.key === a.isaKind)?.label} style={{ fontSize: 9.5, fontWeight: 700, color: C.gold, border: `1px solid ${C.goldDim}`, borderRadius: 3, padding: "1px 3px", letterSpacing: 0.3 }}>ISA</span>}
            </span>
            <span className="ll-mono" style={{ fontSize: a.type === "investment" ? 11 : 12, color: (a.balance || 0) < 0 ? C.debit : C.inkSoft }}>{accountDisplay(a)}</span>
          </button>
        ))
      ) : (
        <SidebarGroupTree groups={g.children} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} accountDisplay={accountDisplay} />
      )}
    </div>
  ));
}
