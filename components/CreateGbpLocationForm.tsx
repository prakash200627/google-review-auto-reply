"use client";

import Link from "next/link";
import { useEffect, useId, useState, useTransition } from "react";
import {
  CreateLocationValidationError,
  validatePrimaryCategoryName,
  validateStorefrontAddress,
} from "@/lib/google/createLocationValidation";

type GoogleAccountOption = {
  name: string;
  accountName: string;
  type: string;
};

type CreatedLocationResponse = {
  success: boolean;
  code?: string;
  message?: string;
  fieldIssues?: Array<{ field: string; message: string }>;
  googleStatus?: string;
  location?: {
    id: string;
    title: string;
    address: string;
    storeCode: string;
    googleLocationName: string;
    googleAccountName: string;
    businessInfoName: string;
    businessId: string | null;
    placeId: string;
  };
  googleLocationName?: string;
  businessInfoName?: string;
  googleAccountName?: string;
  verificationStatus?: string;
  verificationNote?: string;
  assignmentNote?: string;
  reusedIdempotentResult?: boolean;
};

type FormState = {
  googleAccountName: string;
  title: string;
  languageCode: string;
  storeCode: string;
  websiteUri: string;
  primaryPhone: string;
  primaryCategoryName: string;
  addressLine1: string;
  addressLine2: string;
  locality: string;
  administrativeArea: string;
  postalCode: string;
  regionCode: string;
};

const EMPTY: FormState = {
  googleAccountName: "",
  title: "",
  languageCode: "en",
  storeCode: "",
  websiteUri: "",
  primaryPhone: "",
  primaryCategoryName: "",
  addressLine1: "",
  addressLine2: "",
  locality: "",
  administrativeArea: "",
  postalCode: "",
  regionCode: "",
};

