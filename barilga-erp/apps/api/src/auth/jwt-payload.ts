import { Role } from '@prisma/client';

export type JwtPayload = {
  sub: string;
  email: string | null;
  username?: string;
  role: Role;
  /** Issued at (seconds), added by the JWT library. */
  iat?: number;
};
