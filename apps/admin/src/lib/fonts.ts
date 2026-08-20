import { Geist, Geist_Mono } from "next/font/google";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

/** Applied to <body>; `--font-sans` / `--font-mono` in globals.css point at these. */
export const fontVars = `${geist.variable} ${geistMono.variable}`;
