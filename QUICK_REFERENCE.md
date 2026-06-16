# QUICK REFERENCE: Priority Roadmap

## 📊 At a Glance

| Phase | Fixes | Effort | Timeline | Blocker |
|-------|-------|--------|----------|---------|
| 🔴 Phase 1 | 3 fixes | 7.5 days | 2 weeks | Release |
| 🟠 Phase 2 | 3 fixes | 8 days | 2 weeks | Production |
| 🟡 Phase 3 | 6 fixes | 9.5 days | 3-4 weeks | v1.0 |
| **TOTAL** | **12 fixes** | **24.5 days** | **4-5 weeks** | - |

---

## 🔴 PHASE 1: CRITICAL (WEEKS 1-2)

Execute sequentially: fix-001 → (fix-002 + fix-003 in parallel)

### ✓ fix-001: Path Validation (2 days)
- **Why first:** Foundation for all file operations
- **What:** Prevent path traversal, symlink attacks
- **How:** Use `fs.realpathSync()`, validate ranges
- **Test:** Reject `../`, symlinks, > 10GB files
- **Files:** `cli/src/index.ts`, `cli/src/push.ts`

### ✓ fix-002: Secure Credentials (3 days)
- **Depends on:** fix-001
- **Why:** API keys in plaintext = data breach
- **What:** OS keychain (macOS/Windows/Linux) + encryption fallback
- **How:** Use `keytar` npm package, encrypt with machine ID
- **Test:** Save/retrieve from keychain; verify .gitignore
- **Files:** `cli/src/config.ts`, `cli/src/index.ts`

### ✓ fix-003: Fix Concurrency Bug (2.5 days)
- **Depends on:** fix-001
- **Why:** Race condition causes duplicate uploads
- **What:** Semaphore pattern instead of manual state
- **How:** Atomic acquire/release, no shared mutable state
- **Test:** Upload 100 chunks with concurrency 5 → no duplicates
- **Files:** `cli/src/push.ts`

**Phase 1 Gates:** ✅ Security audit passes | ✅ Integration tests pass

---

## 🟠 PHASE 2: HARDENING (WEEKS 3-4)

Execute: fix-004 → fix-005 & fix-006 in parallel

### ✓ fix-004: HTTP Timeouts (1 day)
- **Why:** CLI can hang forever
- **What:** 30s timeout on all fetch() calls
- **How:** `AbortController` + `setTimeout()`
- **Test:** Timeout triggers on slow server
- **Files:** `cli/src/api.ts`

### ✓ fix-005: Error Handling (4 days)
- **Depends on:** fix-004
- **Why:** Raw errors confuse users
- **What:** Custom error classes (NetworkError, AuthError, etc.)
- **How:** HTTP status → error type → user message
- **Test:** Each error type has helpful message
- **Files:** `cli/src/api.ts`, `cli/src/index.ts`, new `cli/src/errors.ts`

### ✓ fix-006: DB Schema (3 days)
- **Depends on:** fix-001
- **Why:** No constraints = cache bugs
- **What:** Add NOT NULL, CHECK, FK, indexes, migrations
- **How:** Enhanced schema with constraints
- **Test:** Foreign keys enforced, indexes improve query speed
- **Files:** `cli/src/db.ts`

**Phase 2 Gates:** ✅ Ready for production | ✅ All APIs have timeouts

---

## 🟡 PHASE 3: QUALITY (WEEKS 5-8)

Can run mostly in parallel, fix-011 depends on fix-005 & fix-006

### ✓ fix-007: Logging (1.5 days) — INDEPENDENT
- **What:** Replace console.log with winston/pino
- **How:** Structured JSON logs with timestamps
- **Test:** Logs include timestamp, level, request ID
- **Files:** All CLI files

### ✓ fix-008: Retry Jitter (1 day) — DEPENDS: fix-004
- **What:** Remove thundering herd
- **How:** Exponential backoff + random jitter + Retry-After header
- **Test:** 5 concurrent retries don't all hit server at same time
- **Files:** `cli/src/push.ts`

### ✓ fix-009: Type Safety (1.5 days) — INDEPENDENT
- **What:** Replace `as any` with proper types
- **How:** Define FileRow, NegotiationSessionRow interfaces
- **Test:** TypeScript strict mode passes
- **Files:** `cli/src/db.ts`

### ✓ fix-010: Upload Compression (1.5 days) — DEPENDS: fix-005
- **What:** Gzip literals if > 1MB
- **How:** `zlib.gzipSync()`, only if > 5% savings
- **Test:** Compressed file is ~50% of original
- **Files:** `cli/src/api.ts`, `cli/src/push.ts`

