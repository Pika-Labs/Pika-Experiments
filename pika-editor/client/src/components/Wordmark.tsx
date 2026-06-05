import { useEffect, useState } from 'react';

let cached: string | null = null;

export function Wordmark() {
  const [svg, setSvg] = useState<string | null>(cached);
  useEffect(() => {
    if (cached) return;
    fetch('/img/wordmark.svg').then(r => r.text()).then(s => { cached = s; setSvg(s); });
  }, []);
  return (
    <span
      className="brand-dot"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
