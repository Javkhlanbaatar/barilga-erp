# Barilga ERP

Construction ERP and e-commerce for the Mongolian market: heavy inventory, Ulaanbaatar logistics zones, role-based warehouse release, and QPay with webhook plus fail-safe polling.

## Stack

- **API:** NestJS 11, Prisma, PostgreSQL, JWT RBAC, Winston daily-rotate logs
- **Web:** Next.js 15, React 19, Tailwind CSS
- **Ops:** Docker Compose (Postgres), PM2 cluster (`instances: max`, 1GB restart ceiling)

## Quick start

Requires Node 20+, Docker, and Git (optional). This machine may need Node installed first.

```bash
cp .env.example .env
docker compose up -d postgres
cd apps/api && npx prisma generate && npx prisma migrate deploy && npx tsx prisma/seed.ts
# from repo root
npm install
npm run dev:api    # :4000
npm run dev:web    # :3000
```

Demo password for every seeded user: **`Barilga123!`**

| Email | Role |
| --- | --- |
| admin@barilga.mn | ADMIN |
| manager@barilga.mn | MANAGER |
| cashier@barilga.mn | BORLUULAGCH |
| warehouse@barilga.mn | ACHIGCH_BELTGEGCH |

Production (Linux VPS, Docker + Nginx):

```bash
cp .env.production.example .env.production   # fill secrets, never commit
chmod +x deploy.sh
./deploy.sh   # git pull, build images, prisma migrate deploy, compose up -d --build
```

Images: `Dockerfile.backend` (Nest + migrate on start), `Dockerfile.frontend` (Next.js standalone). Nginx publishes port 80 and proxies `/api` to the API. PM2 remains available for non-Docker hosts (`npm run build && pm2 start ecosystem.config.js`).

Logs: `logs/error-YYYY-MM-DD.log` (14 days) and `logs/business-YYYY-MM-DD.log` (30 days).

## Domain rules

### Zones (Ulaanbaatar)

| Code | Mongolian | Night −10% |
| --- | --- | --- |
| ZONE_A | Хотын төв | yes |
| ZONE_B | Алслагдсан дүүрэг | yes |
| ZONE_RESORT | Зуслан | yes |
| RURAL_TERMINAL | Хөдөө орон нутаг / Драгон, Вокзал | **no** |

ADMIN can edit base delivery fees and vehicle limits.

### Delivery methods

- `OUR_DELIVERY` — zone fee + optional unloading
- `SELF_PICKUP` / `CUSTOMER_DRIVER` — delivery **and** unloading forced to **0₮** (overrides cannot put them back)

### Vehicle matcher

First fit by weight, max piece length, and volume:

1. Porter ≤ 1.5t
2. Dump ≤ 5t
3. Manipulator ≤ 10t

Over Manipulator → HTTP 400 `VEHICLE_LIMIT_EXCEEDED`.

### Time & unloading

- **NIGHT:** −10% of delivery fee except rural terminal
- **EXPRESS:** +30% (≤1.5t) / +40% (≤5t) / +50% (>5t) of delivery fee
- **Unloading:** 15,000₮ per ton, minimum 15,000₮ when requested

Cashiers may override calculated fees before payment; each change is stored on `FeeOverrideAudit`.

### Order state machine

`PENDING_PAYMENT` → `READY_FOR_LOADING` **only after QPay PAID** → `COMPLETED` (warehouse).

Warehouse staff never see unpaid orders.

## QPay

- Invoice + QR created on order confirm (`POST /api/orders`)
- Webhook: `POST /api/payment/qpay/webhook` (unauthenticated; QPay server; `/api/payments/qpay/webhook` also accepted)
- Fail-safe: unpaid invoices polled at **T+1 min, T+3 min, T+5 min** (`QpayPollingService` every 30s)
- `QPAY_MOCK=true` runs without merchant credentials; cashiers can press **Mock: төлбөр PAID** on the order screen

Set `QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_INVOICE_CODE`, and `QPAY_MOCK=false` for live merchant.qpay.mn v2.

## API (JWT)

- `POST /api/auth/login`
- `POST /api/orders/quote` — dry-run fees + vehicle
- `POST /api/orders` — persist + QPay invoice
- `POST /api/orders/:id/override-fees`
- `POST /api/orders/:id/complete`
- `POST /api/payments/qpay/webhook`
- `GET /api/health`
