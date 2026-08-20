import { ImageResponse } from "next/og";

import { APP_CONFIG } from "@/config/app-config";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Placeholder built from the app's initial. Drop a favicon.ico into src/app/ to
// override this -- favicon.ico takes precedence over icon.tsx.
export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        fontSize: 20,
        background: "black",
        color: "white",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
      }}
    >
      {APP_CONFIG.name.charAt(0).toUpperCase()}
    </div>,
    size,
  );
}
