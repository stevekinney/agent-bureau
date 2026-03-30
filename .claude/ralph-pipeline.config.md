task_file: ROADMAP.md
base_branch: main
on_stuck: skip
max_parallel: 4

verify:
  - turbo run validate

reviewers:
  - copilot

work_max_iterations: 15
branch_prefix: ralph/
