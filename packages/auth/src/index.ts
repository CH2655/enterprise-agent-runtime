import type { AgentIdentity } from "@ear/domain";
import { z } from "zod";

export const JwtClaimsSchema = z.object({
  sub: z.string().min(1),
  tenant_id: z.string().min(1),
  roles: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string().min(1)).default([]),
});

export interface IdentityContext extends AgentIdentity {
  roles: string[];
  scopes: string[];
  requestId: string;
}

export function identityFromJwtClaims(rawClaims: unknown, requestId: string): IdentityContext {
  const claims = JwtClaimsSchema.parse(rawClaims);
  return {
    tenantId: claims.tenant_id,
    userId: claims.sub,
    roles: [...new Set(claims.roles)],
    scopes: [...new Set(claims.scopes)],
    requestId,
  };
}

export function hasScope(identity: IdentityContext, requiredScope: string): boolean {
  return identity.scopes.includes(requiredScope);
}
