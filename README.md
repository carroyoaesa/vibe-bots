# Vibe Bots

Proyecto inicial para programar bots usando GitHub Copilot o Anthropic Claude en una instancia LXD.

## Objetivo

Crear y mantener bots con un flujo de desarrollo asistido por IA, usando archivos de personalización para Copilot y Claude.

## Estructura

- `src/` - código fuente TypeScript
- `package.json` - scripts de desarrollo
- `tsconfig.json` - configuración de TypeScript
- `AGENTS.md` - instrucciones de contexto para agentes IA
- `secure/` - directorio ignorado para claves y secretos locales
- `.env.example` - ejemplo de variables de entorno

## Comandos

- `npm install` - instalar dependencias
- `npm run build` - compilar TypeScript
- `npm start` - ejecutar el bot compilado
- `npm run dev` - ejecutar con `ts-node`

## Notas

1. Instala Node.js y npm en la instancia LXD si aún no están presentes.
2. Instala `GitHub Copilot` y/o `Anthropic Claude` en VS Code.
3. Guarda credenciales en `secure/keys.env` o en variables de entorno locales, nunca en el repositorio.
4. Usa `.env.example` como plantilla para tus claves privadas.

## Configuración segura de Alpaca

1. Crea el archivo `secure/keys.env` con las siguientes variables:

```env
ALPACA_API_KEY=tu_api_key_aqui
ALPACA_API_SECRET=tu_api_secret_aqui
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```

2. Ese archivo se ignorará en Git gracias a `.gitignore`.
3. La aplicación carga `secure/keys.env` automáticamente si existe.
4. No compartas las claves reales en mensajes o commits.
