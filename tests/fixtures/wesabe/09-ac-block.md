# Wesabe — Silverstripe CMS Recreation

---

## Epic 2: Core Data Model

### MODEL-03: Account DataObject — DONE

> The core account model. AccountType is an Enum (not a separate table).

- Create `Account` DataObject: Name, AccountNumber, AccountNumberHash, GUID, Currency (ISO 4217)
- Create `AccountBalance` DataObject: Balance (Decimal), BalanceDate, Status
- Compound indexes: `AccountKey` (for migration queries), `MemberID+Status`
- Write unit tests for CRUD, status transitions, balance tracking
- **AC:** Accounts scoped by MemberID; AccountType as Enum with all 13 values; status transitions enforced; balances convertible to display currency
- **Blocked by:** MODEL-01, MODEL-02
