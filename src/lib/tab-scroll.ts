/**
 * Which scroll chevrons the tab strip should offer.
 *
 * The tab row scrolls horizontally rather than wrapping, so a tab that doesn't fit
 * is invisible and indistinguishable from a tab that doesn't exist. The chevrons are
 * the only affordance that says otherwise — they must appear whenever, and only
 * whenever, there is genuinely something off-screen to reach.
 */

/**
 * Sub-pixel slack. Browsers report fractional scrollWidth/clientWidth (more so now
 * that Ctrl +/- applies Chromium's `zoom`), and a rounding remainder must not read as
 * "there is more content" — that would strand a chevron on screen that scrolls nowhere.
 */
const EPSILON_PX = 1;

export function scrollAffordance(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { left: boolean; right: boolean } {
  const overflow = scrollWidth - clientWidth;
  if (overflow <= EPSILON_PX) return { left: false, right: false };

  return {
    left: scrollLeft > EPSILON_PX,
    right: scrollLeft < overflow - EPSILON_PX,
  };
}
