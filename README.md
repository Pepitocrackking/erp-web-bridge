# erp-web-bridge

Puente seguro entre el ERP local de un comercio (Saint Enterprise, Odoo) y un catálogo web B2B multimoneda (USD / Bs).

Un agente local escrito en Go lee el ERP y empuja los cambios por HTTPS hacia la nube. No abre puertos en el cliente, tolera cortes de luz e internet y nunca escribe en tablas fiscales: los pedidos web llegan al ERP como borradores.

> Estado: en construcción. El avance por fases está en [docs/ROADMAP.md](docs/ROADMAP.md).
