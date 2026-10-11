import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Barilga ERP',
  description: 'Construction ERP & e-commerce for Mongolia',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="mn">
      <body>{children}</body>
    </html>
  );
}
