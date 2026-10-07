import { api, type SessionOutcome } from "./api";
import { createCoalescedRead } from "./session";

/** Lecture de session partagée par la garde de session et le sélecteur d'espace : une seule requête GET /api/auth/session pour les lectures simultanées (lot D3). */
export const readSharedSession: () => Promise<SessionOutcome> = createCoalescedRead(() => api.auth.sessionOutcome());
