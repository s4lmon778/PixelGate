import { useEffect, useRef, useState } from 'react';

/** Keep each QR module on a whole screen pixel, including after resizing. */
export function QrImage({
  src,
  modules,
  alt,
}: {
  src: string;
  modules: number;
  alt: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState<number>();
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) {
        const scale = Math.max(
          1,
          Math.floor(entry.contentRect.width / modules),
        );
        setEdge(scale * modules);
      }
    });
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, [modules]);
  return (
    <div className="qr-picture" ref={container}>
      <img
        src={src}
        width="512"
        height="512"
        alt={alt}
        style={{ width: edge ? `${edge}px` : '100%' }}
      />
    </div>
  );
}
