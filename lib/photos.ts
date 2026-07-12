import type { SupabaseClient } from "@supabase/supabase-js";

export const CUSTOMER_PHOTOS_BUCKET = "customer-photos";

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const ALLOWED_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
] as const;

export const MAX_PHOTO_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export type CustomerPhoto = {
  id: string;
  company_id: string;
  lead_id: string;
  storage_path: string;
  file_name: string | null;
  mime_type: string | null;
  caption: string | null;
  photo_type: string;
  uploaded_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomerPhotoWithUrl = CustomerPhoto & {
  signedUrl: string | null;
};

export function formatPhotoUploadedDate(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(createdAt));
}

export function buildCustomerPhotoStoragePath(
  companyId: string,
  leadId: string,
  fileName: string,
): string {
  return `${companyId}/${leadId}/${fileName}`;
}

export function getPhotoExtension(fileName: string, mimeType: string): string {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".png") || mimeType === "image/png") {
    return "png";
  }

  if (lowerName.endsWith(".webp") || mimeType === "image/webp") {
    return "webp";
  }

  return "jpg";
}

export function validateCustomerPhotoFile(file: File): string | null {
  if (!(file instanceof File) || file.size === 0) {
    return "Please choose an image file to upload.";
  }

  if (file.size > MAX_PHOTO_FILE_SIZE_BYTES) {
    return "Image must be 5 MB or smaller.";
  }

  const mimeType = file.type.toLowerCase();
  const lowerName = file.name.toLowerCase();
  const hasAllowedMime = ALLOWED_IMAGE_MIME_TYPES.includes(
    mimeType as (typeof ALLOWED_IMAGE_MIME_TYPES)[number],
  );
  const hasAllowedExtension = ALLOWED_IMAGE_EXTENSIONS.some((extension) =>
    lowerName.endsWith(extension),
  );

  if (!hasAllowedMime && !hasAllowedExtension) {
    return "Only JPG, JPEG, PNG, and WEBP images are allowed.";
  }

  return null;
}

export async function getPhotosByLeadId(
  supabase: SupabaseClient,
  leadId: string,
  companyId: string,
): Promise<CustomerPhoto[]> {
  const { data, error } = await supabase
    .from("customer_photos")
    .select("*")
    .eq("lead_id", leadId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getPhotoByIdForCompany(
  supabase: SupabaseClient,
  photoId: string,
  companyId: string,
): Promise<CustomerPhoto | null> {
  const { data, error } = await supabase
    .from("customer_photos")
    .select("*")
    .eq("id", photoId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function getCustomerPhotosWithSignedUrls(
  supabase: SupabaseClient,
  leadId: string,
  companyId: string,
): Promise<CustomerPhotoWithUrl[]> {
  const photos = await getPhotosByLeadId(supabase, leadId, companyId);

  return Promise.all(
    photos.map(async (photo) => {
      const { data, error } = await supabase.storage
        .from(CUSTOMER_PHOTOS_BUCKET)
        .createSignedUrl(photo.storage_path, 60 * 60);

      if (error) {
        return { ...photo, signedUrl: null };
      }

      return { ...photo, signedUrl: data.signedUrl };
    }),
  );
}

export async function createCustomerPhotoRecord(
  supabase: SupabaseClient,
  {
    companyId,
    leadId,
    storagePath,
    fileName,
    mimeType,
    caption,
    uploadedByUserId,
  }: {
    companyId: string;
    leadId: string;
    storagePath: string;
    fileName: string;
    mimeType: string;
    caption?: string;
    uploadedByUserId?: string | null;
  },
): Promise<CustomerPhoto> {
  const { data, error } = await supabase
    .from("customer_photos")
    .insert({
      company_id: companyId,
      lead_id: leadId,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: mimeType,
      caption: caption?.trim() || null,
      photo_type: "other",
      uploaded_by_user_id: uploadedByUserId ?? null,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Failed to create customer photo record.");
  }

  return data;
}

export async function deleteCustomerPhotoRecord(
  supabase: SupabaseClient,
  photoId: string,
  companyId: string,
): Promise<CustomerPhoto> {
  const photo = await getPhotoByIdForCompany(supabase, photoId, companyId);

  if (!photo) {
    throw new Error("Photo not found or you do not have access to it.");
  }

  const { error: storageError } = await supabase.storage
    .from(CUSTOMER_PHOTOS_BUCKET)
    .remove([photo.storage_path]);

  if (storageError) {
    throw storageError;
  }

  const { error } = await supabase
    .from("customer_photos")
    .delete()
    .eq("id", photoId)
    .eq("company_id", companyId);

  if (error) {
    throw error;
  }

  return photo;
}
