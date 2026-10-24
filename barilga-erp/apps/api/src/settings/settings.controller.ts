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
import { CATALOG_READ_ROLES, TOP_ROLES } from '../auth/rbac';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Permission } from '../auth/permissions';
import { CompanySettingsDto } from './company.dto';
import { DocTemplatesDto } from './doc-template.dto';
import { AddCategoryDto, CategoriesDto } from './dto/categories.dto';
import { AddUnitDto, UnitsDto } from './dto/units.dto';
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

  /** Document wording; everyone reads it when printing. */
  @Get('documents')
  @Roles(...CATALOG_READ_ROLES)
  documents() {
    return this.settings.documents();
  }

  /** Wording of printed documents: admin and the general manager (Ерөнхий менежер). */
  @Put('documents')
  @Permission('DOC_TEMPLATE_EDIT')
  setDocuments(@Body() dto: DocTemplatesDto, @CurrentUser() user: AuthUser) {
    return this.settings.setDocuments(dto, user.id);
  }

  /** Measuring units (хэмжих нэгж) for the product form; everyone who sees the catalog reads them. */
  @Get('units')
  @Roles(...CATALOG_READ_ROLES)
  units() {
    return this.settings.units();
  }

  /** The whole list (settings page): whoever may add and change products. */
  @Put('units')
  @Permission('PRODUCT_WRITE')
  setUnits(@Body() dto: UnitsDto, @CurrentUser() user: AuthUser) {
    return this.settings.setUnits(dto.units, user.id);
  }

  /** One new unit from the product form ('+ шинэ нэгж'); returns the list. */
  @Post('units')
  @Permission('PRODUCT_WRITE')
  addUnit(@Body() dto: AddUnitDto, @CurrentUser() user: AuthUser) {
    return this.settings.addUnit(dto.unit, user.id);
  }

  /** Product categories (барааны ангилал) for the product form; everyone who sees the catalog reads them. */
  @Get('categories')
  @Roles(...CATALOG_READ_ROLES)
  categories() {
    return this.settings.categories();
  }

  /** The whole list (settings page): whoever may add and change products. Products keep their category. */
  @Put('categories')
  @Permission('PRODUCT_WRITE')
  setCategories(@Body() dto: CategoriesDto, @CurrentUser() user: AuthUser) {
    return this.settings.setCategories(dto.categories, user.id);
  }

  /** One new category from the product form ('+ шинэ ангилал'); returns the list. */
  @Post('categories')
  @Permission('PRODUCT_WRITE')
  addCategory(@Body() dto: AddCategoryDto, @CurrentUser() user: AuthUser) {
    return this.settings.addCategory(dto.category, user.id);
  }
}
