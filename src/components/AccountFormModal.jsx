import { useState } from "react";
import { Trash2 } from "lucide-react";
import { C, TYPES, ISA_KINDS } from "../lib/theme";
import { toMinorUnits, fromMinorUnits } from "../lib/scale";
import { ModalShell, Field, inputStyle } from "./ui";

/* ---------------------------------------------------------
   Account form modal
--------------------------------------------------------- */
export function AccountFormModal({ initial, accounts, currencies, symbols, counterparties, onCancel, onSave, onDelete }) {
  const wrappers = accounts.filter((a) => a.type === "isa-parent");

  const [name, setName] = useState(initial.name || "");
  const [type, setType] = useState(initial.typePreset || initial.type || "asset");
  const [currency, setCurrency] = useState(initial.currency || "GBP");
  const [symbol, setSymbol] = useState(initial.symbol || "");
  const currencyScale = currencies.find((c) => c.code === currency)?.scale ?? 2;
  const [opening, setOpening] = useState(initial.openingBalance ? fromMinorUnits(initial.openingBalance, currencyScale) : "0");
  const [flexible, setFlexible] = useState(!!initial.flexible);
  // Counterparty names were always free text (any institution/payee not
  // used yet is fine to type) — the backend find-or-creates one on save
  // (see LedgerStateService::resolveCounterparty()), so this stays a text
  // input with a datalist rather than becoming a closed picker. Same
  // underlying field for every account type — "where this account is
  // held" for a real account, "who was paid/who paid" for an
  // income/expense one — just labelled differently below.
  const [counterparty, setCounterparty] = useState(initial.counterparty || "");
  // Same free-text-with-datalist treatment as counterparty — a
  // product-type tag ("Credit Card", "Loan", "Trading") for further
  // grouping when counterparty alone doesn't distinguish enough accounts
  // apart. Plain string on the account itself, no backing entity — see
  // CLAUDE.md.
  const [subtype, setSubtype] = useState(initial.subtype || "");
  // "" = not an ISA, "cash-isa"/"lifetime-isa"/"innovative-finance-isa" = a
  // standalone flat ISA, or an isa-parent account id = "this is a
  // subaccount of that Stocks & Shares ISA wrapper".
  const [isaChoice, setIsaChoice] = useState(initial.isaParentPreset || initial.isaParentId || initial.isaKind || "");

  const isWrapper = type === "isa-parent";
  const isSubaccount = wrappers.some((w) => w.id === isaChoice);
  // Flexibility is a property of the ISA product itself (the wrapper, for
  // a Stocks & Shares ISA), not of each subaccount — so the toggle only
  // appears where it actually applies. Counterparty works the same way.
  const showFlexible = isWrapper || (!isSubaccount && !!isaChoice);
  const showCounterparty = !isSubaccount;
  // Nominal (income/expense) accounts use this same field for "who was
  // paid/who paid" rather than "where this account is held" — see
  // CLAUDE.md's real-vs-nominal-account distinction. Only the label and
  // placeholder change; it's the same free-text/datalist input either way.
  const isNominalType = type === "income" || type === "isa-income" || type === "expense";
  const counterpartyLabel = isNominalType ? "Counterparty" : "Institution";
  const knownCounterparties = counterparties.map((c) => c.name).sort();
  const knownSubtypes = Array.from(new Set(accounts.map((a) => a.subtype).filter(Boolean))).sort();
  const tradingCurrency = symbols.find((s) => s.ticker === symbol)?.tradingCurrency;

  function submit() {
    if (!name.trim()) return;
    if (type === "investment" && !symbol.trim()) return;
    const data = {
      id: initial.id,
      name: name.trim(),
      type,
      openingBalance: toMinorUnits(opening, currencyScale) || 0,
      ...(type === "investment" ? { symbol: symbol.trim().toUpperCase() } : { currency }),
      ...(showCounterparty && counterparty.trim() ? { counterparty: counterparty.trim() } : {}),
      ...(!isWrapper && subtype.trim() ? { subtype: subtype.trim() } : {}),
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
        {showCounterparty && (
          <Field label={counterpartyLabel}>
            <input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} style={inputStyle} placeholder={isNominalType ? "e.g. Tesco" : "e.g. Barclays"} list="ll-counterparties" />
            <datalist id="ll-counterparties">
              {knownCounterparties.map((i) => <option key={i} value={i} />)}
            </datalist>
          </Field>
        )}
        {!isWrapper && (
          <Field label="Subtype">
            <input value={subtype} onChange={(e) => setSubtype(e.target.value)} style={inputStyle} placeholder="e.g. Credit Card, Loan, Trading" list="ll-subtypes" />
            <datalist id="ll-subtypes">
              {knownSubtypes.map((s) => <option key={s} value={s} />)}
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
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={inputStyle}>
              <option value="">Select symbol…</option>
              {symbols.map((s) => <option key={s.ticker} value={s.ticker}>{s.ticker} — {s.name}</option>)}
            </select>
            {symbols.length === 0 && (
              <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>No symbols set up yet — adding a new one isn't supported here yet.</div>
            )}
          </Field>
        )}
        {!isWrapper && type === "investment" && symbol && (
          <Field label="Trading currency">
            <div style={{ fontSize: 13.5, color: C.inkSoft, padding: "6px 0" }}>{tradingCurrency} <span style={{ color: C.inkFaint, fontSize: 12 }}>— set by the symbol, not editable per account</span></div>
          </Field>
        )}
        {!isWrapper && type !== "investment" && (
          <Field label="Currency">
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          </Field>
        )}
        {!isWrapper && type !== "investment" && (
          <Field label="Opening balance"><input type="number" step={10 ** -currencyScale} value={opening} onChange={(e) => setOpening(e.target.value)} style={inputStyle} /></Field>
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
