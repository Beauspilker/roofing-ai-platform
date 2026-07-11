import Link from "next/link";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-2xl text-center">
        <p className="text-sm uppercase tracking-[0.2em] text-blue-400">
          Dashboard
        </p>
        <h1 className="mt-4 text-5xl font-bold">You&apos;re signed in</h1>
        <p className="mt-6 text-xl text-gray-400">
          Signed in as{" "}
          <span className="text-white">{user.email ?? "your account"}</span>
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <SignOutButton />
          <Link
            href="/"
            className="rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold transition hover:bg-blue-700"
          >
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
