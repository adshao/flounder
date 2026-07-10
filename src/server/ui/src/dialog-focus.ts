/** Return the next focusable index for a wrapping modal focus trap. */
export function nextDialogFocusIndex(activeIndex: number, count: number, backward: boolean): number {
  if (count <= 0) return -1;
  if (activeIndex < 0) return backward ? count - 1 : 0;
  return backward ? (activeIndex - 1 + count) % count : (activeIndex + 1) % count;
}
