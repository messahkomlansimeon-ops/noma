import { useMemo, useSyncExternalStore } from "react";
import { parseOtpFlow, readOtpFlowRaw, subscribeOtpFlow, type OtpFlow } from "./otp-flow";

/**
 * Parcours OTP de l'onglet courant. Côté serveur et pendant l'hydratation il vaut `null` (pas de stockage) ;
 * il est ensuite lu dans sessionStorage sans effet ni décalage d'hydratation.
 */
export function useOtpFlow(): OtpFlow | null {
  const raw = useSyncExternalStore(subscribeOtpFlow, () => readOtpFlowRaw(), () => null);
  return useMemo(() => parseOtpFlow(raw), [raw]);
}
