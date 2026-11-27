/** Types d'acquisition (partagés navigateur/serveur). La construction avec empreinte est dans ./node. */
export type FailureKind =
  | 'not_connected' | 'permission' | 'quota' | 'timeout' | 'invalid_schema'
  | 'empty' | 'partial' | 'method_missing' | 'provider_down' | 'uncertain' | 'rate_limited';

export const FAILURE_LABEL: Record<FailureKind, string> = {
  not_connected: 'serveur non connecté',
  permission: 'autorisation manquante',
  quota: 'quota dépassé',
  timeout: 'délai dépassé',
  invalid_schema: 'schéma invalide',
  empty: 'résultat vide',
  partial: 'couverture partielle',
  method_missing: 'méthode absente',
  provider_down: 'panne du fournisseur',
  uncertain: 'état incertain (pas de second envoi)',
  rate_limited: 'limite d’appels atteinte',
};

export interface Coverage { complete: boolean; pages: number; items?: number; note?: string }

export interface AcquisitionEnvelope {
  id: string;
  source: { serverId: string; serverName: string; demo: boolean };
  tool: string;
  args: Record<string, unknown>; // expurgés
  status: 'ok' | 'empty' | 'partial' | 'error';
  error?: { kind: FailureKind; message: string };
  requestId: string;
  schemaVersion: string;
  fetchedAt: string;
  observedAt: string | null;
  coverage: Coverage;
  rawRef: string;
  hash: string | null; // sha256 des octets bruts : prouve les octets, pas la vérité métier
}

/** Message d'erreur utilisateur, format « Le serveur X refuse la lecture (…). Action. » */
export function failureMessage(serverName: string, kind: FailureKind): string {
  const action: Partial<Record<FailureKind, string>> = {
    not_connected: 'Reconnecte-le pour continuer.',
    permission: 'Reconnecte-le pour continuer.',
    quota: 'Réessaie plus tard.',
    timeout: 'Actualise ou lance un diagnostic.',
    provider_down: 'Actualise plus tard ou lance un diagnostic.',
    method_missing: 'Choisis un autre outil ou une autre source.',
    invalid_schema: 'Lance un diagnostic.',
  };
  return `Le serveur ${serverName} refuse la lecture (${FAILURE_LABEL[kind]}). ${action[kind] ?? ''}`.trim();
}
