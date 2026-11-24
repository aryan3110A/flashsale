// The session token lives in this browser only. It is sent as "Authorization: Bearer ..." to the gateway.
// Trade-off (documented): localStorage is readable by any script on the page, whereas an httpOnly cookie is
// not. We use a header token because the website (:3000) and the gateway (:8080) are different origins and
// the gateway deliberately never forwards cookies to backend services.
const KEY = 'fs:token';
const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export const getToken = (): string | null => (typeof window === 'undefined' ? null : safe(() => localStorage.getItem(KEY), null));
export const setToken = (t: string) => safe(() => localStorage.setItem(KEY, t), undefined);
export const clearToken = () => safe(() => localStorage.removeItem(KEY), undefined);
