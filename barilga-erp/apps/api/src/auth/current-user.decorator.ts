import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';

export type AuthUser = {
  id: string;
  email: string | null;
  username?: string;
  role: Role;
  name: string;
  fullName?: string;
  /** Warehouse/shop the user is assigned to (null = not assigned). */
  warehouseId?: string | null;
};

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
