// Per-browser conveniences only (favourites, last-used contact). Never the source of truth for bookings.
const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export const getFavorites = (): string[] => safe(() => JSON.parse(localStorage.getItem('fs:favorites') ?? '[]') as string[], []);
export const toggleFavorite = (id: string): string[] => {
  const cur = new Set(getFavorites());
  if (cur.has(id)) cur.delete(id); else cur.add(id);
  const next = [...cur];
  safe(() => localStorage.setItem('fs:favorites', JSON.stringify(next)), undefined);
  return next;
};
export const getContact = (): { name: string; email: string } => safe(() => JSON.parse(localStorage.getItem('fs:contact') ?? '{}') as { name: string; email: string }, { name: '', email: '' });
export const saveContact = (c: { name: string; email: string }) => safe(() => localStorage.setItem('fs:contact', JSON.stringify(c)), undefined);
