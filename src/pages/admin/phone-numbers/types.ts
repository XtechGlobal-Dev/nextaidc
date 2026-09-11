// The phone-panel types are owned by the API client (single source of truth).
// Re-exported here under the panel's local names so the components read cleanly.
export type {
  PhoneNumberStatus,
  PhonePoolNumber as SystemPoolNumber,
  PhoneUserNumber as UserPhoneNumber,
  PhoneAgent as AssignableAgent,
  PhoneImportable as ImportableNumber,
  PhoneOverview,
} from "@/lib/api";
