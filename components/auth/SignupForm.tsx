"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthField } from "@/components/auth/AuthField";
import { supabase } from "@/lib/supabase";

export function SignupForm() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    if (data.session) {
      router.push("/dashboard");
      router.refresh();
      return;
    }

    setMessage(
      "Check your email for a confirmation link to finish creating your account.",
    );
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <AuthField
        id="email"
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />

      <AuthField
        id="password"
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />

      <AuthField
        id="confirm-password"
        label="Confirm password"
        type="password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        autoComplete="new-password"
      />

      {error ? (
        <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {message ? (
        <p className="rounded-xl border border-blue-900/50 bg-blue-950/50 px-4 py-3 text-sm text-blue-200">
          {message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Creating account..." : "Create account"}
      </button>

      <p className="text-center text-sm text-gray-400">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-blue-400 transition hover:text-blue-300"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
