import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4">
      <div className="max-w-lg text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          TRONX
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-900">
          Review Auto-Reply
        </h1>
        <p className="mt-3 text-zinc-600">
          Sign in with TRONX email/password. Manage ORM reviews and GMB locations
          in separate workspaces. Publish replies only after explicit
          confirmation — nothing publishes automatically.
        </p>
        <Link
          href="/login"
          className="mt-8 inline-flex rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
