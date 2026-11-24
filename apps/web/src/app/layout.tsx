import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Navbar } from '@/components/Navbar';
import { ToastProvider } from '@/components/Toast';
import { AuthProvider } from '@/components/AuthProvider';

export const metadata: Metadata = {
  title: 'FlashSale - live event tickets',
  description: 'Discover events and book tickets on a distributed, fault-tolerant booking platform.',
};
export const viewport: Viewport = { themeColor: '#0a0f1e', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-lg focus:bg-accent-strong focus:px-4 focus:py-2">Skip to content</a>
        <ToastProvider>
          <AuthProvider>
          <Navbar />
          <main id="main" className="mx-auto max-w-7xl px-4 py-10 sm:px-6">{children}</main>
          <footer className="mx-auto max-w-7xl px-4 pb-10 pt-4 text-sm text-muted sm:px-6">
            FlashSale - System Design assignment: API gateway, Redis token-bucket, PostgreSQL, BullMQ workers, circuit breaker.
          </footer>
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
