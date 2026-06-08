// Radix portals (dialog/select/dropdown) default to document.body, which sits
// OUTSIDE #tasks-root and therefore outside the island's scoped theme + reset.
// Render them INTO #tasks-root so portaled content inherits our tokens/styles.
export function getPortalContainer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined
  return document.getElementById("tasks-root") ?? undefined
}
