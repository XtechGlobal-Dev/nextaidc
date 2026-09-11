import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface TourStep {
  target: string;
  title: string;
  content: string;
  placement?: "top" | "bottom" | "left" | "right";
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: "[data-tour='dashboard']",
    title: "Dashboard",
    content: "Your analytics hub — see call volume, success rates, and leads at a glance.",
    placement: "right",
  },
  {
    target: "[data-tour='calls']",
    title: "Call Inbox",
    content: "Every call your AI receptionist handles appears here with transcripts and summaries.",
    placement: "right",
  },
  {
    target: "[data-tour='assistant']",
    title: "AI Brain",
    content: "Configure your assistant's personality, knowledge, rules, and automations.",
    placement: "right",
  },
  {
    target: "[data-tour='crm']",
    title: "Connect CRM",
    content: "Route leads directly to your CRM — Jobber, ServiceTitan, HubSpot, and more.",
    placement: "right",
  },
  {
    target: "[data-tour='settings']",
    title: "Settings",
    content: "Manage your account, billing, team, and notification preferences.",
    placement: "right",
  },
];

interface TourState {
  completed: boolean;
  active: boolean;
  currentStep: number;
  startTour: () => void;
  nextStep: () => void;
  prevStep: () => void;
  endTour: () => void;
  resetTour: () => void;
}

export const useTourStore = create<TourState>()(
  persist(
    (set, get) => ({
      completed: false,
      active: false,
      currentStep: 0,
      startTour: () => set({ active: true, currentStep: 0 }),
      nextStep: () => {
        const { currentStep } = get();
        if (currentStep < TOUR_STEPS.length - 1) {
          set({ currentStep: currentStep + 1 });
        } else {
          set({ active: false, completed: true });
        }
      },
      prevStep: () => {
        const { currentStep } = get();
        if (currentStep > 0) set({ currentStep: currentStep - 1 });
      },
      endTour: () => set({ active: false, completed: true }),
      resetTour: () => set({ completed: false, active: false, currentStep: 0 }),
    }),
    {
      name: "hello22_tour",
      // Only remember whether the tour was finished — `active`/`currentStep` are
      // session state and must not survive a reload (else it reopens on its own,
      // even over the Quick Setup wizard).
      partialize: (s) => ({ completed: s.completed }),
    },
  ),
);
