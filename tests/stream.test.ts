import { describe, it, expect } from 'vitest';
import { isStreamingRequest } from '../src/stream';

describe('isStreamingRequest', () => {
  it('returns true when Accept header includes text/event-stream', () => {
    const req = { headers: { accept: 'text/event-stream' } } as any;
    expect(isStreamingRequest(req, {})).toBe(true);
  });

  it('returns true when body.stream === true', () => {
    const req = { headers: {} } as any;
    expect(isStreamingRequest(req, { stream: true })).toBe(true);
  });

  it('returns false for a plain JSON chat request', () => {
    const req = { headers: { accept: 'application/json' } } as any;
    expect(isStreamingRequest(req, { model: 'gpt-4', messages: [] })).toBe(false);
  });

  it('returns false when body is undefined and no streaming header', () => {
    const req = { headers: {} } as any;
    expect(isStreamingRequest(req, undefined)).toBe(false);
  });

  it('handles Accept with multiple media types', () => {
    const req = { headers: { accept: 'application/json, text/event-stream' } } as any;
    expect(isStreamingRequest(req, {})).toBe(true);
  });
});
