# Known limitations

The banned-syntax gate correctly detects normal net-new cases, including moves between real functions, renamed files, and edited or inserted siblings. As an accepted, deliberately scoped limitation rather than a pending fix, duplicate-path move detection can be fooled when a single change deliberately swaps or reorders the entire contents of two or more structurally identical anonymous callbacks at the same nesting depth; this requires constructed duplicate boilerplate and is not a realistic accidental-introduction path.
