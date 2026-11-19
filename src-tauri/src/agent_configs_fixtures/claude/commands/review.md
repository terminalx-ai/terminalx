---
description: Review the current branch against main
argument-hint: [focus]
allowed-tools: Bash(git diff:*), Bash(git log:*)
model: claude-sonnet-4-5
---
Review the changes on this branch against main. Focus on $ARGUMENTS.

Current diff: !`git diff main...HEAD --stat`
