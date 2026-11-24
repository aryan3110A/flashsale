'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Activity, FlaskConical, Menu, Ticket, X, Zap } from 'lucide-react';

const LINKS = [
  { href: '/', label: 'Discover', icon: Zap },
  { href: '/bookings', label: 'My bookings', icon: Ticket },
  { href: '/dashboard', label: 'System monitor', icon: Activity },
  { href: '/playground', label: 'Playground', icon: FlaskConical },
];

export function Navbar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === '/' ? path === '/' || path.startsWith('/events') : path.startsWith(href));
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/80 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6" aria-label="Main">
        <Link href="/" className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent-strong to-cyan"><Zap className="h-4 w-4 text-white" aria-hidden /></span>
          <span>Flash<span className="text-accent">Sale</span></span>
        </Link>
        <ul className="hidden items-center gap-1 md:flex">
          {LINKS.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link href={href} aria-current={active(href) ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${active(href) ? 'bg-white/10 text-white' : 'text-muted hover:bg-white/5 hover:text-white'}`}>
                <Icon className="h-4 w-4" aria-hidden />{label}
              </Link>
            </li>
          ))}
        </ul>
        <button className="rounded-lg p-2 hover:bg-white/10 md:hidden" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? 'Close menu' : 'Open menu'}>
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>
      {open && (
        <ul id="mobile-nav" className="space-y-1 border-t border-line px-4 py-3 md:hidden">
          {LINKS.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link href={href} onClick={() => setOpen(false)} aria-current={active(href) ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium ${active(href) ? 'bg-white/10 text-white' : 'text-muted'}`}>
                <Icon className="h-4 w-4" aria-hidden />{label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
