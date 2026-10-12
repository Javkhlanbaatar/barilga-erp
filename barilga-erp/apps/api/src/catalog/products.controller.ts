import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { CATALOG_READ_ROLES, CATALOG_WRITE_ROLES } from '../auth/rbac';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { productSearchFilter, productSearchTerm } from './product-search';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function productUploadDir() {
  const dir = join(process.cwd(), 'uploads', 'products');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Controller('products')
export class ProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_READ_ROLES)
  async list(@Query('q') q?: string, @Query('search') search?: string) {
    const searchWhere = await productSearchFilter(this.prisma, productSearchTerm(q, search));
    return this.prisma.product.findMany({
      where: { active: true, ...searchWhere },
      orderBy: { nameEn: 'asc' },
    });
  }

  @Get('all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_WRITE_ROLES)
  async listAll(@Query('q') q?: string, @Query('search') search?: string) {
    const searchWhere = await productSearchFilter(this.prisma, productSearchTerm(q, search));
    return this.prisma.product.findMany({
      where: searchWhere,
      orderBy: { sku: 'asc' },
    });
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_WRITE_ROLES)
  async create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    const { stockQty, warehouseId, ...rest } = dto;
    try {
      // The product starts at 0; any starting quantity is booked as an OPENING movement in one warehouse
      // so the ledger and the balances always agree.
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            ...rest,
            stockQty: 0,
            category: dto.category?.trim() || 'General',
            imageUrl: dto.imageUrl || null,
            description: dto.description?.trim() || null,
          },
        });
        if (stockQty) {
          const target = await this.inventory.resolveWarehouseId(tx, warehouseId ?? user.warehouseId ?? null);
          await this.inventory.openingBalance(tx, created.id, stockQty, {
            warehouseId: target,
            actorId: user.id,
            reason: 'Opening balance when the product was created',
          });
        }
        return tx.product.findUniqueOrThrow({ where: { id: created.id } });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`SKU ${dto.sku} already exists`);
      }
      throw err;
    }
  }

  @Post(':id/image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_WRITE_ROLES)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, productUploadDir()),
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname || '').toLowerCase() || '.jpg';
          const safe = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
          cb(null, `${randomUUID()}${safe}`);
        },
      }),
      limits: { fileSize: 3 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!IMAGE_MIMES.has(file.mimetype)) {
          cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadImage(
    @Param('id') id: string,
    @UploadedFile() file?: { filename: string; mimetype: string },
  ) {
    if (!file?.filename) {
      throw new BadRequestException('Image file is required (field name: file)');
    }
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Product not found');
    }
    const imageUrl = `/uploads/products/${file.filename}`;
    return this.prisma.product.update({ where: { id }, data: { imageUrl } });
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_WRITE_ROLES)
  async update(@Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: AuthUser) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    const { stockQty, ...rest } = dto;
    // The form always sends the quantity back; only a real change is a stock adjustment.
    const wantsStockChange = stockQty !== undefined && Number(existing.stockQty) !== stockQty;
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (wantsStockChange) {
          // With several warehouses "the quantity" is ambiguous, so the caller must say which one.
          const warehouses = await tx.warehouse.findMany({ where: { isActive: true } });
          if (warehouses.length !== 1) {
            throw new BadRequestException(
              'There are several warehouses; change stock with POST /inventory/adjust and a warehouseId',
            );
          }
          await this.inventory.adjustInTx(tx, {
            warehouseId: warehouses[0].id,
            productId: id,
            // Move the total to the typed value by changing the one warehouse that exists.
            delta: Math.round((stockQty - Number(existing.stockQty)) * 1000) / 1000,
            reason: 'Quantity edited on the product',
            actorId: user.id,
          });
        }
        return tx.product.update({
          where: { id },
          data: {
            ...rest,
            ...(dto.category !== undefined ? { category: dto.category.trim() || 'General' } : {}),
            ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl || null } : {}),
            ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
          },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`SKU ${dto.sku ?? existing.sku} already exists`);
      }
      throw err;
    }
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CATALOG_WRITE_ROLES)
  async remove(@Param('id') id: string) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    return this.prisma.product.update({ where: { id }, data: { active: false } });
  }
}
