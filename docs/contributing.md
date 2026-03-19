# Contributing Guide

## Development Setup

```bash
# Prerequisites: Node.js >= 22, Anthropic API key
npm install
npm run build        # TypeScript → dist/
npx vitest run       # Run all tests (341 passing, 30 test files)
```

For full setup including API key and first trace, see [QUICKSTART.md](../QUICKSTART.md).

## Test Conventions

### TDD: RED before GREEN

The project follows strict TDD. Write failing tests first, then implement.

### Test Organization

| Location | Type | Description |
|----------|------|-------------|
| `src/foo.test.ts` | Unit | Co-located next to `foo.ts` |
| `src/__behavioral__/red-N-*.test.ts` | RED behavioral | Foundation contracts (registry, envelope, session, etc.) |
| `src/__behavioral__/phaseN-*.test.ts` | Phase behavioral | Feature-specific tests organized by implementation phase |
| `src/__behavioral__/cross-phase-*.test.ts` | Integration | Cross-component interaction tests |
| `src/__integration__/e2e.test.ts` | E2E | Gated behind `RUN_INTEGRATION=1` |

### Phase Organization

The project was built incrementally in phases:

| Phase | Focus | Test prefix |
|-------|-------|-------------|
| RED (1) | Foundation contracts | `red-1` through `red-7` |
| 2 | Persistence (SQLite), SDK integration | `phase2-*` |
| 3 | MCP transport, respond flow | `phase3-*` |
| 4 | Bootstrap, DI, starmap, boundary awareness | `phase4-*` |
| 5 | Analyzer enrichment, streaming, synthetic state, trace modes | `phase5-*` |
| 6 | Circuit breaker, cost controls, finding detectors, templates | `phase6-*` |

### Test Patterns

```typescript
// vitest with globals — no imports needed for describe/it/expect
describe('Registry', () => {
  it('should reject invalid status transitions', () => {
    const registry = new Registry();
    registry.add({ file_path: 'a.ts', status: 'cold', ... });
    expect(() => registry.update('a.ts', { status: 'ready' }))
      .toThrow('Invalid status transition');
  });
});
```

- Mock `SessionManager` and SDK calls to avoid API costs in tests
- Use in-memory SQLite for persistence tests
- Inject test-friendly deps (TraceLog, test Registry)
- Test each handler factory in isolation

## Code Conventions

- **ES2022 target, ESM** (`"type": "module"` in package.json)
- **Strict TypeScript** — `strict: true` in tsconfig
- **`type` for data shapes**, `interface` for behavioral contracts (see [Design Decisions](design-decisions.md))
- **DI everywhere** — `createXHandler(deps)` factory pattern, no globals
- **Types canonical in `src/types.ts`** — re-exported from other modules for backward compat
- **Zod schemas in `src/schemas.ts`** — one schema per MCP tool input

## Adding a New MCP Tool

1. **Define Zod schema** in `src/schemas.ts`:
   ```typescript
   export const MyToolInputSchema = z.object({
     param: z.string(),
   });
   export type MyToolInput = z.infer<typeof MyToolInputSchema>;
   ```

2. **Create handler factory** in appropriate file:
   - Internal tool → `src/handlers.ts`
   - External tool → `src/mcp-external.ts`
   ```typescript
   export function createMyToolHandler(deps: MyToolDeps) {
     return (input: MyToolInput) => {
       // ... closes over deps
     };
   }
   ```

3. **Wire in `src/server.ts`** in the appropriate session factory:
   - Internal: `createInternalSession()` function
   - External: `createExternalSession()` function
   ```typescript
   mcpServer.tool('my_tool', MyToolInputSchema.shape, async (params) => {
     const result = myToolHandler(params);
     return { content: [{ type: 'text', text: JSON.stringify(result) }] };
   });
   ```

4. **Add unit test** — co-located `*.test.ts` for the handler
5. **Add behavioral test** if the tool participates in multi-step flows

## Adding a New Finding Type

1. **Add to `FindingType` union** in `src/types.ts`:
   ```typescript
   export type FindingType =
     | 'contract_mismatch'
     | 'assumption_bug'
     | 'missing_error_path'
     | 'dead_spot'
     | 'unexpected_call'
     | 'my_new_finding';  // ← add here
   ```

2. **Implement detector** in `src/analyzer.ts`:
   ```typescript
   export function analyzeMyNewFinding(
     entries: TraceEntry[],
     registry: Registry,
   ): Finding[] {
     // ... detection logic
   }
   ```

3. **Add to `analyzeTrace()` aggregator** in `src/analyzer.ts`:
   ```typescript
   const myFindings = analyzeMyNewFinding(entries, registry);
   const all = [...contractFindings, ..., ...myFindings];
   ```

4. **Add unit tests** in `src/analyzer.test.ts`
5. **Add behavioral tests** in `src/__behavioral__/phase6-finding-detectors.test.ts`

## Running Tests

```bash
# All tests
npx vitest run

# Watch mode
npx vitest

# Single file
npx vitest run src/registry.test.ts

# Pattern match
npx vitest run src/__behavioral__/phase6

# With coverage
npx vitest run --coverage

# Integration tests (requires running server + API key)
RUN_INTEGRATION=1 npx vitest run src/__integration__/
```

## Build

```bash
npm run build    # TypeScript → dist/
npm run clean    # rm -rf dist/
```

Output: `dist/` directory with `.js` files, source maps, and declaration maps.

## See Also

- [Design Decisions](design-decisions.md) — patterns to follow
- [Type System](type-system.md) — type conventions
- [Architecture](architecture.md) — module map
