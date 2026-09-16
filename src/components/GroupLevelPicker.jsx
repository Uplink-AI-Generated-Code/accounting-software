import React from "react";
import { X, BookmarkPlus } from "lucide-react";
import { C } from "../lib/theme";
import { GROUP_DIMENSIONS } from "../lib/theme";
import { groupLevelsLabel } from "../lib/grouping";

export function GroupLevelPicker({ levels, onChange, saved, onSave, onRemove }) {
  function setLevel(i, val) {
    const next = levels.slice(0, i);
    if (val) next.push(val);
    onChange(next.length ? next : ["type"]);
  }
  const selStyle = { fontSize: 11.5, padding: "3px 5px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.paper, color: C.ink };
  const alreadySaved = (saved || []).some((s) => JSON.stringify(s.levels) === JSON.stringify(levels));
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1 flex-wrap" style={{ rowGap: 4 }}>
        {GROUP_DIMENSIONS.map((_, i) => {
          if (i > 0 && !levels[i - 1]) return null;
          const used = levels.slice(0, i);
          const options = GROUP_DIMENSIONS.filter((d) => !used.includes(d.key));
          return (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: C.inkFaint, fontSize: 11 }}>›</span>}
              <select value={levels[i] || ""} onChange={(e) => setLevel(i, e.target.value)} style={selStyle}>
                {i > 0 && <option value="">—</option>}
                {options.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </React.Fragment>
          );
        })}
        {onSave && (
          <button
            onClick={() => !alreadySaved && onSave(levels)}
            disabled={alreadySaved}
            title={alreadySaved ? "Already saved" : "Save this grouping"}
            style={{ padding: 4, color: alreadySaved ? C.goldDim : C.inkFaint, opacity: alreadySaved ? 0.6 : 1 }}
          >
            <BookmarkPlus size={14} />
          </button>
        )}
      </div>
      {saved && saved.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {saved.map((s) => {
            const active = JSON.stringify(s.levels) === JSON.stringify(levels);
            return (
              <span key={s.id} className="flex items-center" style={{ border: `1px solid ${active ? C.gold : C.line}`, borderRadius: 4, overflow: "hidden" }}>
                <button onClick={() => onChange(s.levels)} style={{ padding: "3px 6px", fontSize: 11, background: active ? C.paperDim : "transparent", color: active ? C.ink : C.inkSoft, fontWeight: active ? 600 : 400 }}>
                  {groupLevelsLabel(s.levels)}
                </button>
                <button onClick={() => onRemove(s.id)} title="Remove" style={{ padding: "3px 4px", color: C.inkFaint }}>
                  <X size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
