// Type-to-confirm helpers for destructive deletes (cloud-console style). Pure so the match logic is testable without a DOM.

/** The exact phrase a user must type to confirm, e.g.
 *  `delete web service AgentLabs-AI-Dev-1`. */
export function confirmPhrase(resourceType: string, resourceName: string): string {
  return `delete ${resourceType} ${resourceName}`;
}

/** Exact, case-sensitive match. Deliberately no trim: a stray space keeps Delete disabled rather than silently passing. */
export function isConfirmed(input: string, resourceType: string, resourceName: string): boolean {
  return input === confirmPhrase(resourceType, resourceName);
}
