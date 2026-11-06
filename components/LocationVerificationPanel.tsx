"use client";

import { useCallback, useRef, useState, useTransition } from "react";

/** Browser-safe high-entropy key for one verification-start attempt. */
function newVerificationIdempotencyKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

type VerificationSnapshot = {
  locationId: string;
  businessInfoName: string;
  verificationStatus: string;
  verificationLastCheckedAt: string | null;
  verificationHasVoiceOfMerchant: boolean | null;
  verificationHasBusinessAuthority: boolean | null;
  verificationRecommendedAction: string;
  latestVerificationName: string;
  latestVerificationMethod: string;
  latestVerificationState: string;
  verificationLastError: string;
  note?: string;
  publicVisibilityClaim?: boolean;
};

type SafeOption = {
  verificationMethod: string;
  phoneNumber?: string;
  addressData?: {
    business?: string;
    address?: {
      addressLines?: string[];
      locality?: string;
      administrativeArea?: string;
      postalCode?: string;
      regionCode?: string;
    };
    expectedDeliveryDaysRegion?: number;
  };
  emailData?: {
    domain?: string;
    user?: string;
    isUserNameEditable?: boolean;
  };
  announcement?: string;
};

function formatOptionLabel(opt: SafeOption): string {
  const method = opt.verificationMethod;
  if (opt.phoneNumber) return `${method} → ${opt.phoneNumber}`;
  if (opt.emailData) {
    return `${method} → ${opt.emailData.user || "?"}@${opt.emailData.domain || "?"}`;
  }
  if (opt.addressData?.address) {
    const a = opt.addressData.address;
    const parts = [
      ...(a.addressLines || []),
      a.locality,
      a.administrativeArea,
      a.postalCode,
      a.regionCode,
    ].filter(Boolean);
    return `${method} → ${parts.join(", ") || "postcard address"}`;
  }
  if (opt.announcement) return `${method} → ${opt.announcement}`;
  return method;
}

