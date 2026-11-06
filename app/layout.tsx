import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthNavProvider } from "@/components/auth/AuthNavProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TRONX Review Auto-Reply",
  description:
    "Google Business Profile review management and AI-assisted reply drafts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen antialiased`}
      >
        <AuthNavProvider>{children}</AuthNavProvider>
      </body>
    </html>
  );
}
