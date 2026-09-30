# Known limitations

The banned-syntax gate correctly detects normal net-new cases, including moves between real functions, renamed files, and edited or inserted siblings. As an accepted, deliberately scoped limitation rather than a pending fix, duplicate-path move detection can be fooled when a single change deliberately swaps or reorders the entire contents of two or more structurally identical anonymous callbacks at the same nesting depth; this requires constructed duplicate boilerplate and is not a realistic accidental-introduction path.

## Start grant provenance across a service-worker restart

Chrome's `permissions.onAdded` names only the origin, and its permission
prompt has no deadline. The worker therefore keeps every Start request whose
answer it has not learned (its tab closed or left the origin, it expired, it
was superseded or refused) as _outstanding_ for its origin: no new Start for
that origin is registered while one is outstanding (`start_prompt_outstanding`,
so the popup never opens a second prompt for it), and a grant that arrives for
the origin is treated as the outstanding request's late answer and revoked.
This state lives in worker memory only. If the worker is idle-terminated while
such a prompt is still open and the coach then presses Start on another live
tab of the same origin, the fresh worker cannot know about the earlier prompt;
accepting the earlier prompt then would be attributed to the new Start (whose
tab is verified live on that origin at authorization). Persisting the marks in
`chrome.storage.session` would close that gap but would also lock the origin
until browser restart whenever a prompt is declined after its popup is gone
(Chrome never announces a decline), so it is deliberately not done here.
