# Política de seguridad

## Cómo reportar una vulnerabilidad

**No abras un issue público** para un problema de seguridad. Escribe a Orlando Guerra por un canal privado:
en GitHub, desde la pestaña **Security → Report a vulnerability** de este repositorio (aviso privado).

Incluye, si puedes: qué componente (agente, API, web o base de datos), cómo reproducirlo, qué impacto tiene y la versión o el commit. Se responde con un acuse de recibo y una primera valoración; las correcciones se publican junto con el aviso.

## Qué está en alcance

- **Aislamiento entre organizaciones** (RLS de PostgreSQL, claves de agente, JWT): cualquier forma de leer o escribir datos de otra organización.
- **El agente local y el ERP:** cualquier forma de que el agente escriba fuera de las tablas de borrador de pedidos, o de que exponga secretos (clave de API, DSN) en logs, errores o red.
- **Autenticación y autorización** de la API y la web, inyección, XSS, fuga de secretos.

Fuera de alcance: ataques de denegación de servicio volumétricos, hallazgos que exigen acceso físico o administrador al equipo del agente, y el contenido de las credenciales de **desarrollo** documentadas (ver `docs/security.md`).

## Qué se vigila automáticamente

En cada pull request, el CI ejecuta el escaneo de secretos sobre todo el historial (gitleaks), `pnpm audit`, `govulncheck`, las pruebas de aislamiento entre organizaciones y las guardas estructurales de la base de datos. La revisión de seguridad, sus hallazgos y los riesgos aceptados están en [docs/security.md](docs/security.md).
