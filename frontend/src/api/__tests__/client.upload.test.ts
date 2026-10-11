import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from '../client';

// Minimal XMLHttpRequest stand-in: uploadFile drives it through
// open/setRequestHeader/send plus the upload.onprogress and on* handlers.
// Each constructed instance is captured for the test.
class MockXHR {
  static instances: MockXHR[] = [];
  upload: {
    onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 200;
  responseText = '{"status":"ok"}';
  aborted = false;
  sent = false;

  constructor() {
    MockXHR.instances.push(this);
  }
  open(_method: string, _url: string) {}
  setRequestHeader(_k: string, _v: string) {}
  getResponseHeader(_name: string) {
    return null;
  }
  send(_body: FormData) {
    this.sent = true;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

describe('uploadFile abort', () => {
  beforeEach(() => {
    MockXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', MockXHR);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborts the in-flight XHR when the signal fires', async () => {
    const controller = new AbortController();
    const file = new File(['payload'], 'a.txt');
    const promise = uploadFile('agent1', file, '/tmp/a.txt', () => {}, controller.signal);

    const xhr = MockXHR.instances[0];
    expect(xhr.sent).toBe(true);

    controller.abort();
    expect(xhr.aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new File(['payload'], 'a.txt');
    const promise = uploadFile('agent1', file, '/tmp/a.txt', () => {}, controller.signal);

    const xhr = MockXHR.instances[0];
    expect(xhr.aborted).toBe(true);
    expect(xhr.sent).toBe(false);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves normally when not aborted', async () => {
    const controller = new AbortController();
    const file = new File(['payload'], 'a.txt');
    const promise = uploadFile('agent1', file, '/tmp/a.txt', () => {}, controller.signal);

    MockXHR.instances[0].onload?.();
    await expect(promise).resolves.toEqual({ status: 'ok' });
  });
});
