/**
 * Renders CSV blob as Excel-style table — exact download content
 */

import { useEffect, useState } from "react";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (ch === "\r") i += 1;
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

export function CsvDocumentRenderer({ blob, onDocumentLoad }) {
  const [rows, setRows] = useState([]);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!blob) {
      setRows([]);
      return undefined;
    }

    let cancelled = false;
    blob
      .text()
      .then((text) => {
        if (cancelled) return;
        setRaw(text);
        setRows(parseCsv(text));
        onDocumentLoad?.({ pageCount: 1, format: "csv" });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [blob, onDocumentLoad]);

  if (error) {
    return <p className="p-8 text-center text-sm text-red-400">{error}</p>;
  }

  if (!raw) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[#64748b]">
        Loading CSV preview…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center py-8">
      <span className="mb-4 font-mono-metrics text-[11px] uppercase tracking-widest text-[#64748b]">
        Spreadsheet Preview
      </span>
      <div className="document-page-sheet overflow-auto bg-white shadow-2xl" style={{ maxWidth: "95%" }}>
        <table className="csv-preview-table w-full border-collapse text-left text-[13px] text-[#1e293b]">
          <tbody>
            {rows.map((row, ri) => (
              <tr
                key={ri}
                className={
                  ri === 0 ? "bg-[#f1f5f9] font-semibold" : ri % 2 === 0 ? "bg-white" : "bg-[#fafafa]"
                }
              >
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="whitespace-pre-wrap border border-[#e2e8f0] px-3 py-1.5 font-[Calibri,Arial,sans-serif]"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
