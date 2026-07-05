import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VoiceMic } from "@/components/voice/voice-mic";
import { isVoiceSupported } from "@/lib/client/voice";

/** A controllable RTCPeerConnection/data-channel stand-in so we can drive server events in a test. */
class MockDC {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState = "open";
  sent: string[] = [];
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = "closed";
  }
}
class MockPC {
  static last: MockPC | null = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  connectionState = "new";
  dc: MockDC | null = null;
  constructor() {
    MockPC.last = this;
  }
  addTrack() {}
  createDataChannel() {
    this.dc = new MockDC();
    return this.dc;
  }
  async createOffer() {
    return { sdp: "offer-sdp", type: "offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}

const okJson = (data: unknown) => ({ ok: true, json: async () => data });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  MockPC.last = null;
  if ("mediaDevices" in navigator) {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  }
});

const setMediaDevices = (getUserMedia: unknown) =>
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });

describe("isVoiceSupported", () => {
  it("is false when WebRTC (RTCPeerConnection) is unavailable", () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    expect(isVoiceSupported()).toBe(false);
  });
});

describe("VoiceMic", () => {
  it("degrades to a text-chat note when voice is unsupported", () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    expect(screen.getByText(/isn.t supported/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a helpful message when the microphone is blocked", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    setMediaDevices(getUserMedia);

    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));

    expect(await screen.findByText(/microphone access was blocked/i)).toBeTruthy();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("keeps the retry affordance live after a failed start (regression: dead retry button)", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    setMediaDevices(getUserMedia);

    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));
    await screen.findByText(/microphone access was blocked/i);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // Tapping again must actually retry (not silently early-return on a stale ref).
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });

  it("releases the microphone if the session is aborted mid-connect (regression: leaked hot mic)", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    const stopSpy = vi.fn();
    const fakeStream = { getTracks: () => [{ stop: stopSpy }] } as unknown as MediaStream;
    let resolveGum: (s: MediaStream) => void = () => {};
    const gumPromise = new Promise<MediaStream>((r) => {
      resolveGum = r;
    });
    setMediaDevices(vi.fn().mockReturnValue(gumPromise));

    const { unmount } = render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));
    await Promise.resolve(); // let start() park on the pending getUserMedia

    unmount(); // aborts the in-flight session
    resolveGum(fakeStream); // the mic resolves AFTER the abort…
    await gumPromise;
    await Promise.resolve();
    await Promise.resolve();

    // …and must be stopped rather than left hot.
    expect(stopSpy).toHaveBeenCalled();
  });

  it("stays cancellable while connecting (regression: disabled button during connect)", async () => {
    vi.stubGlobal("RTCPeerConnection", MockPC);
    const stopSpy = vi.fn();
    const fakeStream = { getTracks: () => [{ stop: stopSpy }] } as unknown as MediaStream;
    setMediaDevices(vi.fn().mockResolvedValue(fakeStream));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise(() => {})), // token fetch hangs → stuck "connecting"
    );

    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));
    await screen.findByText(/connecting/i);

    const btn = screen.getByRole("button");
    expect(btn.hasAttribute("disabled")).toBe(false); // user can still cancel

    fireEvent.click(btn); // active → stop() → abort → mic released
    await waitFor(() => expect(stopSpy).toHaveBeenCalled());
  });

  it("a server error event tears down the call and re-offers retry (regression: stuck listening)", async () => {
    vi.stubGlobal("RTCPeerConnection", MockPC);
    const stopSpy = vi.fn();
    const fakeStream = { getTracks: () => [{ stop: stopSpy }] } as unknown as MediaStream;
    setMediaDevices(vi.fn().mockResolvedValue(fakeStream));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ value: "ek_x", expiresAt: 9_999_999_999, model: "m" })) // token
        .mockResolvedValueOnce({ ok: true, text: async () => "answer-sdp" }), // SDP
    );

    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));
    await waitFor(() => expect(MockPC.last?.dc).toBeTruthy());

    act(() => MockPC.last!.dc!.onopen?.()); // → "listening" (active)
    await screen.findByRole("button", { name: /stop voice/i });

    await act(async () => {
      MockPC.last!.dc!.onmessage?.({
        data: JSON.stringify({ type: "error", error: { message: "session expired" } }),
      });
    });

    expect(await screen.findByText(/session expired/i)).toBeTruthy();
    expect(stopSpy).toHaveBeenCalled(); // torn down, not left hot
    expect(screen.getByRole("button", { name: /start voice/i })).toBeTruthy(); // retry offered
  });

  it("surfaces the real upstream status + message when the SDP call fails (regression: opaque error)", async () => {
    vi.stubGlobal("RTCPeerConnection", MockPC);
    const stopSpy = vi.fn();
    const fakeStream = { getTracks: () => [{ stop: stopSpy }] } as unknown as MediaStream;
    setMediaDevices(vi.fn().mockResolvedValue(fakeStream));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ value: "ek_x", expiresAt: 9_999_999_999, model: "m" })) // token
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () =>
            JSON.stringify({
              error: { message: "The model `x` does not exist", code: "model_not_found" },
            }),
        }), // SDP call → upstream 404
    );

    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/HTTP 404/);
    expect(alert.textContent).toMatch(/does not exist/);
    expect(stopSpy).toHaveBeenCalled(); // torn down on failure
  });
});

