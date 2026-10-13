import { z } from "zod";

// Configure before constructing shared/browser schemas. Zod's optional runtime
// compilation probe otherwise emits a CSP violation even when its error is caught.
z.config({ jitless: true });

export { z };
