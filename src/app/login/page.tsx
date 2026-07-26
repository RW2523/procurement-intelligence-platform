/**
 * Procurement has no login form of its own. Identity comes from the shared
 * AJACE session issued by the timesheet app, so this page just points there.
 */
export default function LoginPage() {
  const loginUrl = process.env.NEXT_PUBLIC_LOGIN_URL || "/";
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border p-6 text-center">
        <h1 className="text-lg font-semibold">Procurement Intelligence</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Sign in with your AJACE account to continue.
        </p>
        <a
          href={loginUrl}
          className="mt-5 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
        >
          Go to sign in
        </a>
        <p className="mt-4 text-xs text-neutral-500">
          Already signed in but seeing this? Your account may not have Procurement
          access yet — ask an administrator.
        </p>
      </div>
    </div>
  );
}
