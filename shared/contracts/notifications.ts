import { z } from "zod";

export const NotificationTypeSchema = z.enum([
  "missed_call",
  "new_lead",
  "billing",
  "agent",
  "ticket",
  "system",
]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

// Validation runs pre-serialization, where `createdAt` is still a Date; this transform keeps the schema
// describing the WIRE shape (ISO string) while accepting the in-memory value.
const DateAsIsoString = z.union([z.date(), z.string()]).transform((d) => (d instanceof Date ? d.toISOString() : d));

export const NotificationSchema = z.object({
  id: z.string(),
  type: NotificationTypeSchema,
  title: z.string(),
  message: z.string(),
  link: z.string().nullable(),
  read: z.boolean(),
  createdAt: DateAsIsoString,
});
export type Notification = z.infer<typeof NotificationSchema>;

/** server/src/routes/notifications.routes.ts — GET / */
export const NotificationsListResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  unreadCount: z.number().int(),
});
export type NotificationsListResponse = z.infer<typeof NotificationsListResponseSchema>;

/** server/src/routes/notifications.routes.ts — GET /channels */
export const NotificationChannelsResponseSchema = z.object({
  email: z.boolean(),
  sms: z.boolean(),
  smsToCaller: z.boolean(),
  whatsapp: z.boolean(),
  customCrm: z.boolean(),
  multilingual: z.boolean(),
  callTransferDepartments: z.number().int(),
});
export type NotificationChannelsResponse = z.infer<typeof NotificationChannelsResponseSchema>;

/** server/src/routes/notifications.routes.ts — POST /test-summary */
export const TestSummaryResponseSchema = z.object({
  ok: z.literal(true),
  to: z.string(),
});
export type TestSummaryResponse = z.infer<typeof TestSummaryResponseSchema>;
