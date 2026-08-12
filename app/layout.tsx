import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bridger",
  description: "A traced record between two builders' AI sessions.",
  // The page can display a partner's private integration record. It has no
  // business in a search index, and a link pasted anywhere should not preview
  // its contents.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
