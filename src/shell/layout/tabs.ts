/** 選んでいるタブが残っていればそれ、無ければ既定のタブ、それも無ければ先頭。何も無ければ null。 */
export function resolveTab(
  selected: string,
  available: string[],
  fallback: string,
): string | null {
  if (available.includes(selected)) return selected;
  if (available.includes(fallback)) return fallback;
  return available[0] ?? null;
}
