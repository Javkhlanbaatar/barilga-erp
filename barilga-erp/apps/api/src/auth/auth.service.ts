import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const ident = (dto.username || dto.email || '').trim().toLowerCase();
    if (!ident) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const user = await this.prisma.user.findFirst({
      where: ident.includes('@')
        ? { email: ident }
        : { OR: [{ username: ident }, { email: ident }] },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    });
    return {
      accessToken: token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.fullName,
        fullName: user.fullName,
        role: user.role,
        isActive: user.isActive,
        warehouseId: user.warehouseId,
      },
    };
  }
}
