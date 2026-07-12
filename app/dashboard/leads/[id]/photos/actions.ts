"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createActivity } from "@/lib/activity";
import { getCompanyByUserId } from "@/lib/companies";
import { formatSupabaseError, getLeadByIdForCompany } from "@/lib/leads";
import {
  buildCustomerPhotoStoragePath,
  createCustomerPhotoRecord,
  CUSTOMER_PHOTOS_BUCKET,
  deleteCustomerPhotoRecord,
  getPhotoExtension,
  validateCustomerPhotoFile,
} from "@/lib/photos";
import { createClient } from "@/lib/supabase/server";

export type UploadCustomerPhotoState = {
  error: string | null;
};

export type RemoveCustomerPhotoState = {
  error: string | null;
};

export async function uploadCustomerPhoto(
  _prevState: UploadCustomerPhotoState,
  formData: FormData,
): Promise<UploadCustomerPhotoState> {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const caption = formData.get("caption")?.toString() ?? "";
  const file = formData.get("photo");

  if (!leadId) {
    return { error: "Lead ID is missing." };
  }

  if (!(file instanceof File)) {
    return { error: "Please choose an image file to upload." };
  }

  const validationError = validateCustomerPhotoFile(file);
  if (validationError) {
    return { error: validationError };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/dashboard/leads/${leadId}`);
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const lead = await getLeadByIdForCompany(supabase, leadId, company.id);
  if (!lead) {
    return { error: "Lead not found or you do not have access to it." };
  }

  const extension = getPhotoExtension(file.name, file.type);
  const generatedFileName = `${randomUUID()}.${extension}`;
  const storagePath = buildCustomerPhotoStoragePath(
    company.id,
    leadId,
    generatedFileName,
  );

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || `image/${extension === "jpg" ? "jpeg" : extension}`;

  const { error: uploadError } = await supabase.storage
    .from(CUSTOMER_PHOTOS_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    return { error: formatSupabaseError(uploadError) };
  }

  try {
    await createCustomerPhotoRecord(supabase, {
      companyId: company.id,
      leadId,
      storagePath,
      fileName: file.name,
      mimeType,
      caption,
      uploadedByUserId: user.id,
    });
  } catch (error) {
    await supabase.storage.from(CUSTOMER_PHOTOS_BUCKET).remove([storagePath]);

    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return {
        error: formatSupabaseError(
          error as {
            message: string;
            details?: string | null;
            hint?: string | null;
          },
        ),
      };
    }

    return { error: "Photo upload failed while saving the database record." };
  }

  try {
    await createActivity(supabase, {
      companyId: company.id,
      leadId,
      activityType: "photo_uploaded",
      summary: "Photo uploaded",
      actorUserId: user.id,
      metadata: {
        storage_path: storagePath,
        file_name: file.name,
      },
    });
  } catch {
    // Photo upload succeeds even if activity logging fails.
  }

  revalidatePath(`/dashboard/leads/${leadId}`);

  return { error: null };
}

export async function removeCustomerPhoto(
  _prevState: RemoveCustomerPhotoState,
  formData: FormData,
): Promise<RemoveCustomerPhotoState> {
  const leadId = formData.get("lead_id")?.toString() ?? "";
  const photoId = formData.get("photo_id")?.toString() ?? "";

  if (!leadId || !photoId) {
    return { error: "Photo details are missing." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/dashboard/leads/${leadId}`);
  }

  const company = await getCompanyByUserId(supabase, user.id);
  if (!company) {
    redirect("/onboarding");
  }

  const lead = await getLeadByIdForCompany(supabase, leadId, company.id);
  if (!lead) {
    return { error: "Lead not found or you do not have access to it." };
  }

  try {
    await deleteCustomerPhotoRecord(supabase, photoId, company.id);
  } catch (error) {
    if (error instanceof Error) {
      return { error: error.message };
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return {
        error: formatSupabaseError(
          error as {
            message: string;
            details?: string | null;
            hint?: string | null;
          },
        ),
      };
    }

    return { error: "Failed to remove photo." };
  }

  revalidatePath(`/dashboard/leads/${leadId}`);

  return { error: null };
}
