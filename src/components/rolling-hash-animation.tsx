import { useEffect, useRef, useState } from "react";

/**
 * Animated rolling-hash window over a band of glyphs.
 * Pure visual — communicates "constant-time slide across the file".
 */
export function RollingHashAnimation() {
  const ref = useRef<HTMLDivElement>(null);
  const [hash, setHash] = useState("0x0000a3f1");
  const [pos, setPos] = useState(0);

  // Generate a stable string of bytes (hex) to slide over.
  const stream = Array.from({ length: 80 }, (_, i) =>
    ((i * 31 + 7) % 256).toString(16).padStart(2, "0"),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setPos((p) => (p + 1) % (stream.length - 16));
      setHash(
        "0x" +
          Math.floor(Math.random() * 0xffffffff)
            .toString(16)
            .padStart(8, "0"),
      );
    }, 220);
    return () => clearInterval(id);
  }, [stream.length]);

  return (
    <div
      ref={ref}
      className="relative overflow-hidden rounded-lg border border-border bg-card/40 p-6"
    >
      <div className="mb-4 flex items-center justify-between text-xs font-mono">
        <span className="text-muted-foreground">rolling adler-32 window</span>
        <span className="text-primary">weak = {hash}</span>
      </div>
      <div className="relative font-mono text-[11px] leading-tight tracking-wider text-muted-foreground">
        <div className="flex flex-wrap gap-x-1 gap-y-1">
          {stream.map((b, i) => {
            const inWindow = i >= pos && i < pos + 16;
            return (
              <span
                key={i}
                className={
                  inWindow
                    ? "rounded-sm bg-primary/20 px-1 py-0.5 text-primary transition-colors"
                    : "px-1 py-0.5"
                }
              >
                {b}
              </span>
            );
          })}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-4 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-primary/60" /> active window
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-muted-foreground/40" /> file bytes
        </span>
      </div>
    </div>
  );
}
