/**
 * Type-to-confirm helpers for destructive deletes.
 *
 * A heavyweight delete (a whole customer, role, plan, phone number…) requires
 * the user to type an exact phrase before the Delete button enables, the same
 * safeguard cloud consoles use. Kept as pure functions so the match logic is
 * unit-testable without a DOM and shared by every ConfirmDeleteDialog.
 */

/** The exact phrase a user must type to confirm, e.g.
 *  `delete web service AgentLabs-AI-Dev-1`. */
export function confirmPhrase(resourceType: string, resourceName: string): string {
  return `delete ${resourceType} ${resourceName}`;
}

/**
 * True only when `input` is an exact, case-sensitive match for the confirmation
 * phrase. Intentionally does NOT trim — "exact" means exact, so a stray leading
 * or trailing space keeps the Delete button disabled rather than silently
 * passing. This is the single gate the button's disabled state reads from.
 */
export function isConfirmed(input: string, resourceType: string, resourceName: string): boolean {
  return input === confirmPhrase(resourceType, resourceName);
}
