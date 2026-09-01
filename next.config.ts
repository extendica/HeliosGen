import path from "node:path";
import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || "heliosgen-assets";
const supabaseImages = supabaseUrl ? [{
  protocol: "https" as const,
  hostname: new URL(supabaseUrl).hostname,
  port: "",
  pathname: `/storage/v1/object/public/${encodeURIComponent(storageBucket)}/**`,
  search: "",
}] : [];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.64.2"],
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    proxyClientMaxBodySize: '30mb',
  },
  serverExternalPackages: ["undici"],
  images: {
    remotePatterns: [
      ...supabaseImages,
      { protocol: "https", hostname: "*.r2.dev" },
      { protocol: "https", hostname: "**.r2.dev" },
      { protocol: "https", hostname: "*.replicate.delivery" },
      { protocol: "https", hostname: "pbxt.replicate.delivery" },
      { protocol: "https", hostname: "*.replicate.com" },
      { protocol: "https", hostname: "*.aiquickdraw.com" },
    ],
  },
};

export default nextConfig;
