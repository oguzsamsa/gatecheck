import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'gatecheck',
  description: 'Job postings that are actually open to you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            gatecheck
          </Link>
          <span className="tagline">postings that are actually open to you</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
