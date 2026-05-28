# Wesabe — Silverstripe CMS Recreation

---

## Post-Release Bug Queue

### BUG-01: Fix failing SetupPermissionGroupsTaskTest::testCreatesUserGroup — DONE

> PHPUnit test `App\Tests\Unit\Task\SetupPermissionGroupsTaskTest::testCreatesUserGroup` fails with "Failed asserting that false is true" at line 46.
>
> **Files:** `app/src/Task/SetupPermissionGroupsTask.php`, `app/tests/Unit/Task/SetupPermissionGroupsTaskTest.php`
> **AC:** `composer test:unit` passes with zero failures
> **Status:** Fixed on `main` (BUG-01-01, commit `d900603`).
