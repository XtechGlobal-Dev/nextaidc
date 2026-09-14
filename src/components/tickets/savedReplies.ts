import type { Ticket } from "@/types/ticket";

// Saved-reply blanks ({{requester_name}} etc). This list drives both the editor chips and the substitution so they can't disagree.

export const SAVED_REPLY_VARIABLES = [
  { token: "{{requester_name}}", hint: "who raised it, in full" },
  { token: "{{requester_first_name}}", hint: "their first name" },
  { token: "{{ticket_number}}", hint: "the request's #number" },
  { token: "{{ticket_reference}}", hint: "its reference code" },
  { token: "{{subject}}", hint: "its subject" },
  { token: "{{department}}", hint: "the department's name" },
  { token: "{{brand_name}}", hint: "the brand it came from" },
  { token: "{{agent_name}}", hint: "your name" },
] as const;

/** Swap every blank in a saved reply for this ticket's details. */
export function fillSavedReply(body: string, ticket: Ticket, agentName: string): string {
  const requester = ticket.requester.name || "there";
  const values: Record<string, string> = {
    requester_name: requester,
    requester_first_name: requester.split(/\s+/)[0] || requester,
    ticket_number: `#${ticket.number}`,
    ticket_reference: ticket.reference,
    subject: ticket.subject,
    department: ticket.department?.name ?? "Support",
    brand_name: ticket.brand?.name ?? "",
    agent_name: agentName,
  };
  // Unknown blanks are left as typed, so a typo shows up in the box instead of
  // silently vanishing from the reply.
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? whole : value;
  });
}