export function LocationVerificationPanel({
  locationId,
  initial,
}: {
  locationId: string;
  initial: VerificationSnapshot;
}) {
  const [status, setStatus] = useState(initial);
  const [options, setOptions] = useState<SafeOption[]>([]);
  const [optionsMessage, setOptionsMessage] = useState<string | null>(null);
  const [languageCode, setLanguageCode] = useState("en");
  const [selectedMethod, setSelectedMethod] = useState("");
  const [mailerContact, setMailerContact] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [tokenString, setTokenString] = useState("");
  const [pin, setPin] = useState("");
  const [reviewStart, setReviewStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  /** Stable across retries of the same start attempt; not regenerated on failure. */
  const startIdempotencyKeyRef = useRef<string | null>(null);
  const startLockRef = useRef(false);

  const base = `/api/admin/google/locations/${encodeURIComponent(locationId)}/verification`;

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        await fn();
      } catch {
        setError("Network error talking to TRONX verification APIs.");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  function refreshStatus() {
    startTransition(() => {
      void run(async () => {
        const res = await fetch(base, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = (await res.json()) as {
          success?: boolean;
          message?: string;
          verification?: VerificationSnapshot;
        };
        if (!res.ok || !data.success || !data.verification) {
          setError(data.message || "Refresh failed.");
          return;
        }
        setStatus(data.verification);
        setInfo(data.verification.note || "Status refreshed from Google.");
      });
    });
  }

  function loadOptions() {
    startTransition(() => {
      void run(async () => {
        const res = await fetch(`${base}/options`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ languageCode }),
        });
        const data = (await res.json()) as {
          success?: boolean;
          message?: string;
          options?: SafeOption[];
          empty?: boolean;
        };
        if (!res.ok || !data.success) {
          setError(data.message || "Could not load verification methods.");
          setOptions([]);
          return;
        }
        setOptions(data.options || []);
        setOptionsMessage(
          data.empty
            ? data.message ||
                "Google returned no verification methods for this location."
            : null
        );
        setSelectedMethod("");
        setReviewStart(false);
        if (data.options?.length === 1) {
          setSelectedMethod(data.options[0].verificationMethod);
          prefillFromOption(data.options[0]);
        }
      });
    });
  }

  function prefillFromOption(opt: SafeOption) {
    if (opt.phoneNumber) setPhoneNumber(opt.phoneNumber);
    if (opt.emailData) {
      setEmailAddress(
        `${opt.emailData.user || ""}@${opt.emailData.domain || ""}`
      );
    }
  }

  function confirmStart() {
    if (!selectedMethod || !reviewStart) return;
    if (busy || pending || startLockRef.current) return;
    startLockRef.current = true;
    if (!startIdempotencyKeyRef.current) {
      startIdempotencyKeyRef.current = newVerificationIdempotencyKey();
    }
    const idempotencyKey = startIdempotencyKeyRef.current;
    startTransition(() => {
      void run(async () => {
        try {
          const res = await fetch(`${base}/start`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              confirmStart: true,
              method: selectedMethod,
              languageCode,
              mailerContact: mailerContact || undefined,
              emailAddress: emailAddress || undefined,
              phoneNumber: phoneNumber || undefined,
              tokenString: tokenString || undefined,
              idempotencyKey,
            }),
          });
          const data = (await res.json()) as {
            success?: boolean;
            message?: string;
            note?: string;
            code?: string;
            status?: VerificationSnapshot;
            reusedIdempotentResult?: boolean;
          };
          if (!res.ok || !data.success) {
            // Keep the same key after recoverable failures.
            setError(data.message || "Start verification failed.");
            return;
          }
          if (data.status) setStatus(data.status);
          setInfo(
            data.reusedIdempotentResult
              ? "Returned the prior verification-start result for this attempt (idempotent replay)."
              : data.note || "Verification started."
          );
          setReviewStart(false);
          startIdempotencyKeyRef.current = null;
        } finally {
          startLockRef.current = false;
        }
      });
    });
  }

  function completeWithPin() {
    startTransition(() => {
      void run(async () => {
        const res = await fetch(`${base}/complete`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmComplete: true,
            pin,
            verificationName: status.latestVerificationName || undefined,
          }),
        });
        const data = (await res.json()) as {
          success?: boolean;
          message?: string;
          note?: string;
          status?: VerificationSnapshot;
        };
        if (!res.ok || !data.success) {
          setError(data.message || "Complete verification failed.");
          return;
        }
        if (data.status) setStatus(data.status);
        setInfo(data.note || "PIN submitted.");
        setPin("");
      });
    });
  }

  const selected = options.find((o) => o.verificationMethod === selectedMethod);

  return (
    <section className="mb-6 space-y-4 rounded-lg border border-zinc-200 bg-white p-5">
      <div>
        <h3 className="text-base font-medium text-zinc-900">
          Google verification
        </h3>
        <p className="mt-1 text-sm text-zinc-600">
          Super Admin only. Status comes from Google Voice of Merchant and
          verification history — never from location creation alone. Voice of
          Merchant is not a claim that the listing is publicly visible.
        </p>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-zinc-500">Status</dt>
          <dd className="font-medium text-zinc-900">
            {status.verificationStatus}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Last checked</dt>
          <dd className="text-zinc-800">
            {status.verificationLastCheckedAt
              ? new Date(status.verificationLastCheckedAt).toLocaleString()
              : "Never"}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">hasVoiceOfMerchant</dt>
          <dd className="font-mono text-xs text-zinc-800">
            {status.verificationHasVoiceOfMerchant === null
              ? "n/a"
              : String(status.verificationHasVoiceOfMerchant)}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Recommended action</dt>
          <dd className="text-zinc-800">
            {status.verificationRecommendedAction || "—"}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-zinc-500">Latest verification</dt>
          <dd className="break-all font-mono text-xs text-zinc-700">
            {status.latestVerificationName || "—"}
            {status.latestVerificationMethod
              ? ` · ${status.latestVerificationMethod}`
              : ""}
            {status.latestVerificationState
              ? ` · ${status.latestVerificationState}`
              : ""}
          </dd>
        </div>
      </dl>

      {status.verificationLastError && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Partial refresh note: {status.verificationLastError}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50"
          disabled={busy || pending}
          onClick={refreshStatus}
        >
          Refresh status from Google
        </button>
      </div>

      <div className="space-y-3 border-t border-zinc-100 pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="text-zinc-700">Language for options</span>
            <input
              className="mt-1 block w-28 rounded-md border border-zinc-300 px-2 py-1.5"
              value={languageCode}
              onChange={(e) => setLanguageCode(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50"
            disabled={busy || pending}
            onClick={loadOptions}
          >
            Fetch verification methods
          </button>
        </div>

        {optionsMessage && (
          <p className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
            {optionsMessage}
          </p>
        )}

        {options.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-zinc-800">
              Methods returned by Google
            </legend>
            {options.map((opt) => (
              <label
                key={`${opt.verificationMethod}-${opt.phoneNumber || opt.announcement || opt.emailData?.user || ""}`}
                className="flex cursor-pointer items-start gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="verification-method"
                  className="mt-1"
                  checked={selectedMethod === opt.verificationMethod}
                  onChange={() => {
                    setSelectedMethod(opt.verificationMethod);
                    prefillFromOption(opt);
                    setReviewStart(false);
                  }}
                />
                <span>{formatOptionLabel(opt)}</span>
              </label>
            ))}
          </fieldset>
        )}

        {selectedMethod && (
          <div className="space-y-2 rounded-md bg-zinc-50 p-3 text-sm">
            {(selectedMethod === "ADDRESS") && (
              <label className="block">
                <span className="text-zinc-700">Postcard contact name</span>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5"
                  value={mailerContact}
                  onChange={(e) => setMailerContact(e.target.value)}
                  placeholder="Mailer contact"
                />
              </label>
            )}
            {(selectedMethod === "EMAIL") && (
              <label className="block">
                <span className="text-zinc-700">Email address</span>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5"
                  value={emailAddress}
                  onChange={(e) => setEmailAddress(e.target.value)}
                />
              </label>
            )}
            {(selectedMethod === "PHONE_CALL" || selectedMethod === "SMS") && (
              <label className="block">
                <span className="text-zinc-700">Phone number</span>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                />
              </label>
            )}
            {selectedMethod === "VETTED_PARTNER" && (
              <label className="block">
                <span className="text-zinc-700">Partner token (if required)</span>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5"
                  value={tokenString}
                  onChange={(e) => setTokenString(e.target.value)}
                />
              </label>
            )}

            {!reviewStart ? (
              <button
                type="button"
                className="rounded-md bg-zinc-900 px-3 py-2 text-white disabled:opacity-50"
                disabled={busy || pending}
                onClick={() => {
                  startIdempotencyKeyRef.current =
                    newVerificationIdempotencyKey();
                  setReviewStart(true);
                }}
              >
                Review before starting verification
              </button>
            ) : (
              <div className="space-y-2">
                <pre className="overflow-x-auto rounded bg-white p-2 text-xs">
                  {JSON.stringify(
                    {
                      method: selectedMethod,
                      languageCode,
                      mailerContact: mailerContact || undefined,
                      emailAddress: emailAddress || undefined,
                      phoneNumber: phoneNumber || undefined,
                      tokenString: tokenString ? "(provided)" : undefined,
                      optionPreview: selected
                        ? formatOptionLabel(selected)
                        : undefined,
                    },
                    null,
                    2
                  )}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-zinc-300 px-3 py-2"
                    disabled={busy || pending}
                    onClick={() => setReviewStart(false)}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-zinc-900 px-3 py-2 text-white disabled:opacity-50"
                    disabled={busy || pending}
                    onClick={confirmStart}
                  >
                    Confirm start on Google
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-zinc-100 pt-4">
        <h4 className="text-sm font-medium text-zinc-800">
          Complete pending verification (PIN)
        </h4>
        <p className="text-xs text-zinc-500">
          Required for non-AUTO methods after Google delivers a PIN. AUTO may
          complete immediately without a PIN.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-sm">
            <span className="text-zinc-700">PIN</span>
            <input
              className="mt-1 block w-40 rounded-md border border-zinc-300 px-2 py-1.5"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoComplete="one-time-code"
            />
          </label>
          <button
            type="button"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50"
            disabled={busy || pending || !pin.trim()}
            onClick={completeWithPin}
          >
            Submit PIN to Google
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {info && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {info}
        </p>
      )}
    </section>
  );
}
