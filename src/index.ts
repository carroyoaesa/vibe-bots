/**
 * Vibe Bots - punto de entrada.
 *
 * Aquí puedes agregar lógica de bots y llamadas a APIs externas.
 */

import { loadAlpacaConfig } from './config';

async function main() {
  const alpaca = loadAlpacaConfig();
  console.log('Vibe Bots starting...');
  console.log('Alpaca base URL:', alpaca.baseUrl);
  console.log('Carga de configuración Alpaca completada.');
}

main().catch((error) => {
  console.error('Error en la aplicación:', error);
  process.exit(1);
});
