# Supabase Storage

The application can use Supabase Storage instead of Cloudflare R2 without
changing saved workflow fields or upload API response formats.

1. Create a public Supabase Storage bucket named `heliosgen-assets`.
2. Set `STORAGE_PROVIDER=supabase` and
   `SUPABASE_STORAGE_BUCKET=heliosgen-assets` on the application service.
3. Keep `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` configured.
   The service-role key is used only on the server; never put it in a public
   environment variable or commit it to the repository.
4. Build and redeploy. The image optimizer allowlist is configured at build time.

New uploads, generated-asset mirroring, thumbnails, video proxies, and downloads
use the configured Supabase bucket. Keep the old R2 variables if existing files
need to remain readable. Existing R2 files are not deleted or bulk-migrated.
Re-uploading the same bytes stores a new copy in Supabase and updates its cache.

Public bucket objects are readable by anyone with the file URL. Do not use this
configuration for confidential assets requiring authenticated downloads.
Supabase Free projects allow at most 50 MB per file, and a bucket can impose a
lower limit. Start with a small PNG/JPG; large production videos may need a
different plan and a resumable upload path.

To switch new uploads back to R2, set `STORAGE_PROVIDER=r2` and redeploy after
correcting the R2 credentials. Previously saved Supabase URLs remain readable.

Run the storage regression tests with:

```sh
node --test tests/storage.test.mjs
```
