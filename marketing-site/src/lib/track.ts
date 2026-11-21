// Light tracking: no third-party scripts, no console output, no personal data.
// Pushes to window.dataLayer only if the page's owner has put one there.
export function track(name: string, props?: Record<string, string>): void {
  if (typeof window === "undefined") return;
  const layer = (window as unknown as { dataLayer?: unknown[] }).dataLayer;
  if (Array.isArray(layer)) layer.push({ event: name, ...props });
}
