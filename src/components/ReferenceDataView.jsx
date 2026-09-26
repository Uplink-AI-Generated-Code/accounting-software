import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { C } from "../lib/theme";
import * as api from "../api";
import { inputStyle } from "./ui";

// Full admin CRUD for Currency/Symbol — see
// docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md.
// None of these writes are optimistic: every mutation awaits its
// response, then triggers onRefresh() (App.jsx's currencies/symbols
// refetch) so every other view (pickers, fmt/fmtUnits's scale cache,
// grouping) picks up the change — same "wait for the response" posture
// CLAUDE.md documents for everything except the plain account/settings
// save.
export function ReferenceDataView({ currencies, symbols, onRefresh }) {
  const [error, setError] = useState("");

  function withErrorHandling(fn) {
    return (...args) =>
      fn(...args)
        .then(() => { setError(""); return onRefresh(); })
        .catch((e) => setError(e.message));
  }

  return (
    <div className="flex flex-col gap-8">
      <h2 className="ll-serif" style={{ fontSize: 20 }}>Reference data</h2>
      {error && (
        <div className="px-3 py-2 rounded" style={{ background: C.debitBg, color: C.debit, fontSize: 13 }}>{error}</div>
      )}
      <CurrencySection currencies={currencies} onMutate={withErrorHandling} />
      <SymbolSection symbols={symbols} currencies={currencies} onMutate={withErrorHandling} />
    </div>
  );
}

function CurrencySection({ currencies, onMutate }) {
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newScale, setNewScale] = useState("2");

  const create = onMutate(() => api.createCurrency({ code: newCode.trim().toUpperCase(), name: newName.trim() || undefined, scale: parseInt(newScale, 10) }));
  const patchName = onMutate((code, name) => api.patchCurrency(code, { name }));
  const changeScale = onMutate((code, scale) => api.patchCurrency(code, { scale }));
  const remove = onMutate((code) => api.deleteCurrency(code));

  function submitNew() {
    if (!newCode.trim()) return;
    create().then(() => { setNewCode(""); setNewName(""); setNewScale("2"); });
  }

  return (
    <section>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: C.inkSoft, marginBottom: 8 }}>Currencies</h3>
      <div className="flex flex-col gap-1.5">
        {currencies.map((c) => (
          <CurrencyRow key={c.code} currency={c} onPatchName={(name) => patchName(c.code, name)} onChangeScale={(scale) => changeScale(c.code, scale)} onDelete={() => remove(c.code)} />
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="Code, e.g. NZD" style={{ ...inputStyle, width: 90 }} />
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)" style={{ ...inputStyle, width: 200 }} />
        <input type="number" min="0" step="1" value={newScale} onChange={(e) => setNewScale(e.target.value)} placeholder="Scale" style={{ ...inputStyle, width: 70 }} />
        <button type="button" onClick={submitNew} className="flex items-center gap-1" style={{ fontSize: 12.5, color: C.gold }}><Plus size={13} /> Add currency</button>
      </div>
    </section>
  );
}

