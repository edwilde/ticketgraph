# Wesabe — Silverstripe CMS Recreation

---

## Epic 1: Project Setup

### SETUP-02: Configure CI-ready test harness

> Set up PHPUnit with Silverstripe's test framework, plus code quality tooling.

- Configure `phpunit.xml.dist` with `SilverStripe\Dev\SapphireTest` bootstrap
- Add `phpstan` with Silverstripe extension for static analysis
- Create `composer test`, `composer lint`, `composer analyse` scripts
- **AC:** `composer test` runs PHPUnit; `composer lint` checks code style
