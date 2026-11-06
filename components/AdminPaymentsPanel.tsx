"use client";

import { useState } from "react";

type Row = {
  businessId: string;
  name: string;
  planDisplayName: string;
  planCode: string;
  lifecycleStatus: string;
  expectedCents: number;
  receivedCents: number;
  outstandingCents: number;
  status: string;
  paymentRecorded: boolean;
  listPriceCents: number;
};

function formatInr(cents: number): string {
  return `₹${(cents / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export function AdminPaymentsPanel({
  periodKey,
  initialRows,
}: {
  periodKey: string;
  initialRows: Row[];
}) {
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function saveRow(
    businessId: string,
    patch: {
      amountExpectedCents: number;
      amountReceivedCents: number;
      status: string;
    }
  ) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          periodKey,
          ...patch,
        }),
      });
      const data = (await res.json()) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "Could not save payment");
        return;
      }
      setMessage(data.message || "Payment recorded");
      setRows((prev) =>
        prev.map((r) =>
          r.businessId === businessId
            ? {
                ...r,
                expectedCents: patch.amountExpectedCents,
                receivedCents: patch.amountReceivedCents,
                outstandingCents: Math.max(
                  0,
                  patch.amountExpectedCents - patch.amountReceivedCents
                ),
                status: patch.status,
                paymentRecorded: true,
              }
            : r
        )
      );
    } catch {
      setError("Could not save payment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-600">
            <tr>
              <th className="px-3 py-2">Business</th>
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Suggested expected</th>
              <th className="px-3 py-2">Received</th>
              <th className="px-3 py-2">Outstanding</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((row) => (
              <PaymentRow
                key={row.businessId}
                row={row}
                busy={busy}
                onSave={saveRow}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-zinc-600">
                  No businesses enrolled.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">
        Amounts shown in INR. Suggested expected uses the plan catalog for{" "}
        <span className="font-medium">active</span> businesses only when no
        payment row exists; suspended/archived businesses seed ₹0 until a
        ManualPayment is saved. Saved ledger rows always take precedence.
        Marking received without saving a record is not allowed by the API.
      </p>
    </div>
  );
}

function PaymentRow({
  row,
  busy,
  onSave,
}: {
  row: Row;
  busy: boolean;
  onSave: (
    businessId: string,
    patch: {
      amountExpectedCents: number;
      amountReceivedCents: number;
      status: string;
    }
  ) => Promise<void>;
}) {
  const [expected, setExpected] = useState(String(row.expectedCents / 100));
  const [received, setReceived] = useState(String(row.receivedCents / 100));
  const [status, setStatus] = useState(row.status);

  return (
    <tr>
      <td className="px-3 py-2 font-medium text-zinc-900">
        <div>{row.name}</div>
        <div className="text-xs font-normal capitalize text-zinc-500">
          {row.lifecycleStatus}
          {!row.paymentRecorded ? " · suggested until saved" : " · recorded"}
        </div>
      </td>
      <td className="px-3 py-2 text-zinc-700">{row.planDisplayName}</td>
      <td className="px-3 py-2">
        <input
          className="w-24 rounded border border-zinc-300 px-2 py-1"
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          aria-label={`Suggested expected for ${row.name}`}
          data-testid={`expected-input-${row.businessId}`}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className="w-24 rounded border border-zinc-300 px-2 py-1"
          value={received}
          onChange={(e) => setReceived(e.target.value)}
          aria-label={`Received for ${row.name}`}
        />
      </td>
      <td className="px-3 py-2 tabular-nums text-zinc-800">
        {formatInr(row.outstandingCents)}
        {!row.paymentRecorded ? (
          <span className="ml-1 text-xs text-amber-800">(not recorded)</span>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <select
          className="rounded border border-zinc-300 px-2 py-1"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="not_recorded">Not recorded</option>
          <option value="expected">Expected</option>
          <option value="received">Received</option>
          <option value="overdue">Overdue</option>
          <option value="waived">Waived</option>
        </select>
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          disabled={busy}
          className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          onClick={() =>
            void onSave(row.businessId, {
              amountExpectedCents: Math.round(
                (Number(expected) || 0) * 100
              ),
              amountReceivedCents: Math.round(
                (Number(received) || 0) * 100
              ),
              status,
            })
          }
        >
          Save
        </button>
      </td>
    </tr>
  );
}
