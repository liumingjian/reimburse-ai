import { useLayoutEffect, type RefObject } from 'react';

// Publishes a sticky bar's rendered height as a CSS custom property on the document root, so other sticky parts of
// the page can pin below the step bar (--app-stepbar-h) or above the action bar (--app-action-bar-h).
// The property is removed on unmount, so pages without the bar fall back to 0.
export function useStickyHeight(ref: RefObject<HTMLElement | null>, property: '--app-stepbar-h' | '--app-action-bar-h'): void {
  useLayoutEffect(() => {
    const node = ref.current;
    const root = document.documentElement;
    if (!node) return;
    const update = () => root.style.setProperty(property, `${node.getBoundingClientRect().height}px`);
    update();
    // jsdom has no ResizeObserver; the first measurement is enough there.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(property);
    };
  }, [ref, property]);
}
