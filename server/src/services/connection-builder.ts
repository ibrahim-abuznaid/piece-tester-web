export type ConnectionType = 'SECRET_TEXT' | 'BASIC_AUTH' | 'OAUTH2' | 'CUSTOM_AUTH' | 'NO_AUTH';

/**
 * Build the AP connection value payload from stored credentials.
 */
export function buildConnectionValue(
  connectionType: ConnectionType,
  connection: Record<string, unknown>,
): Record<string, unknown> {
  switch (connectionType) {
    case 'SECRET_TEXT':
      return { type: 'SECRET_TEXT', secret_text: connection.secret_text as string };
    case 'BASIC_AUTH':
      return { type: 'BASIC_AUTH', username: connection.username as string, password: connection.password as string };
    case 'OAUTH2':
      return { type: 'OAUTH2', ...connection };
    case 'CUSTOM_AUTH':
      return { type: 'CUSTOM_AUTH', props: connection };
    case 'NO_AUTH':
      return { type: 'NO_AUTH' };
    default:
      throw new Error(`Unsupported connection type: ${connectionType}`);
  }
}

/**
 * Generate a deterministic external ID for a piece test connection.
 */
export function makeExternalId(pieceName: string): string {
  return `piece_tester_${pieceName.replace(/[^a-zA-Z0-9]/g, '_')}`;
}
