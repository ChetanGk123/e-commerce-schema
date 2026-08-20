import type { MetadataRoute } from "next";

// The landing page at / is public; everything behind the dashboard shell is not.
// Tighten or loosen this as you add public routes.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard/", "/unauthorized", "/api/"],
    },
  };
}
