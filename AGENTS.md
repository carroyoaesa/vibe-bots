# Instrucciones para agentes IA

Este proyecto contiene un bot inicial construido en TypeScript.

## Qué debe saber el asistente

- Proyecto de bot para uso con GitHub Copilot y Anthropic Claude.
- Stack: Node.js + TypeScript.
- El código principal está en `src/index.ts`.
- Usa `npm install`, `npm run build`, `npm start`, `npm run dev`.

## Convenciones

- Mantener `src/` como fuente principal del código.
- Guardar las claves de la app (Alpaca, PostgreSQL, Redis, MinIO) en `secure/keys.env` o en variables de entorno, nunca en el repositorio.
- Las credenciales de Git/GitHub NO van en `secure/keys.env` ni en la URL del remoto: usar el credential helper de git (`~/.git-credentials`, configurado con `git config --global credential.helper store`).
- Evitar dependencias innecesarias fuera de `devDependencies` para comenzar.
- Documentar cualquier API externa o clave en `README.md`.

## Desarrollo asistido

- Generar funciones de bot en `src/` con comentarios claros.
- Crear tests y casos de uso antes de agregar nuevas funciones.
- Añadir cada nueva integración de API con `README.md` y `AGENTS.md`.
