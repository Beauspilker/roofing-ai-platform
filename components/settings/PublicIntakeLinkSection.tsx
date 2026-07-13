"use client";

import { useState } from "react";
import { getPublicIntakePath } from "@/lib/intake";

type PublicIntakeLinkSectionProps = {
  companyId: string;
  aiPhoneEnabled: boolean;
};

export function PublicIntakeLinkSection({
  companyId,
  aiPhoneEnabled,
}: PublicIntakeLinkSectionProps) {
  const [copied, setCopied] = useState(false);
  const intakePath = getPublicIntakePath(companyId);

  async function handleCopyLink() {
    const fullUrl = `${window.location.origin}${intakePath}`;

    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="space-y-5 border-t border-gray-800 pt-8">
      <div>
        <h2 className="text-xl font-semibold text-white">
          Public intake link
        </h2>
        <p className="mt-1 text-sm text-gray-400">
          Share this link on your website so customers can submit roofing
          requests through the scripted intake assistant.
        </p>
      </div>

      <div className="rounded-xl border border-gray-800 bg-black/40 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">
          Intake URL
        </p>
        <p className="mt-2 break-all text-sm text-blue-300">{intakePath}</p>
        <p className="mt-3 text-xs text-gray-500">
          Company ID (from{" "}
          <span className="font-mono text-gray-400">public.companies.id</span>):{" "}
          <span className="font-mono text-gray-400">{companyId}</span>
        </p>
        <p className="mt-2 text-xs text-gray-500">
          Use Copy Link for the full website URL including your domain.
        </p>
        <button
          type="button"
          onClick={handleCopyLink}
          className="mt-4 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold transition hover:bg-blue-700"
        >
          {copied ? "Copied!" : "Copy Link"}
        </button>
      </div>

      <div className="rounded-xl border border-gray-800 bg-black/40 p-4 text-sm">
        <p className="text-gray-400">AI answering / intake enabled</p>
        <p className="mt-1 font-semibold text-white">
          {aiPhoneEnabled ? "Enabled" : "Disabled"}
        </p>
        {!aiPhoneEnabled ? (
          <p className="mt-3 rounded-xl border border-yellow-900/50 bg-yellow-950/30 px-4 py-3 text-yellow-100">
            AI answering is disabled in automation preferences. The public
            intake page remains available for testing and manual sharing.
          </p>
        ) : null}
      </div>
    </section>
  );
}