function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`.slice(
    0,
    50
  );
}

export function CreateGbpLocationForm() {
  const formId = useId();
  const [accounts, setAccounts] = useState<GoogleAccountOption[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [step, setStep] = useState<"edit" | "review" | "done">("edit");
  const [requestId, setRequestId] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = useState<
    Array<{ field: string; message: string }>
  >([]);
  const [result, setResult] = useState<CreatedLocationResponse | null>(null);
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setAccountsLoading(true);
      setAccountsError(null);
      try {
        const res = await fetch("/api/admin/google/accounts", {
          credentials: "same-origin",
        });
        const data = (await res.json()) as {
          success?: boolean;
          message?: string;
          accounts?: GoogleAccountOption[];
        };
        if (cancelled) return;
        if (!res.ok || !data.success) {
          setAccountsError(
            data.message || "Could not load Google accounts for this workspace."
          );
          setAccounts([]);
          return;
        }
        setAccounts(data.accounts || []);
      } catch {
        if (!cancelled) {
          setAccountsError("Could not load Google accounts.");
          setAccounts([]);
        }
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload(id: string) {
    const addressLines = [form.addressLine1, form.addressLine2]
      .map((l) => l.trim())
      .filter(Boolean);
    const hasAddress =
      addressLines.length > 0 ||
      form.locality.trim() ||
      form.administrativeArea.trim() ||
      form.postalCode.trim() ||
      form.regionCode.trim();

    return {
      requestId: id,
      googleAccountName: form.googleAccountName.trim(),
      title: form.title.trim(),
      languageCode: form.languageCode.trim(),
      storeCode: form.storeCode.trim() || undefined,
      websiteUri: form.websiteUri.trim() || undefined,
      primaryPhone: form.primaryPhone.trim() || undefined,
      primaryCategoryName: form.primaryCategoryName.trim() || undefined,
      storefrontAddress: hasAddress
        ? {
            ...(addressLines.length ? { addressLines } : {}),
            ...(form.locality.trim()
              ? { locality: form.locality.trim() }
              : {}),
            ...(form.administrativeArea.trim()
              ? { administrativeArea: form.administrativeArea.trim() }
              : {}),
            ...(form.postalCode.trim()
              ? { postalCode: form.postalCode.trim() }
              : {}),
            ...(form.regionCode.trim()
              ? { regionCode: form.regionCode.trim().toUpperCase() }
              : {}),
          }
        : undefined,
    };
  }

  function goToReview() {
    setSubmitError(null);
    setFieldIssues([]);
    if (!form.googleAccountName.trim()) {
      setSubmitError("Select a Google account resource before continuing.");
      return;
    }
    if (!form.title.trim()) {
      setSubmitError("Title is required.");
      return;
    }
    if (!form.languageCode.trim()) {
      setSubmitError("Language code is required.");
      return;
    }
    try {
      validatePrimaryCategoryName(form.primaryCategoryName);
      const addressLines = [form.addressLine1, form.addressLine2]
        .map((l) => l.trim())
        .filter(Boolean);
      validateStorefrontAddress({
        addressLines,
        locality: form.locality,
        administrativeArea: form.administrativeArea,
        postalCode: form.postalCode,
        regionCode: form.regionCode,
      });
    } catch (err) {
      if (err instanceof CreateLocationValidationError) {
        setSubmitError(err.message);
        setFieldIssues(err.fieldIssues);
        return;
      }
      setSubmitError("Could not validate the create form.");
      return;
    }
    setRequestId(newRequestId());
    setStep("review");
  }

  const [needsReconcile, setNeedsReconcile] = useState(false);

  function confirmCreate(opts: { reconcileOnly?: boolean } = {}) {
    if (!requestId || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    startTransition(() => {
      void (async () => {
        try {
          const res = await fetch("/api/admin/google/locations", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildPayload(requestId)),
          });
          const data = (await res.json()) as CreatedLocationResponse;
          if (!res.ok || !data.success) {
            setFieldIssues(data.fieldIssues || []);
            if (data.code === "persist_failed_needs_reconcile") {
              setNeedsReconcile(true);
              setSubmitError(
                data.message ||
                  "Google may have created the location. Keep this requestId and retry reconciliation — do not start a new create."
              );
            } else {
              setNeedsReconcile(false);
              setSubmitError(
                data.message ||
                  (opts.reconcileOnly
                    ? "Local reconciliation failed."
                    : "Google location create failed.")
              );
            }
            setSubmitting(false);
            return;
          }
          setNeedsReconcile(false);
          setResult(data);
          setStep("done");
        } catch {
          setSubmitError("Network error while creating the location.");
        } finally {
          setSubmitting(false);
        }
      })();
    });
  }

  if (step === "done" && result?.location) {
    const loc = result.location;
    return (
      <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium text-zinc-900">
          Location created in Google
        </h2>
        <p className="text-sm text-zinc-600">
          Saved locally as unassigned. Verification was not checked.
        </p>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-zinc-500">Title</dt>
            <dd className="font-medium text-zinc-900">{loc.title}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Google location resource</dt>
            <dd className="break-all font-mono text-xs text-zinc-800">
              {loc.googleLocationName}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Business Information name</dt>
            <dd className="break-all font-mono text-xs text-zinc-800">
              {loc.businessInfoName}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Account</dt>
            <dd className="break-all font-mono text-xs text-zinc-800">
              {loc.googleAccountName}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">TRONX location id</dt>
            <dd className="font-mono text-xs text-zinc-800">{loc.id}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Business assignment</dt>
            <dd className="text-zinc-800">
              {loc.businessId || "Unassigned (explicit SA assignment required)"}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Verification status</dt>
            <dd className="text-zinc-800">
              {result.verificationStatus || "unknown"}
              <span className="mt-1 block text-xs text-zinc-500">
                {result.verificationNote ||
                  "Persisted as unknown until a Super Admin refreshes verification on the location page."}
              </span>
            </dd>
          </div>
        </dl>
        {result.reusedIdempotentResult && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Returned a prior successful result for the same requestId (duplicate
            protection).
          </p>
        )}
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="underline" href={`/gmb/locations/${loc.id}`}>
            Open location
          </Link>
          <Link className="underline" href="/admin/businesses">
            Assign to a business
          </Link>
          <Link className="underline" href="/gmb/locations">
            All locations
          </Link>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setForm(EMPTY);
              setResult(null);
              setRequestId("");
              setStep("edit");
            }}
          >
            Create another
          </button>
        </div>
      </div>
    );
  }

  if (step === "review") {
    const payload = buildPayload(requestId);
    return (
      <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-medium text-zinc-900">
          Review before creating on Google
        </h2>
        <p className="text-sm text-zinc-600">
          Confirming will call Google Business Information{" "}
          <code className="text-xs">accounts.locations.create</code>. This does
          not verify the listing or assign it to a TRONX business.
        </p>
        <pre className="overflow-x-auto rounded-md bg-zinc-50 p-3 text-xs text-zinc-800">
          {JSON.stringify(payload, null, 2)}
        </pre>
        {submitError && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
            <p>{submitError}</p>
            {fieldIssues.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                {fieldIssues.map((issue) => (
                  <li key={`${issue.field}:${issue.message}`}>
                    <span className="font-mono">{issue.field}</span>:{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {needsReconcile && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            Google create may have succeeded. Keep requestId{" "}
            <code className="text-xs">{requestId}</code> and reconcile the local
            TRONX location. Do not generate a new requestId (that can create a
            second Google listing).
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
            disabled={submitting || pending}
            onClick={() => {
              setSubmitError(null);
              setNeedsReconcile(false);
              setStep("edit");
            }}
          >
            Back to edit
          </button>
          {needsReconcile ? (
            <button
              type="button"
              className="rounded-md bg-amber-800 px-3 py-2 text-sm text-white disabled:opacity-50"
              disabled={submitting || pending}
              onClick={() => confirmCreate({ reconcileOnly: true })}
            >
              {submitting || pending
                ? "Reconciling local record…"
                : "Retry local save (same requestId)"}
            </button>
          ) : (
            <button
              type="button"
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              disabled={submitting || pending}
              onClick={() => confirmCreate()}
            >
              {submitting || pending
                ? "Creating on Google…"
                : "Confirm create on Google"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form
      id={formId}
      className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5"
      onSubmit={(e) => {
        e.preventDefault();
        goToReview();
      }}
    >
      <h2 className="text-lg font-medium text-zinc-900">
        New Google Business Profile location
      </h2>
      <p className="text-sm text-zinc-600">
        Uses the central TRONX Google connection. Title and languageCode are
        required by Google; address/category/phone are optional here but Google
        may still reject incomplete storefront listings.
      </p>

      {accountsLoading && (
        <p className="text-sm text-zinc-500">Loading Google accounts…</p>
      )}
      {accountsError && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {accountsError}
        </p>
      )}

      <label className="block text-sm">
        <span className="text-zinc-700">Google account (required)</span>
        <select
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
          value={form.googleAccountName}
          onChange={(e) => update("googleAccountName", e.target.value)}
          required
        >
          <option value="">Select accounts/…</option>
          {accounts.map((a) => (
            <option key={a.name} value={a.name}>
              {a.accountName ? `${a.accountName} (${a.name})` : a.name}
              {a.type ? ` · ${a.type}` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm">
        <span className="text-zinc-700">Title (required)</span>
        <input
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
          value={form.title}
          onChange={(e) => update("title", e.target.value)}
          required
          maxLength={200}
        />
      </label>

      <label className="block text-sm">
        <span className="text-zinc-700">Language code (required, immutable)</span>
        <input
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
          value={form.languageCode}
          onChange={(e) => update("languageCode", e.target.value)}
          required
          placeholder="en"
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-zinc-700">Store code</span>
          <input
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
            value={form.storeCode}
            onChange={(e) => update("storeCode", e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="text-zinc-700">Primary phone</span>
          <input
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
            value={form.primaryPhone}
            onChange={(e) => update("primaryPhone", e.target.value)}
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-zinc-700">Website URL</span>
          <input
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
            value={form.websiteUri}
            onChange={(e) => update("websiteUri", e.target.value)}
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-zinc-700">
            Primary category (exact id, e.g. gcid:software_company — no spaces)
          </span>
          <input
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
            value={form.primaryCategoryName}
            onChange={(e) => update("primaryCategoryName", e.target.value)}
            placeholder="gcid:software_company"
            spellCheck={false}
          />
        </label>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-zinc-800">
          Storefront address (optional; if any field is set, region code + street
          line are required)
        </legend>
        <p className="text-xs text-zinc-500">
          Google PostalAddress: locality = city, administrativeArea = state /
          province (not the city). Do not copy the city into state or street
          lines. Example for Hyderabad, IN: street line, locality Hyderabad,
          administrativeArea Telangana, regionCode IN.
        </p>
        <label className="block text-sm">
          <span className="text-zinc-700">Address line 1 (street / building)</span>
          <input
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
            value={form.addressLine1}
            onChange={(e) => update("addressLine1", e.target.value)}
            placeholder="Building / street"
          />
        </label>
        <label className="block text-sm">
          <span className="text-zinc-700">Address line 2</span>
          <input
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
            value={form.addressLine2}
            onChange={(e) => update("addressLine2", e.target.value)}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-zinc-700">City / locality</span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={form.locality}
              onChange={(e) => update("locality", e.target.value)}
              placeholder="Hyderabad"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-700">
              State / administrative area (not city)
            </span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={form.administrativeArea}
              onChange={(e) => update("administrativeArea", e.target.value)}
              placeholder="Telangana"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-700">Postal code</span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={form.postalCode}
              onChange={(e) => update("postalCode", e.target.value)}
              placeholder="500018"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-700">
              Region code (required with address; CLDR, e.g. IN)
            </span>
            <input
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
              value={form.regionCode}
              onChange={(e) => update("regionCode", e.target.value)}
              maxLength={2}
              placeholder="IN"
            />
          </label>
        </div>
      </fieldset>

      {submitError && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          <p>{submitError}</p>
          {fieldIssues.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {fieldIssues.map((issue) => (
                <li key={`${issue.field}:${issue.message}`}>
                  <span className="font-mono">{issue.field}</span>: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="submit"
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white"
        disabled={accountsLoading || Boolean(accountsError)}
      >
        Review before create
      </button>
    </form>
  );
}
