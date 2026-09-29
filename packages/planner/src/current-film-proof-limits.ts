import {MAX_REFERENCE_ASSETS} from "./references";

// Shared bounds cannot depend on the validator graph: it includes originals,
// mixed plans, prepared proof and queue entry points in either import order.
export const CURRENT_FILM_ORIGIN_LIMIT=16;
export const CURRENT_FILM_PROOF_LIMITS={inputBytes:256*1024**2,resultBytes:128*1024**2,jobs:1024,receipts:64,previews:256,candidates:256,files:80000,references:MAX_REFERENCE_ASSETS} as const;
