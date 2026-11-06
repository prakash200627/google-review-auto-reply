"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type SearchableOption = { id: string; label: string };

export function filterSearchableOptions(
  options: SearchableOption[],
  query: string
): SearchableOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.label.toLowerCase().includes(q));
}

/**
 * Compact searchable single-select. Keeps long location/business lists out of
 * the main filter row.
 */
export function SearchableSelect({
  label,
  value,
  options,
  onChange,
  placeholder = "Search…",
  emptyLabel = "All",
  selectedLabelFallback = null,
  disabled = false,
}: {
  label: string;
  value: string;
  options: SearchableOption[];
  onChange: (id: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  /** Shown when value is set but missing from options (e.g. outside page cap). */
  selectedLabelFallback?: string | null;
  disabled?: boolean;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = options.find((o) => o.id === value);
  const filtered = useMemo(
    () => filterSearchableOptions(options, query),
    [options, query]
  );

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <span className="sr-only">{label}</span>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 truncate rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
      >
        <span className="truncate">
          {selected?.label ||
            (value && selectedLabelFallback ? selectedLabelFallback : null) ||
            emptyLabel}
        </span>
        <span className="shrink-0 text-zinc-400" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[16rem] max-w-[min(100vw-2rem,24rem)] rounded-md border border-zinc-200 bg-white shadow-lg">
          <div className="border-b border-zinc-100 p-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
              aria-label={`Search ${label}`}
              autoFocus
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            className="max-h-56 overflow-y-auto py-1 text-sm"
          >
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!value}
                className={`block w-full px-3 py-1.5 text-left hover:bg-zinc-50 ${
                  !value ? "bg-zinc-50 font-medium" : ""
                }`}
                onClick={() => pick("")}
              >
                {emptyLabel}
              </button>
            </li>
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-zinc-500">No matches</li>
            ) : (
              filtered.map((opt) => (
                <li key={opt.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === opt.id}
                    className={`block w-full truncate px-3 py-1.5 text-left hover:bg-zinc-50 ${
                      value === opt.id ? "bg-zinc-50 font-medium" : ""
                    }`}
                    onClick={() => pick(opt.id)}
                  >
                    {opt.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
