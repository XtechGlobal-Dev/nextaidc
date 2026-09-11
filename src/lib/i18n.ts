import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Locale = "en" | "es" | "fr" | "de" | "pt" | "zh" | "ja" | "ar";

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Espanol",
  fr: "Francais",
  de: "Deutsch",
  pt: "Portugues",
  zh: "Chinese",
  ja: "Japanese",
  ar: "Arabic",
};

type TranslationMap = Record<string, string>;
type TranslationBundle = Record<Locale, TranslationMap>;

const translations: TranslationBundle = {
  en: {
    "nav.dashboard": "Dashboard",
    "nav.calls": "Call Inbox",
    "nav.assistant": "AI Brain",
    "nav.crm": "Connect CRM",
    "nav.settings": "Account Settings",
    "dashboard.title": "Voice Agent Analytics",
    "dashboard.subtitle": "Live performance for your AI receptionist.",
    "dashboard.welcome": "Welcome back, {name}",
    "dashboard.refresh": "Refreshed",
    "dashboard.connected": "Connected",
    "dashboard.setup_pending": "Setup pending",
    "dashboard.calling_minutes": "Calling Minutes Used",
    "dashboard.num_calls": "Number of Calls",
    "dashboard.active_assistants": "Active Assistants",
    "dashboard.peak_time": "Peak Calls Time",
    "dashboard.avg_duration": "Avg Call Duration",
    "dashboard.success_rate": "Calls Success Rate",
    "common.all_calls": "All Calls",
    "common.phone": "Phone",
    "common.web": "Web",
    "common.today": "Today",
    "common.days7": "7 Days",
    "common.days14": "14 Days",
    "common.mtd": "Month to Date",
    "sidebar.trial_minutes": "Trial minutes",
    "sidebar.call_assistant": "Call Assistant",
    "sidebar.activate": "Activate Number",
    "sidebar.receptionist_number": "AI Receptionist Number",
    "sidebar.forwarding_help": "Need help forwarding calls?",
    "theme.light": "Light mode",
    "theme.dark": "Dark mode",
    "theme.system": "System mode",
    "notifications.title": "Notifications",
    "notifications.mark_all": "Mark all as read",
    "notifications.clear": "Clear",
    "notifications.empty": "No notifications yet",
    "tour.next": "Next",
    "tour.back": "Back",
    "tour.finish": "Finish",
    "tour.step": "Step {current} of {total}",
  },
  es: {
    "nav.dashboard": "Panel",
    "nav.calls": "Bandeja de Llamadas",
    "nav.assistant": "Cerebro IA",
    "nav.crm": "Conectar CRM",
    "nav.settings": "Configuracion",
    "dashboard.title": "Analisis del Agente de Voz",
    "dashboard.subtitle": "Rendimiento en vivo de tu recepcionista IA.",
    "dashboard.welcome": "Bienvenido, {name}",
    "dashboard.refresh": "Actualizado",
    "dashboard.connected": "Conectado",
    "dashboard.setup_pending": "Configuracion pendiente",
    "dashboard.calling_minutes": "Minutos de Llamada Usados",
    "dashboard.num_calls": "Numero de Llamadas",
    "dashboard.active_assistants": "Asistentes Activos",
    "dashboard.peak_time": "Hora Pico de Llamadas",
    "dashboard.avg_duration": "Duracion Promedio",
    "dashboard.success_rate": "Tasa de Exito",
    "common.all_calls": "Todas las Llamadas",
    "common.phone": "Telefono",
    "common.web": "Web",
    "common.today": "Hoy",
    "common.days7": "7 Dias",
    "common.days14": "14 Dias",
    "common.mtd": "Mes Actual",
    "sidebar.trial_minutes": "Minutos de prueba",
    "sidebar.call_assistant": "Llamar Asistente",
    "sidebar.activate": "Activar Numero",
    "sidebar.receptionist_number": "Numero de Recepcionista IA",
    "sidebar.forwarding_help": "Necesitas ayuda para desviar llamadas?",
    "theme.light": "Modo claro",
    "theme.dark": "Modo oscuro",
    "theme.system": "Modo sistema",
    "notifications.title": "Notificaciones",
    "notifications.mark_all": "Marcar todo leido",
    "notifications.clear": "Limpiar",
    "notifications.empty": "Sin notificaciones",
    "tour.next": "Siguiente",
    "tour.back": "Atras",
    "tour.finish": "Finalizar",
    "tour.step": "Paso {current} de {total}",
  },
  fr: {
    "nav.dashboard": "Tableau de bord",
    "nav.calls": "Boite d'appels",
    "nav.assistant": "Cerveau IA",
    "nav.crm": "Connecter CRM",
    "nav.settings": "Parametres",
    "dashboard.title": "Analyses de l'agent vocal",
    "dashboard.subtitle": "Performance en direct de votre receptionniste IA.",
    "dashboard.welcome": "Bon retour, {name}",
    "dashboard.connected": "Connecte",
    "dashboard.setup_pending": "Configuration en attente",
    "common.today": "Aujourd'hui",
    "common.days7": "7 jours",
    "common.days14": "14 jours",
    "common.mtd": "Mois en cours",
    "notifications.title": "Notifications",
    "notifications.empty": "Aucune notification",
    "tour.next": "Suivant",
    "tour.back": "Retour",
    "tour.finish": "Terminer",
  },
  de: {
    "nav.dashboard": "Dashboard",
    "nav.calls": "Anruf-Eingang",
    "nav.assistant": "KI-Gehirn",
    "nav.crm": "CRM verbinden",
    "nav.settings": "Einstellungen",
    "dashboard.title": "Sprachagenten-Analyse",
    "dashboard.subtitle": "Live-Leistung Ihres KI-Rezeptionisten.",
    "dashboard.welcome": "Willkommen zuruck, {name}",
    "dashboard.connected": "Verbunden",
    "dashboard.setup_pending": "Einrichtung ausstehend",
    "notifications.title": "Benachrichtigungen",
    "notifications.empty": "Keine Benachrichtigungen",
    "tour.next": "Weiter",
    "tour.back": "Zuruck",
    "tour.finish": "Fertig",
  },
  pt: {
    "nav.dashboard": "Painel",
    "nav.calls": "Caixa de Chamadas",
    "nav.assistant": "Cerebro IA",
    "nav.crm": "Conectar CRM",
    "nav.settings": "Configuracoes",
    "dashboard.title": "Analise do Agente de Voz",
    "dashboard.welcome": "Bem-vindo, {name}",
    "dashboard.connected": "Conectado",
    "notifications.title": "Notificacoes",
    "tour.next": "Proximo",
    "tour.back": "Voltar",
    "tour.finish": "Concluir",
  },
  zh: {
    "nav.dashboard": "dashboard",
    "nav.calls": "call-inbox",
    "nav.assistant": "AI-brain",
    "nav.crm": "connect-CRM",
    "nav.settings": "settings",
    "dashboard.title": "voice-agent-analytics",
    "dashboard.welcome": "{name}, welcome-back",
    "dashboard.connected": "connected",
    "notifications.title": "notifications",
    "tour.next": "next",
    "tour.finish": "finish",
  },
  ja: {
    "nav.dashboard": "dashboard",
    "nav.calls": "call-inbox",
    "nav.assistant": "AI-brain",
    "nav.crm": "CRM-connect",
    "nav.settings": "settings",
    "dashboard.title": "voice-agent-analytics",
    "dashboard.welcome": "{name}, welcome-back",
    "notifications.title": "notifications",
    "tour.next": "next",
    "tour.finish": "finish",
  },
  ar: {
    "nav.dashboard": "dashboard",
    "nav.calls": "call-inbox",
    "nav.assistant": "AI-brain",
    "nav.crm": "CRM-connect",
    "nav.settings": "settings",
    "dashboard.title": "voice-agent-analytics",
    "dashboard.welcome": "{name}, welcome-back",
    "notifications.title": "notifications",
    "tour.next": "next",
    "tour.finish": "finish",
  },
};

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set) => ({
      locale: "en",
      setLocale: (locale) => {
        set({ locale });
        document.documentElement.lang = locale;
        document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
      },
    }),
    {
      name: "hello22_i18n",
      onRehydrateStorage: () => (state) => {
        if (state) {
          document.documentElement.lang = state.locale;
          document.documentElement.dir = state.locale === "ar" ? "rtl" : "ltr";
        }
      },
    },
  ),
);

export function t(key: string, params?: Record<string, string | number>): string {
  const { locale } = useI18nStore.getState();
  let text = translations[locale]?.[key] ?? translations.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}

export function useT() {
  const locale = useI18nStore((s) => s.locale);
  return (key: string, params?: Record<string, string | number>): string => {
    let text = translations[locale]?.[key] ?? translations.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  };
}
