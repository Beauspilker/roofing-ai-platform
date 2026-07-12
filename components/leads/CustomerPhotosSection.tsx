"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  removeCustomerPhoto,
  uploadCustomerPhoto,
  type RemoveCustomerPhotoState,
  type UploadCustomerPhotoState,
} from "@/app/dashboard/leads/[id]/photos/actions";
import {
  ALLOWED_IMAGE_EXTENSIONS,
  formatPhotoUploadedDate,
  type CustomerPhotoWithUrl,
} from "@/lib/photos";

const uploadInitialState: UploadCustomerPhotoState = { error: null };
const removeInitialState: RemoveCustomerPhotoState = { error: null };

type CustomerPhotosSectionProps = {
  leadId: string;
  photos: CustomerPhotoWithUrl[];
  canUpload: boolean;
};

export function CustomerPhotosSection({
  leadId,
  photos,
  canUpload,
}: CustomerPhotosSectionProps) {
  const router = useRouter();
  const uploadFormRef = useRef<HTMLFormElement>(null);
  const uploadWasPending = useRef(false);
  const removeWasPending = useRef(false);
  const [selectedPhoto, setSelectedPhoto] = useState<CustomerPhotoWithUrl | null>(
    null,
  );
  const [uploadState, uploadAction, uploadPending] = useActionState(
    uploadCustomerPhoto,
    uploadInitialState,
  );
  const [removeState, removeAction, removePending] = useActionState(
    removeCustomerPhoto,
    removeInitialState,
  );

  useEffect(() => {
    if (uploadWasPending.current && !uploadPending && !uploadState.error) {
      uploadFormRef.current?.reset();
      router.refresh();
    }

    uploadWasPending.current = uploadPending;
  }, [router, uploadPending, uploadState.error]);

  useEffect(() => {
    if (removeWasPending.current && !removePending && !removeState.error) {
      setSelectedPhoto(null);
      router.refresh();
    }

    removeWasPending.current = removePending;
  }, [removePending, removeState.error, router]);

  const acceptTypes = ALLOWED_IMAGE_EXTENSIONS.join(",");

  return (
    <section className="mt-10 space-y-6 border-t border-gray-800 pt-8">
      <div>
        <h2 className="text-xl font-semibold text-white">Customer Photos</h2>
        <p className="mt-1 text-sm text-gray-400">
          Upload roof and property photos for this lead.
        </p>
      </div>

      {canUpload ? (
        <form
          ref={uploadFormRef}
          action={uploadAction}
          className="space-y-4 rounded-xl border border-gray-800 bg-black/40 p-4"
        >
          <input type="hidden" name="lead_id" value={leadId} />

          <div>
            <label
              htmlFor="photo"
              className="block text-sm font-medium text-gray-300"
            >
              Upload photo
            </label>
            <input
              id="photo"
              name="photo"
              type="file"
              accept={acceptTypes}
              required
              className="mt-2 block w-full text-sm text-gray-300 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-blue-700"
            />
            <p className="mt-2 text-xs text-gray-500">
              JPG, JPEG, PNG, or WEBP up to 5 MB.
            </p>
          </div>

          <div>
            <label
              htmlFor="caption"
              className="block text-sm font-medium text-gray-300"
            >
              Caption
              <span className="ml-1 font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id="caption"
              name="caption"
              type="text"
              placeholder="Describe this photo..."
              className="mt-2 w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none transition placeholder:text-gray-500 focus:border-blue-600"
            />
          </div>

          {uploadState.error ? (
            <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
              {uploadState.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={uploadPending}
            className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploadPending ? "Uploading..." : "Upload Photo"}
          </button>
        </form>
      ) : null}

      {removeState.error ? (
        <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {removeState.error}
        </p>
      ) : null}

      {photos.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-800 bg-black/40 px-4 py-8 text-center text-sm text-gray-500">
          No photos uploaded yet.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {photos.map((photo) => (
            <article
              key={photo.id}
              className="overflow-hidden rounded-xl border border-gray-800 bg-black/40"
            >
              <button
                type="button"
                onClick={() => setSelectedPhoto(photo)}
                className="block w-full text-left"
              >
                <div className="relative aspect-[4/3] bg-gray-950">
                  {photo.signedUrl ? (
                    <Image
                      src={photo.signedUrl}
                      alt={photo.caption || photo.file_name || "Customer photo"}
                      fill
                      unoptimized
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500">
                      Preview unavailable
                    </div>
                  )}
                </div>
              </button>

              <div className="space-y-3 p-4">
                <p className="text-xs text-gray-500">
                  Uploaded {formatPhotoUploadedDate(photo.created_at)}
                </p>
                {photo.caption ? (
                  <p className="text-sm text-gray-300">{photo.caption}</p>
                ) : null}

                {canUpload ? (
                  <form action={removeAction}>
                    <input type="hidden" name="lead_id" value={leadId} />
                    <input type="hidden" name="photo_id" value={photo.id} />
                    <button
                      type="submit"
                      disabled={removePending}
                      onClick={(event) => {
                        const confirmed = window.confirm(
                          "Remove this photo? This will delete the image from storage.",
                        );

                        if (!confirmed) {
                          event.preventDefault();
                        }
                      }}
                      className="rounded-xl border border-red-900/50 bg-red-950/40 px-4 py-2 text-sm font-semibold text-red-200 transition hover:border-red-800 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Remove Photo
                    </button>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {selectedPhoto ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setSelectedPhoto(null)}
        >
          <div
            className="relative max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-xl border border-gray-800 bg-gray-950"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setSelectedPhoto(null)}
              className="absolute right-4 top-4 z-10 rounded-xl border border-gray-700 bg-black/80 px-3 py-2 text-sm text-gray-200"
            >
              Close
            </button>

            <div className="relative h-[70vh] w-full bg-black">
              {selectedPhoto.signedUrl ? (
                <Image
                  src={selectedPhoto.signedUrl}
                  alt={
                    selectedPhoto.caption ||
                    selectedPhoto.file_name ||
                    "Customer photo preview"
                  }
                  fill
                  unoptimized
                  className="object-contain"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-gray-500">
                  Preview unavailable
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-gray-800 p-4">
              <p className="text-sm text-gray-400">
                Uploaded {formatPhotoUploadedDate(selectedPhoto.created_at)}
              </p>
              {selectedPhoto.caption ? (
                <p className="text-sm text-white">{selectedPhoto.caption}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