### ✓ fix-011: CLI Tests (3.5 days) — DEPENDS: fix-005, fix-006
- **What:** Vitest unit + integration tests
- **How:** Mock S3, test config/db/push/api modules
- **Test:** 80%+ coverage, all tests pass
- **Files:** `cli/**/__tests__/**/*.test.ts`

### ✓ fix-012: Env Validation (0.5 days) — INDEPENDENT
- **What:** Validate DELTASYNC_CONCURRENCY, DELTASYNC_NATIVE
- **How:** Check ranges/paths at startup, fail loudly
- **Test:** Invalid env var throws helpful error
- **Files:** `cli/src/index.ts`, `cli/src/rsync.ts`

**Phase 3 Gates:** ✅ 80% test coverage | ✅ v1.0 release ready

---

## 🚀 IMPLEMENTATION WORKFLOW

### Week 1 (Phase 1, Part 1)
```bash
git checkout -b fix/phase1-security
# Day 1-2: Implement fix-001 (path validation)
npm test  # Run existing tests
git commit -m "fix: add input path validation"
```

### Week 2 (Phase 1, Part 2)
```bash
# Day 3-5: Implement fix-002 & fix-003 (can parallelize if 2 people)
npm install keytar
# Implement credentials + concurrency fixes
npm test
git commit -m "fix: secure credentials and concurrent uploads"
git push origin fix/phase1-security
# Create PR: Request security audit
```

### Week 3-4 (Phase 2)
```bash
git checkout -b fix/phase2-hardening
# Day 1: Implement fix-004 (timeouts)
# Day 2-5: Implement fix-005 & fix-006 (parallel)
npm test
git commit && git push
# Create PR: Check production readiness
```

### Week 5-8 (Phase 3)
```bash
git checkout -b fix/phase3-quality
# Implement all 6 fixes (mostly independent)
# Run linter: npm run lint
# Run tests: npm test
# Check coverage: npm run test:coverage
# Target 80%+ coverage
git commit && git push
# Create PR: Final quality gate
```

---

## 📋 Daily Checklist

Each day, before starting:
```bash
git pull origin main          # Get latest
npm install                   # Install new deps
npm run build                 # Compile TypeScript
npm test                      # Run all tests
npm run lint                  # Check code quality
```

Each day, before committing:
```bash
npm test                      # All tests pass?
npm run lint -- --fix         # Auto-fix style
npm run type-check            # TypeScript errors?
git diff --stat               # What changed?
```

---

## ⏱️ Resource Planning

### 1 Engineer (Serial Work)
- Phase 1: 2 weeks
- Phase 2: 2 weeks
- Phase 3: 3-4 weeks
- **Total: 4-5 weeks** ✓

### 2 Engineers (Parallel Work)
- Phase 1: 1.5 weeks (fix-001 sequential, then parallel)
- Phase 2: 1 week (fix-004 → then parallel fix-005 & 006)
- Phase 3: 2 weeks (mostly all parallel except fix-011)
- **Total: 2.5-3 weeks** 🚀

### Key Parallelization Points
- fix-002 & fix-003 can run simultaneously (both depend on fix-001)
- fix-005 & fix-006 can run simultaneously (independent)
- Phase 3 fixes mostly independent (except fix-011)

---

## 🎯 Success Metrics

After **Phase 1:** 
- ✅ No path traversal vulnerabilities
- ✅ Credentials encrypted or in keychain
- ✅ Concurrent uploads are atomic

After **Phase 2:** 
- ✅ All network calls have timeouts
- ✅ Errors are user-friendly
- ✅ Database is properly constrained

After **Phase 3:**
- ✅ 80%+ test coverage on CLI
- ✅ Logs are structured & parseable
- ✅ Bandwidth savings from compression
- ✅ v1.0 release candidate ready

---

## 📚 Resources

- **Detailed guide:** `/session/FIX_ROADMAP.md`
- **Weakness analysis:** `/session/WEAKNESS_ANALYSIS.md`
- **SQL database:** `weaknesses` table with all 12 issues
- **Roadmap table:** `fix_roadmap` table with effort/dependencies

---

## 🆘 Common Pitfalls

| Issue | Solution |
|-------|----------|
| Forgot to run tests | Add pre-commit hook: `npm test && npm run lint` |
| Merge conflict on db.ts | Coordinate with team; ensure migrations are backward compatible |
| Keytar fails on Linux | Test fallback encryption; document OS requirements |
| Tests slow (> 5min) | Parallelize with `vitest --reporter=verbose`; mock network calls |
| Coverage drops | Add tests for error paths; use `npm run test:coverage` |

