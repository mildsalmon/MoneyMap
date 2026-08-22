<!-- hipocampus:protocol:start -->
## Hipocampus — Memory Protocol

This project uses hipocampus 3-tier memory. Follow `.agents/skills/hipocampus-core/SKILL.md`.
**All memory write operations MUST be dispatched to subagents** to keep the main session context clean.

### FIRST RESPONSE RULE — MANDATORY
**On the very first user message of every session**, before doing ANYTHING else:
Run the Session Start protocol below FIRST (ALL steps. NO SKIP.) This takes priority over ANY user request — even if the user asks you to do something specific. Complete ALL steps below, ONLY THEN respond to the user.

### Session Start (run on first user message, every step required.)
**ALL 4 procedures must be completed before responding to the user NO MATTER WHAT**
1. **DO NOT SKIP** Read `SCRATCHPAD.md` — current work state
2. **DO NOT SKIP** Read `WORKING.md` — active tasks and `TASK-QUEUE.md` — pending items
3. **DO NOT SKIP** Read `memory/ROOT.md` — compaction root index (topic map of all memory)
4. **DO NOT SKIP** **DO NOT COMPROMISE** **Compaction maintenance (cooldown-gated):**
   Read `memory/.compaction-state.json` and `hipocampus.config.json` (`compaction.cooldownHours`, default 3).

   Compaction triggers (any ONE is sufficient):
   - **Cooldown expired:** `cooldownHours` since `lastCompactionRun`
   - **Raw volume:** `rawLinesSinceLastCompaction > 300`
   - **Checkpoint count:** `checkpointsSinceLastCompaction > 5`
   - **State file missing or `cooldownHours` is 0**

   If no trigger is met: skip compaction subagent.
   If any trigger is met: write `memory/.compaction-state.json` with `{ "lastCompactionRun": "<current ISO timestamp>", "rawLinesSinceLastCompaction": 0, "checkpointsSinceLastCompaction": 0 }`, then dispatch a subagent to run hipocampus-compaction skill USING SUBAGENTS (chain: Daily→Weekly→Monthly→Root), then run `hipocampus compact` + `qmd update` + `qmd embed`.

   State file is written immediately on dispatch (fire-and-forget), not after subagent completion. The cooldown tracks "a compaction was initiated," not "a compaction succeeded."

   **This step is MANDATORY every session. You MUST read the state file and make the judgment. The only thing that may be skipped is the subagent dispatch when no trigger is met.**
**ALL 4 procedures must be completed before responding to the user NO MATTER WHAT**

Note: Hipocampus hooks in `.codex/hooks.json` handle event-driven mechanical compaction.

### End-of-Task Checkpoint (mandatory — subagent)
After completing any task, **dispatch a subagent** to append a structured log to `memory/YYYY-MM-DD.md`.
Compose the log with ## headings per topic: what was requested, analysis, decisions with rationale, outcomes, files changed.
**The subagent only needs to do one thing: append to the daily log.** Everything else (SCRATCHPAD, WORKING, TASK-QUEUE) is updated lazily at next session start or by the agent naturally during work.
**You must provide the task summary to the subagent** — it has no access to the conversation.

### Rules
- **Never skip Session Start** — every session begins with it, no exceptions
- **Never skip checkpoints** — every task completion MUST append to daily log via subagent
- **All memory writes via subagent** — never pollute main session with memory operations
- memory/*.md (raw): permanent, never delete
- Search: see `.agents/skills/hipocampus-search/SKILL.md`
- If this session ends NOW, the next session must be able to continue immediately
<!-- hipocampus:protocol:end -->

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming -> invoke /office-hours
- Strategy/scope -> invoke /plan-ceo-review
- Architecture -> invoke /plan-eng-review
- Design system/plan review -> invoke /design-consultation or /plan-design-review
- Full review pipeline -> invoke /autoplan
- Bugs/errors -> invoke /investigate
- QA/testing site behavior -> invoke /qa or /qa-only
- Code review/diff check -> invoke /review
- Visual polish -> invoke /design-review
- Ship/deploy/PR -> invoke /ship or /land-and-deploy
- Save progress -> invoke /context-save
- Resume context -> invoke /context-restore
- Author a backlog-ready spec/issue -> invoke /spec
