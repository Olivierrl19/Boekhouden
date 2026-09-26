import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Boekhouding",
  description: "Boekhouding voor het dispuut",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="nl" className="h-full">
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
