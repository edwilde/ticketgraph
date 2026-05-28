# Wesabe — Silverstripe CMS Recreation

---

## Epic 4: API Endpoints — Transactions

### API-05: GET /v2/accounts/transactions/{currency} — DONE

> List transactions with filtering. The most complex endpoint.

- Implement controller matching `OldTxactionsResource.show()`
- Support all query params: account, tag, merchant, start, end, limit, offset
- **AC:** Transactions listable with all filter combinations; pagination works
- **Blocked by:** MODEL-06 ✅, EXPLORE-01 ✅
