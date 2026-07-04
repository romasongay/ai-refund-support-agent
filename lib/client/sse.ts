/** Pure, incremental SSE frame parser (client-side). Feed decoded text; receive complete frames. */
export interface SseFrame {
  event?: string;
  data?: unknown;
  id?: string;
}

export class SseParser {
  private buffer = "";

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      if (raw === "" || raw.startsWith(":")) continue; // heartbeat / comment
      const frame: SseFrame = {};
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length > 0) {
        const dataStr = dataLines.join("\n");
        try {
          frame.data = JSON.parse(dataStr);
        } catch {
          frame.data = dataStr;
        }
      }
      frames.push(frame);
    }
    return frames;
  }
}