function CurrencyRow({ currency, onPatchName, onChangeScale, onDelete }) {
  const [name, setName] = useState(currency.name || "");

  function changeScale() {
    const next = window.prompt(`New scale for ${currency.code} (currently ${currency.scale}):`, String(currency.scale));
    if (null === next || next.trim() === "") return;
    const parsed = parseInt(next, 10);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    if (parsed === currency.scale) return;
    if (!window.confirm(`Changing ${currency.code}'s scale from ${currency.scale} to ${parsed} will rescale every existing amount using it and cannot be undone. Continue?`)) return;
    onChangeScale(parsed);
  }

  return (
    <div className="flex items-center gap-2" style={{ padding: "4px 0" }}>
      <span className="ll-mono" style={{ width: 50, fontWeight: 600 }}>{currency.code}</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name !== (currency.name || "") && onPatchName(name)}
        placeholder="Name"
        style={{ ...inputStyle, width: 200 }}
      />
      <button type="button" onClick={changeScale} style={{ fontSize: 12, color: C.inkSoft, background: "none", border: `1px solid ${C.line}`, borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>
        Scale: {currency.scale} — Change…
      </button>
      <button type="button" onClick={onDelete} title="Delete"><Trash2 size={14} color={C.debit} /></button>
    </div>
  );
}

function SymbolSection({ symbols, currencies, onMutate }) {
  const [newTicker, setNewTicker] = useState("");
  const [newName, setNewName] = useState("");
  const [newScale, setNewScale] = useState("6");
  const [newTradingCurrency, setNewTradingCurrency] = useState(currencies[0]?.code || "");

  const create = onMutate(() => api.createSymbol({ ticker: newTicker.trim().toUpperCase(), name: newName.trim(), scale: parseInt(newScale, 10), tradingCurrency: newTradingCurrency }));
  const patchName = onMutate((ticker, tradingCurrency, name) => api.patchSymbol(ticker, tradingCurrency, { name }));
  const changeScale = onMutate((ticker, tradingCurrency, scale) => api.patchSymbol(ticker, tradingCurrency, { scale }));
  const remove = onMutate((ticker, tradingCurrency) => api.deleteSymbol(ticker, tradingCurrency));

  function submitNew() {
    if (!newTicker.trim() || !newName.trim() || !newTradingCurrency) return;
    create().then(() => { setNewTicker(""); setNewName(""); setNewScale("6"); });
  }

  return (
    <section>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: C.inkSoft, marginBottom: 8 }}>Symbols</h3>
      <div className="flex flex-col gap-1.5">
        {symbols.map((s) => (
          <SymbolRow
            key={`${s.ticker}:${s.tradingCurrency}`}
            symbol={s}
            onPatchName={(name) => patchName(s.ticker, s.tradingCurrency, name)}
            onChangeScale={(scale) => changeScale(s.ticker, s.tradingCurrency, scale)}
            onDelete={() => remove(s.ticker, s.tradingCurrency)}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <input value={newTicker} onChange={(e) => setNewTicker(e.target.value)} placeholder="Ticker, e.g. AAPL" style={{ ...inputStyle, width: 100 }} />
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" style={{ ...inputStyle, width: 180 }} />
        <input type="number" min="0" step="1" value={newScale} onChange={(e) => setNewScale(e.target.value)} placeholder="Scale" style={{ ...inputStyle, width: 70 }} />
        <select value={newTradingCurrency} onChange={(e) => setNewTradingCurrency(e.target.value)} style={{ ...inputStyle, width: 90 }}>
          {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </select>
        <button type="button" onClick={submitNew} className="flex items-center gap-1" style={{ fontSize: 12.5, color: C.gold }}><Plus size={13} /> Add symbol</button>
      </div>
    </section>
  );
}

function SymbolRow({ symbol, onPatchName, onChangeScale, onDelete }) {
  const [name, setName] = useState(symbol.name);

  function changeScale() {
    const next = window.prompt(`New scale for ${symbol.ticker} (${symbol.tradingCurrency}) (currently ${symbol.scale}):`, String(symbol.scale));
    if (null === next || next.trim() === "") return;
    const parsed = parseInt(next, 10);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    if (parsed === symbol.scale) return;
    if (!window.confirm(`Changing ${symbol.ticker} (${symbol.tradingCurrency})'s scale from ${symbol.scale} to ${parsed} will rescale every existing amount using it and cannot be undone. Continue?`)) return;
    onChangeScale(parsed);
  }

  return (
    <div className="flex items-center gap-2" style={{ padding: "4px 0" }}>
      <span className="ll-mono" style={{ width: 70, fontWeight: 600 }}>{symbol.ticker}</span>
      <span className="ll-mono" style={{ width: 40, color: C.inkFaint }}>{symbol.tradingCurrency}</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name !== symbol.name && onPatchName(name)}
        placeholder="Name"
        style={{ ...inputStyle, width: 180 }}
      />
      <button type="button" onClick={changeScale} style={{ fontSize: 12, color: C.inkSoft, background: "none", border: `1px solid ${C.line}`, borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>
        Scale: {symbol.scale} — Change…
      </button>
      <button type="button" onClick={onDelete} title="Delete"><Trash2 size={14} color={C.debit} /></button>
    </div>
  );
}
