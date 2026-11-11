# Tools

Use available diff, search, symbol/reference and file-reading tools to inspect
the assigned changes and their real consumers. Read focused surrounding code
rather than dumping whole files or repeatedly scanning the repository.

Prefer existing narrow checks or tests when execution is necessary to verify a
finding. Respect the caller's validation limits; do not install dependencies,
change fixtures or generate artifacts as an incidental part of review.
Report failed or unavailable checks and their effect on confidence.

Tool availability and approval requirements come from the runtime. These
instructions neither grant permissions nor bypass required approval.
