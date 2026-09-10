---
name: Feature or format change
about: Propose a new CLI capability, or a change to the Agent-Context format itself
labels: enhancement
---

**Is this a CLI feature or a format change?**

A new `agent-commit` flag/command is a CLI feature. A new common field, a
change to how squash-merges are handled, anything that affects the
`Agent-Context` trailer's shape, is a format change, see SPEC.md and
CONTRIBUTING.md's "Changing the format itself" section, since it affects
every repo that's already adopted the convention, not just this codebase.

**What problem does this solve, concretely**

Not "this would be nice," an actual situation where the current behavior
falls short.

**Before you propose semantic search or mandatory schema enforcement**

Both are deliberately out of scope, not unfinished, see CONTRIBUTING.md.
A proposal to add either needs a specific argument for why the tradeoff
that ruled it out no longer holds, not just a restatement of the idea.
