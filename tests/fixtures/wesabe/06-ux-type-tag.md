# Wesabe — Silverstripe CMS Recreation

---

## Epic 7: Frontend UX

### UX-01: Fix "Action 'accounts' isn't available" error when clicking account

> Clicking an account in the sidebar navigates to a URL like `/accounts/accounts/1`. Silverstripe interprets the second `accounts` segment as a controller action, which isn't in `allowed_actions`.
>
> **AC:** Clicking any account in the sidebar loads the account's transactions without error
- **Blocked by:** AUTH-02
