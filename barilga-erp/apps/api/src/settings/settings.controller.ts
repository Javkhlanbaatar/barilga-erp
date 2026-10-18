import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CATALOG_READ_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CompanySettingsDto } from './company.dto';
import { PrintSettingsDto } from './print.dto';
import { SettingsService } from './settings.service';

const LOGO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function companyUploadDir() {
  const dir = join(process.cwd(), 'uploads', 'company');
  mkdirSync(dir, { recursive: true });
  return dir;
}

@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Any staff member can read it: invoices and receipts are printed from the POS and the warehouse. */
  @Get('company')
  @Roles(...CATALOG_READ_ROLES)
  company() {
    return this.settings.company();
  }

  @Put('company')
  @Roles(Role.ADMIN)
  setCompany(@Body() dto: CompanySettingsDto, @CurrentUser() user: AuthUser) {
    return this.settings.setCompany(dto, user.id);
  }

  /** Company logo for documents (PNG with a transparent background looks best as a watermark). */
  @Post('company/logo')
  @Roles(Role.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, companyUploadDir()),
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname || '').toLowerCase();
          cb(null, `logo-${randomUUID()}${['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.png'}`);
        },
      }),
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!LOGO_MIMES.has(file.mimetype)) {
          cb(new BadRequestException('Зөвхөн PNG, JPEG, WebP зураг / Only PNG, JPEG or WebP images'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadLogo(@UploadedFile() file: { filename: string } | undefined, @CurrentUser() user: AuthUser) {
    if (!file?.filename) throw new BadRequestException('Logo file is required (field name: file)');
    return this.settings.setLogo(`/uploads/company/${file.filename}`, user.id);
  }

  @Delete('company/logo')
  @Roles(Role.ADMIN)
  removeLogo(@CurrentUser() user: AuthUser) {
    return this.settings.setLogo(null, user.id);
  }

  /** Paper layout per document; everyone reads it so printing never asks again. */
  @Get('print')
  @Roles(...CATALOG_READ_ROLES)
  print() {
    return this.settings.print();
  }

  @Put('print')
  @Roles(Role.ADMIN)
  setPrint(@Body() dto: PrintSettingsDto, @CurrentUser() user: AuthUser) {
    return this.settings.setPrint(dto, user.id);
  }
}
