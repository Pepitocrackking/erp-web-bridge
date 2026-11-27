# Alertas de agente sin conexión

El agente local avisa a la API cada minuto (`POST /v1/agent/heartbeat`). Si deja de hacerlo, hay dos formas de enterarse.

## En el panel (siempre activo)

Un agente se considera **sin conexión** tras 3 minutos sin latido (`AGENT_ONLINE_WINDOW_MS` en `apps/web/lib/admin.ts`). El panel `/admin` lo muestra en vivo, sin recargar:

- **Banner rojo** «El agente local no responde», con hace cuánto, la advertencia de que el catálogo puede estar desactualizado, cuántos pedidos esperan al agente y un desplegable **«Qué hacer»** (revisar el equipo, `erp-agent service status` / `start`, el log).
- **Contador en la cabecera** («1 alerta», rojo) que lleva al detalle, y el número entre paréntesis en el **título de la pestaña**, que se ve aunque el panel esté en segundo plano.
- Aviso informativo, sin contarlo como alerta, si el agente **nunca** se ha conectado.
- Advertencia amarilla si hay **pedidos con error** (el ERP no los aceptó), con enlace a la lista y su botón «Reintentar».

## Por webhook (opcional)

Para enterarse sin tener el panel abierto, la API puede hacer un `POST` a una URL cuando el agente cae y cuando vuelve. Está **apagado** salvo que se defina `NOTIFY_WEBHOOK_URL`.

| Variable | Por defecto | Significado |
|---|---|---|
| `NOTIFY_WEBHOOK_URL` | vacío (apagado) | `https` obligatorio; `http` solo hacia localhost. Una URL inválida detiene el arranque de la API. |
| `NOTIFY_WEBHOOK_SECRET` | vacío | Si existe, el cuerpo se firma con HMAC-SHA256. |
| `NOTIFY_OFFLINE_AFTER_SECONDS` | `180` | Sin latido durante este tiempo = sin conexión. |
| `NOTIFY_CHECK_INTERVAL_SECONDS` | `60` | Cada cuánto revisa la API las organizaciones. |

### Garantías

- **Una vez por caída y una por recuperación.** La memoria está en la base (`organizations.agent_offline_notified_at`), no en la API: reiniciarla o tener varias instancias no repite avisos (cada aviso se reclama con un `UPDATE` atómico antes de enviarlo).
- **Si el destino falla** (error 5xx, tiempo agotado de 5 s, conexión rechazada), el aviso no se da por enviado y se **reintenta en la siguiente revisión**. Una redirección cuenta como fallo y no se sigue.
- Solo organizaciones **activas** que alguna vez se conectaron (un agente que nunca existió no genera alertas).
- La URL no se escribe en los logs (puede llevar un token): solo el host.

### Formato

`POST` con `content-type: application/json` y las cabeceras `x-erp-bridge-event` (`agent.offline` o `agent.online`) y, si hay secreto, `x-erp-bridge-signature: sha256=<hex>`.

```json
{
  "event": "agent.offline",
  "sent_at": "2026-11-26T21:40:59.064Z",
  "organization": { "id": "b0000000-0000-4000-8000-00000000000a", "slug": "demo-saint", "name": "Demo Saint" },
  "last_heartbeat_at": "2026-11-26T21:30:12.000Z",
  "offline_for_seconds": 647,
  "message": "El agente local de «Demo Saint» no da señales desde hace 11 min. El catálogo muestra el último estado válido."
}
```

`agent.online` lleva los mismos campos salvo `offline_for_seconds`.

### Verificar la firma (Node)

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isValid(rawBody, header, secret) {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Hay que firmar el **cuerpo crudo** tal como llegó, no el JSON vuelto a serializar.

### Probarlo en local

```
# receptor de prueba que imprime lo que llega
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(q.headers['x-erp-bridge-event'],b);s.end('ok')})}).listen(9000)"
NOTIFY_WEBHOOK_URL=http://localhost:9000/hook NOTIFY_CHECK_INTERVAL_SECONDS=5 PORT=3001 node apps/api/dist/main.js
```

Con el agente parado más de 3 minutos (o poniendo `last_heartbeat_at` antiguo por SQL) llega `agent.offline`; al volver el latido, `agent.online`.
