import type { MetadataRoute } from "next";

import { env } from "@/lib/env";

// Generated per request, not at build. APP_URL is read at runtime so one image can
// serve every environment, and a statically generated sitemap would bake in whatever
// origin happened to be set on the build machine.
export const dynamic = "force-dynamic";

// Only the landing page is meant to be crawled. robots.ts disallows the dashboard, and
// the auth screens are reachable but not worth indexing. Add entries as you add public
// routes — and keep the two files in agreement.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: env.APP_URL,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
