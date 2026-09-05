# Private staging deployment

Use `scripts/deploy-private-staging.py --help` on the existing Zo runtime.
Only a verified commit already merged into origin/main is accepted. The script refuses active
jobs, installs the immutable release before stopping services, backs up queue/state and startup
configuration, switches the app path, then checks the existing private edge.

Example (substitute the verified full commit):
```sh
python3 scripts/deploy-private-staging.py \
  --root /home/workspace/.runtime/rough-cut-staging-6d439a3 \
  --repo /home/workspace/Projects/hollywood-video-rich-animatic --sha COMMIT
```

The runtime uses one shared configuration for API admission and worker execution. Deployment
starts with free mock inference, complete temporary speech and switchable captions; evaluation
of paid adapters runs in an isolated directory with a $5 job cap. The tailnet and mTLS settings
are preserved. No public launch or DNS change occurs.

The printed backup directory is the rollback handle. Drain jobs, then run the same script with
`--root RUNTIME --rollback BACKUP`. Rollback retains current project data and all billed events;
it converts the cost ledger to the legacy event array for older binaries. Reservations must be
empty because jobs are drained. Do not restore the old ledger snapshot over newer charges.
Private backups contain capability state and must not be committed or published.
