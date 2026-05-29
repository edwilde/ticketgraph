# Wesabe — Silverstripe CMS Recreation

---

## Epic 0: Exploration & Spike — ALL DONE

### EXPLORE-01: Deep-dive the brcm-accounts-api source — DONE

> **Output:** `.ai/research/api-endpoints.md` (1375 lines)
> 17 endpoints documented. Key findings: custom `Wesabe` auth scheme (not HTTP Basic), money serializes as `{"display","value"}`, 7-step TxactionListBuilder filter pipeline, account grouping merges similar types, balance calculation works backwards.
