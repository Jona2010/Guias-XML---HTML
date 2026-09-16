# Guías XML SUNAT — versión preparada para Vercel

Aplicación HTML/CSS/JavaScript con backend Express y MySQL.

## Estructura

- `public/` → frontend y recursos estáticos.
- `server.js` → API Express (`/guias`, `/buscar`, `/guardar-guia`, etc.).
- `package.json` → dependencias y Node.js 24.
- `.env.example` → variables requeridas (sin credenciales reales).

## Despliegue en Vercel

1. Sube esta carpeta a un repositorio GitHub nuevo o reemplaza el contenido del repositorio actual.
2. NO subas `.env` ni `node_modules`.
3. En Vercel crea/importa el proyecto desde ese repositorio.
4. En **Project Settings → Environment Variables** crea:
   - `DB_HOST`
   - `DB_PORT` (normalmente `3306`)
   - `DB_NAME`
   - `DB_USER`
   - `DB_PASS`
   - `DB_SSL` (`false` para el servidor actual si no exige TLS)
5. Despliega.
6. Verifica primero `/api/health` y después `/ping`.

## Importante sobre MySQL

La web puede estar en Vercel y la base MySQL seguir en tu hosting actual. El servidor MySQL debe aceptar conexiones remotas desde Vercel. Si el proveedor limita MySQL por IP fija, habrá que habilitar acceso externo compatible o migrar la BD a un proveedor MySQL apto para serverless.

## Seguridad

Las credenciales de BD ya no están escritas dentro de `server.js`. Si alguna contraseña estuvo en el código o fue subida anteriormente a Git, debes rotarla en el hosting y actualizarla en Vercel.