/**
 * Reconnect behavior (regression: a live take saw a server-side session reset silently swap the voice,
 * drop the tools, and lose context). A drop/reset must be VISIBLE and re-establish with our config.
 */
describe("VoiceMic auto-reconnect", () => {
  const BACKOFF = 900; // > RECONNECT_BACKOFF_MS (800) in the client
  const tokenAndSdp = () =>
    vi.fn((url: string) =>
      String(url).includes("/api/voice/token")
        ? Promise.resolve(okJson({ value: "ek_x", expiresAt: 9_999_999_999, model: "m" }))
        : Promise.resolve({ ok: true, status: 200, text: async () => "answer-sdp" }),
    );
  const tokenCalls = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls.filter((c) => String(c[0]).includes("/api/voice/token")).length;
  // Flush the pending promise chain (fetch → json → SDP …) without advancing wall time.
  const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it("visibly reconnects with a FRESH token when the WebRTC connection drops (not a silent swap / dead error)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", MockPC);
    const getUserMedia = vi
      .fn()
      .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream);
    setMediaDevices(getUserMedia);
    const fetchMock = tokenAndSdp();
    vi.stubGlobal("fetch", fetchMock);

    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));
    await flush();
    const firstPc = MockPC.last!;
    expect(firstPc.dc).toBeTruthy();
    act(() => firstPc.dc!.onopen?.());
    const before = tokenCalls(fetchMock);

    // Simulate a transport drop.
    await act(async () => {
      firstPc.connectionState = "failed";
      (firstPc.onconnectionstatechange as () => void)?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    // Visible reconnecting state — the user is never silently swapped.
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();

    // After the backoff: a fresh token is minted and a NEW peer connection is established (→ our voice +
    // policy + tools), and the mic is NOT re-requested.
    await advance(BACKOFF);
    expect(tokenCalls(fetchMock)).toBeGreaterThan(before);
    expect(MockPC.last).not.toBe(firstPc);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("treats a second session.created (server-side reset) as a visible reconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", MockPC);
    setMediaDevices(
      vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
    );
    const fetchMock = tokenAndSdp();
    vi.stubGlobal("fetch", fetchMock);

    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));
    await flush();
    const firstPc = MockPC.last!;
    act(() => firstPc.dc!.onopen?.());

    // First session.created is normal — no reconnect.
    await act(async () => {
      firstPc.dc!.onmessage?.({ data: JSON.stringify({ type: "session.created" }) });
      await vi.advanceTimersByTimeAsync(0);
    });
    const before = tokenCalls(fetchMock);
    expect(screen.queryByText(/reconnecting/i)).toBeNull();

    // A SECOND session.created on the same channel = the server rotated the session → visible reconnect.
    await act(async () => {
      firstPc.dc!.onmessage?.({ data: JSON.stringify({ type: "session.created" }) });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
    await advance(BACKOFF);
    expect(tokenCalls(fetchMock)).toBeGreaterThan(before);
  });

  it("gives up with a visible error after exhausting the reconnect budget", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", MockPC);
    const stopSpy = vi.fn();
    setMediaDevices(
      vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopSpy }] } as unknown as MediaStream),
    );
    // Token succeeds for the initial connect, then fails on every reconnect → budget drains → error.
    let tokenHits = 0;
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes("/api/voice/token")) {
        tokenHits += 1;
        return tokenHits === 1
          ? Promise.resolve(okJson({ value: "ek_x", expiresAt: 9_999_999_999, model: "m" }))
          : Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "down" }) });
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => "answer-sdp" });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<VoiceMic sessionId="s1" onTranscript={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice/i }));
    await flush();
    const firstPc = MockPC.last!;
    act(() => firstPc.dc!.onopen?.());

    await act(async () => {
      firstPc.connectionState = "failed";
      (firstPc.onconnectionstatechange as () => void)?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    // Two bounded reconnect attempts, each failing to mint a token, then it gives up.
    await advance(BACKOFF);
    await advance(BACKOFF);

    // Lands on a visible error + retry affordance (not an endless loop), mic released.
    expect(screen.getByRole("button", { name: /start voice/i })).toBeTruthy();
    expect(stopSpy).toHaveBeenCalled();
  });
});
