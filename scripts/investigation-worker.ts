// Prevent an old supervisor from restarting report/evidence persistence.
console.error("Saved-job processing has been retired. Use npm run engine:serve for fresh request-only investigations.");
process.exitCode = 1;
