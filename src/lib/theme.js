/* ---------------------------------------------------------
   Tokens
--------------------------------------------------------- */
export const C = {
  paper: "#F6F2E8",
  paperDim: "#EDE7D6",
  card: "#FCFAF3",
  line: "#D9D0B8",
  lineSoft: "#E7E0CC",
  ink: "#22271F",
  inkSoft: "#6B6656",
  inkFaint: "#9A9480",
  gold: "#9C7A2E",
  goldDim: "#C8AD6C",
  debit: "#8A3B2B",
  debitBg: "#F3E1D8",
  credit: "#2E5F52",
  creditBg: "#DEE9E1",
  plum: "#6E5A96",
};

export const TYPES = [
  { key: "asset", label: "Assets" },
  { key: "liability", label: "Liabilities" },
  { key: "equity", label: "Equity" },
  { key: "income", label: "Income" },
  { key: "isa-income", label: "ISA Income" },
  { key: "expense", label: "Expenses" },
  { key: "investment", label: "Stocks & Shares" },
  { key: "isa-parent", label: "Stocks & Shares ISAs" },
];
// Used only to translate a plain "increase/decrease" entry into formal debit/credit
// for the balance-check hint — never shown to the user, never used for storage or display.
export const CONTRA_TYPES = new Set(["liability", "equity", "income", "isa-income"]);

export const ISA_KINDS = [
  { key: "cash-isa", label: "Cash ISA" },
  { key: "stocks-shares-isa", label: "Stocks & Shares ISA" },
  { key: "lifetime-isa", label: "Lifetime ISA" },
  { key: "innovative-finance-isa", label: "Innovative Finance ISA" },
];

export const GROUP_DIMENSIONS = [
  { key: "type", label: "Type" },
  { key: "institution", label: "Institution" },
  { key: "subtype", label: "Subtype" },
  { key: "currency", label: "Currency" },
];
