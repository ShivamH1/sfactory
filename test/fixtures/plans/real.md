# Real-format plan

## Task 1: Service (after Task 6a)

**Files:**
- Modify `apps/x.ts`
- Create: `apps/y.ts:10-20`, `apps/z.ts`
- Test `apps/x.test.ts`

The retry depends on the clock: 5 minutes of waiting.

<!-- Round 6 (R1): this fence held "### Task 9: ..." and "- Create: `fenced.ts`"; a task heading or Files line inside code is now refused, so it holds a mention instead. -->
```md
Task 9, a fake task inside a fence, would create `fenced.ts`
```

## Task 6a: Prep
**Files:**
- Create: src/a.ts, src/b.ts
- **Depends on:** Task 1
