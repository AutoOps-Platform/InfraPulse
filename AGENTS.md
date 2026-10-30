# Agent Instructions

## Scope

These instructions apply to the repository root and all subdirectories unless a more specific `AGENTS.md` overrides them.

## Code Graph MCP

Use the `codebase-memory` skill and the Code Graph MCP tools for structural code exploration and impact analysis.

- Before structural exploration, confirm the indexed project with `mcp__codebase_memory__list_projects` and check freshness/readiness with `mcp__codebase_memory__index_status`.
- Use `mcp__codebase_memory__get_architecture` for repository structure, layers, routes, dependencies, entry points, and hotspots.
- Use `mcp__codebase_memory__search_graph` to find symbols and qualified names. Prefer exact graph symbols over broad text search when investigating code structure.
- Use `mcp__codebase_memory__trace_path` for callers, callees, and bounded call-chain analysis. Use both directions when assessing impact.
- Use `mcp__codebase_memory__get_code_snippet` after locating a symbol to inspect the relevant source.
- Use `mcp__codebase_memory__detect_changes` to map Git changes to affected symbols and dependents.
- Use `mcp__codebase_memory__query_graph` for multi-hop, aggregation, complexity, or cross-service questions.
- After candidate source paths are known, run `mcp__codebase_memory__check_index_coverage`. If coverage is partial, skipped, stale, or unknown, inspect the affected ranges with `read`/`grep` before relying on graph results.
- Paginate graph results when `has_more` is true. Do not claim exhaustive absence, dead code, or complete impact from a single bounded page.
- Use `search_code`/`grep` as a fallback for literals, configuration, generated files, and coverage-gap ranges.
- Treat graph results as evidence, not as permission to modify unrelated files.

## Infrastructure Changes

- Under `infra/`, do not create or write README files or test files unless the user explicitly authorizes them. The default is no README files and no test files, including Terraform test files, unit tests, and verification scripts under test directories.
- For Terraform syntax and configuration checks, use Terraform CLI commands such as `terraform fmt -check` and `terraform validate`; use `terraform init -backend=false` when initialization is needed for validation. Do not create test files for these checks.
- Syntax/configuration checks do not authorize `terraform apply` or `terraform destroy`.

## Git Safety

- Do not run `git add`, `git commit`, merge commits, or equivalent staging/commit operations unless the user explicitly authorizes them after reviewing the changes.
- Keep unrelated working-tree changes intact and report them when relevant.
