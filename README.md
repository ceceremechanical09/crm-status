# Cecere Mechanical CRM status and watchdog

Status page: https://ceceremechanical09.github.io/crm-status/

`watchdog.mjs` runs every 5 minutes on GitHub Actions, outside the CRM's own hosting. It checks the CRM health endpoint. When the CRM is down it restarts the Supabase project's services if that is the safe fix, emails the owner, and commits `docs/status.json`, which the status page reads.

No customer data, CRM code or secrets live here. Secrets are GitHub Actions secrets: `SUPABASE_ACCESS_TOKEN`, `RESEND_API_KEY`, `ALERT_TO`.

Test without side effects: `DRY_RUN=1 node watchdog.mjs`
