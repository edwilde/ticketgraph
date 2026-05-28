# Wesabe — Silverstripe CMS Recreation

---

## Import & Export Features

### FEAT-01: Import from PFC / brcm Wesabe export (all accounts at once) — DONE

> We need to ingest the XML/CSV export produced by the original PFC/brcm Wesabe app.

- **Files:** `app/src/Service/Import/PfcImporter.php` (new), `app/src/API/Controller/ImportController.php`
- **AC:** Uploading an exported PFC archive creates the expected accounts, transactions, tags and targets; accessible from the profile page; documented fixture + unit/integration tests exist.
