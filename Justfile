# Justfile — Deterministic Task Runner
default: verify

# Run all deterministic guardrails
verify:
    @echo "==> Running Gitleaks (Secret Gate)..."
    gitleaks protect --staged
    @echo "==> Running AST Structural Scan..."
    sg scan || true
    @echo "==> Running ASE Output Validation..."
    ase-init --validate

# Quick secret scan of working tree
scan-secrets:
    gitleaks dir . --verbose

# Run AST structural linting
lint-ast:
    sg scan

# Prune dead code and unused exports
prune-dead-code:
    knip

# Benchmark deterministic verification loop
bench:
    hyperfine --warmup 1 'just verify'

# Declarative schema diffing
schema-diff:
    atlas schema diff
