// No server SDK imports: these helpers are also used by Edge proxy routes.
export function usesSupabaseStorage(): boolean {
  return process.env.STORAGE_PROVIDER === "supabase";
}

export function storageBucket(): string {
  return process.env.SUPABASE_STORAGE_BUCKET || "heliosgen-assets";
}

export function supabaseStorageBase(): string {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  return projectUrl
    ? `${projectUrl}/storage/v1/object/public/${encodeURIComponent(storageBucket())}`
    : "";
}

export function isUrlWithinBase(value: string, base: string): boolean {
  if (!base) return false;
  try {
    const url = new URL(value);
    const allowed = new URL(base);
    const prefix = `${allowed.pathname.replace(/\/$/, "")}/`;
    return url.protocol === "https:" && !url.username && !url.password &&
      url.origin === allowed.origin && url.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

export function isStoredAssetUrl(value: string): boolean {
  // Keep previously stored R2 assets usable after switching providers.
  return [process.env.R2_PUBLIC_URL || "", supabaseStorageBase()]
    .some((base) => isUrlWithinBase(value, base));
}
