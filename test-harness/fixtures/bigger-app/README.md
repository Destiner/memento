# bigger-app

Billing and notification service: invoice lifecycle, user accounts, provider
webhooks, and a job queue for outbound notifications.

- `bun run check` — typecheck + tests
- `src/http.ts` — router; routes live in `src/routes/`
- `src/webhooks/handler.ts` — inbound billing-provider events
- `src/queue.ts` — outbound notification queue client
