import { useState } from "react";
import { Trash2 } from "lucide-react";
import { C, TYPES, CURRENCIES, ISA_KINDS } from "../lib/theme";
import { ModalShell, Field, inputStyle } from "./ui";

/* ---------------------------------------------------------
   Account form modal
--------------------------------------------------------- */
export function AccountFormModal({ initial, accounts, onCancel, onSave, onDelete }) {
  const wrappers = accounts.filter((a) => a.type === "isa-parent");

  const [name, setName] = useState(initial.name || "");
  const [type, setType] = useState(initial.typePreset || initial.type || "asset");
  const [currency, setCurrency] = useState(initial.currency || "GBP");
  const [symbol, setSymbol] = useState(initial.symbol || "");
  const [opening, setOpening] = useState(initial.openingBalance ? String(initial.openingBalance) : "0");
  const [flexible, setFlexible] = useState(!!initial.flexible);
  const [institution, setInstitution] = useState(initial.institution || "");
  // "" = not an ISA, "cash-isa"/"lifetime-isa"/"innovative-finance-isa" = a
  // standalone flat ISA, or an isa-parent account id = "this is a
  // subaccount of that Stocks & Shares ISA wrapper".
  const [isaChoice, setIsaChoice] = useState(initial.isaParentPreset || initial.isaParentId || initial.isaKind || "");

  const isWrapper = type === "isa-parent";
  const isSubaccount = wrappers.some((w) => w.id === isaChoice);
  // Flexibility is a property of the ISA product itself (the wrapper, for
  // a Stocks & Shares ISA), not of each subaccount — so the toggle only
  // appears where it actually applies. Institution works the same way.
  const showFlexible = isWrapper || (!isSubaccount && !!isaChoice);
  const showInstitution = !isSubaccount;
  const knownInstitutions = Array.from(new Set(accounts.map((a) => a.institution).filter(Boolean))).sort();

  function submit() {
    if (!name.trim()) return;
    if (type === "investment" && !symbol.trim()) return;
    const data = {
      id: initial.id,
      name: name.trim(),
      type,
      currency,
      openingBalance: parseFloat(opening) || 0,
      ...(type === "investment" ? { symbol: symbol.trim().toUpperCase() } : {}),
      ...(showInstitution && institution.trim() ? { institution: institution.trim() } : {}),
    };
    const isaEligible = type === "asset" || type === "investment";
    if (isWrapper) {
      // A wrapper holds nothing directly — no currency or opening balance.
      delete data.currency;
      delete data.openingBalance;
      data.flexible = flexible;
    } else if (isaEligible && isSubaccount) {
      data.isaKind = "stocks-shares-isa";
      data.isaParentId = isaChoice;
    } else if (isaEligible && isaChoice) {
      data.isaKind = isaChoice;
      data.flexible = flexible;
    }
    onSave(data);
  }

  return (
    <ModalShell onCancel={onCancel} title={initial.id ? "Edit account" : "New account"}>
      <div className="flex flex-col gap-3" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}>
        <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="e.g. Barclays Current Account" /></Field>
        {showInstitution && (
          <Field label="Institution">
            <input value={institution} onChange={(e) => setInstitution(e.target.value)} style={inputStyle} placeholder="e.g. Barclays" list="ll-institutions" />
            <datalist id="ll-institutions">
              {knownInstitutions.map((i) => <option key={i} value={i} />)}
            </datalist>
          </Field>
        )}
        <Field label="Type">
          <select value={type} onChange={(e) => { setType(e.target.value); setIsaChoice(""); }} style={inputStyle} disabled={!!initial.typePreset}>
            {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </Field>

        {!isWrapper && type === "investment" && (
          <Field label="Symbol">
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} style={{ ...inputStyle, textTransform: "uppercase" }} placeholder="e.g. AAPL" />
          </Field>
        )}
        {!isWrapper && (
          <Field label={type === "investment" ? "Trading currency" : "Currency"}>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        )}
        {!isWrapper && type !== "investment" && (
          <Field label="Opening balance"><input type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} style={inputStyle} /></Field>
        )}

        {!isWrapper && (type === "asset" || type === "investment") && (
          <Field label="ISA">
            <select value={isaChoice} onChange={(e) => setIsaChoice(e.target.value)} style={inputStyle} disabled={!!initial.isaParentPreset}>
              <option value="">Not an ISA</option>
              {type === "asset" && ISA_KINDS.filter((k) => k.key !== "stocks-shares-isa").map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
              {wrappers.map((w) => (
                <option key={w.id} value={w.id}>{type === "investment" ? "Part of" : "Cash within"}: {w.name}</option>
              ))}
            </select>
            {type === "investment" && wrappers.length === 0 && (
              <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>Create a Stocks & Shares ISA wrapper first to hold this as a subaccount.</div>
            )}
          </Field>
        )}

        {showFlexible && (
          <label className="flex items-center gap-2" style={{ fontSize: 13, color: C.inkSoft }}>
            <input type="checkbox" checked={flexible} onChange={(e) => setFlexible(e.target.checked)} />
            Flexible ISA — withdrawals this tax year can be replaced without using extra allowance
          </label>
        )}

        <div className="flex justify-between items-center mt-2">
          {onDelete ? <button type="button" onClick={onDelete} className="flex items-center gap-1 text-sm" style={{ color: C.debit }}><Trash2 size={14} /> Delete</button> : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded text-sm" style={{ border: `1px solid ${C.line}` }}>Cancel</button>
            <button type="button" onClick={submit} className="px-3 py-1.5 rounded text-sm" style={{ background: C.ink, color: C.paper }}>Save</button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
