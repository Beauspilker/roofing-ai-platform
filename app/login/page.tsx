import { Suspense } from "react";
import { AuthCard } from "@/components/auth/AuthCard";
import { LoginForm } from "@/components/auth/LoginForm";

export default function LoginPage() {
  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to access your Roofing AI dashboard."
    >
      <Suspense fallback={<p className="text-center text-gray-400">Loading...</p>}>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
