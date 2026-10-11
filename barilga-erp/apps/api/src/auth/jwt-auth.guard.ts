import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** JWT bearer guard used with RolesGuard on protected controllers. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
