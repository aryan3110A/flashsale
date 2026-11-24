import { describe, it, expect } from 'vitest';
import { buildForwardHeaders } from '../../apps/gateway/src/proxy.js';

const req = (headers) => ({ headers: { host: 'localhost:8080', ...headers }, id: 'rid-1', socket: { remoteAddress: '10.0.0.5' } });

describe('forwarded request headers', () => {
  it('never forwards Expect (Windows PowerShell sends "100-continue"; undici rejects it with UND_ERR_NOT_SUPPORTED)', () => {
    const h = buildForwardHeaders(req({ expect: '100-continue', 'content-type': 'application/json' }), { forwardAuthorization: true });
    expect(h.expect).toBeUndefined();
    expect(h['content-type']).toBe('application/json');
  });

  it('drops cookies always and Authorization unless explicitly allowed', () => {
    const r = req({ cookie: 'a=b', authorization: 'Bearer abc' });
    expect(buildForwardHeaders(r).cookie).toBeUndefined();
    expect(buildForwardHeaders(r).authorization).toBeUndefined();
    expect(buildForwardHeaders(r, { forwardAuthorization: true }).authorization).toBe('Bearer abc');
    expect(buildForwardHeaders(r, { forwardAuthorization: true }).cookie).toBeUndefined();
  });

  it('adds forwarding headers and the request id', () => {
    const h = buildForwardHeaders(req({}));
    expect(h['x-request-id']).toBe('rid-1');
    expect(h['x-forwarded-for']).toBe('10.0.0.5');
  });
});
