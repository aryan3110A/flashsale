'use client';
import { useState } from 'react';
import { Music2, Cpu, Users, Gamepad2, Trophy, Mic2, UtensilsCrossed, Ticket } from 'lucide-react';

const ICONS: Record<string, typeof Music2> = { Music: Music2, Technology: Cpu, Networking: Users, Gaming: Gamepad2, Sports: Trophy, Comedy: Mic2, Food: UtensilsCrossed };
const HUES: Record<string, string> = { Music: '#6f5cf5', Technology: '#0ea5c6', Networking: '#d946a8', Gaming: '#65a30d', Sports: '#f97316', Comedy: '#eab308', Food: '#ef4444' };

/** Fixed 16:10 box. Falls back to a category-coloured gradient if the photo is missing or fails to load. */
export function EventImage({ src, category, alt, className = '' }: { src: string | null; category: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const Icon = ICONS[category] ?? Ticket;
  const hue = HUES[category] ?? '#6f5cf5';
  return (
    <div className={`relative aspect-[16/10] w-full overflow-hidden bg-surface-2 ${className}`}>
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
      ) : (
        <div role="img" aria-label={alt} className="flex h-full w-full items-center justify-center" style={{ background: `linear-gradient(135deg, ${hue}, #0a0f1e 85%)` }}>
          <Icon className="h-14 w-14 text-white/70" aria-hidden />
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg/70 via-transparent to-transparent" />
    </div>
  );
}
