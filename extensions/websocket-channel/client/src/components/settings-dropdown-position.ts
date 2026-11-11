import type { CSSProperties } from 'vue';

export function settingsDropdownPosition(trigger: HTMLElement): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const placeAbove = below < 180 && above > below;
  const height = Math.min(280, Math.max(0, placeAbove ? above : below));
  const width = Math.min(rect.width, window.innerWidth - 16);
  return {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    width: `${width}px`,
    maxHeight: `${height}px`,
    ...(placeAbove ? { bottom: `${window.innerHeight - rect.top + 6}px`, top: 'auto' } : { top: `${rect.bottom + 6}px` }),
  };
}
