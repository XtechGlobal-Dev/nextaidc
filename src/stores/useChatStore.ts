import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import type { ChatMessage } from "@/types";
import { DEFAULT_CHAT_MESSAGES } from "@/data/defaults";
import { uid } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { sessionMark, sessionChanged } from "@/lib/sessionEpoch";

interface ChatState {
  open: boolean;
  messages: ChatMessage[];
  humanTakeover: boolean;
  hydrate: () => Promise<void>;
  toggle: (open?: boolean) => void;
  send: (content: string) => void;
  reset: () => void;
}

const CONV_ID = "chat_demo";

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      open: false,
      messages: DEFAULT_CHAT_MESSAGES,
      humanTakeover: false,
      hydrate: async () => {
        const mark = sessionMark();
        try {
          const data = await api.chat.get();
          if (sessionChanged(mark)) return; // response belongs to a previous account
          set({ messages: data.messages });
        } catch {
          /* never throw out of hydrate */
        }
      },
      toggle: (open) => set((s) => ({ open: open ?? !s.open })),
      send: (content) => {
        const text = content.trim();
        if (!text) return;
        const userMsg: ChatMessage = {
          id: uid("msg"),
          conversationId: CONV_ID,
          role: "user",
          content: text,
          createdAt: new Date().toISOString(),
        };
        // Optimistically append the user message.
        set((s) => ({ messages: [...s.messages, userMsg] }));

        void api.chat
          .send(text)
          .then((res) => {
            // Append only the assistant message(s) from the response.
            const assistant = res.messages.filter((m) => m.role !== "user");
            if (assistant.length > 0) {
              set((s) => ({ messages: [...s.messages, ...assistant] }));
            }
          })
          .catch((e) =>
            toast.error(e instanceof ApiError ? e.message : "Failed to send message"),
          );
      },
      reset: () => set({ messages: DEFAULT_CHAT_MESSAGES, humanTakeover: false, open: false }),
    }),
    { name: "hello22_chat" },
  ),
);
