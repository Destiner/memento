# Project notes

## Memory (memento)

Before starting a task that involves architecture or planning, cross-repo work,
product rationale, third-party services or vendors, testing strategy, or triage:
run one targeted memento `search_memory` call and read only the top one or two
results. Do not search for simple, self-contained edits, and treat code and
current repository docs as more authoritative than memory.

After completing a task that surfaced a durable, cross-task insight (a vendor
quirk, a rate limit discovered the hard way, an incident lesson, a decision that
will repeat): save it with memento `create_memory`. Do not record routine task
status or repo-local facts — those belong in the repository.
