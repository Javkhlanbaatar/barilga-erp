import { HttpException, HttpStatus, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { WEBSHOP_USERNAME } from '../auth/rbac';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssignDriverDto,
  CheckoutPaymentMethod,
  CreateOrderDto,
  QuoteOrderDto,
} from '../orders/dto/order.dto';
import { OrdersService } from '../orders/orders.service';
import { SourceType } from '@prisma/client';

const DEFAULT_OPEN_ORDERS_PER_PHONE = 5;

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly config: ConfigService,
  ) {}

  async catalog() {
    const [products, zones] = await Promise.all([
      this.prisma.product.findMany({
        where: { active: true },
        orderBy: { nameMn: 'asc' },
        select: {
          id: true,
          sku: true,
          nameMn: true,
          nameEn: true,
          unit: true,
          priceMnt: true,
          weightKg: true,
          lengthM: true,
          volumeM3: true,
          stockQty: true,
          minStockLevel: true,
          imageUrl: true,
          description: true,
          category: true,
        },
      }),
      this.prisma.zone.findMany({
        where: { active: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    return { products, zones };
  }

  /** Strip staff-only line options (external supplier) from anonymous input. */
  private publicItems(items: QuoteOrderDto['items']) {
    return items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      sourceType: SourceType.INTERNAL,
    }));
  }

  quote(dto: QuoteOrderDto) {
    return this.orders.quote({ ...dto, items: this.publicItems(dto.items) });
  }

  async create(dto: CreateOrderDto) {
    const actor = await this.webshopActor();

    // Per-phone cap on unpaid web orders, so one visitor cannot pile up open invoices.
    const cap = Number(this.config.get<string>('PUBLIC_MAX_OPEN_ORDERS_PER_PHONE') ?? DEFAULT_OPEN_ORDERS_PER_PHONE);
    const open = await this.prisma.order.count({
      where: {
        createdById: actor.id,
        customerPhone: dto.customerPhone.trim(),
        status: OrderStatus.PENDING_PAYMENT,
      },
    });
    if (Number.isFinite(cap) && cap > 0 && open >= cap) {
      throw new HttpException(
        'Too many unpaid orders for this phone number. Please pay or wait before ordering again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Anonymous customers can only open a QPay invoice. Cash/card/split "PAID" is staff-only.
    const safe: CreateOrderDto = {
      ...dto,
      customerPhone: dto.customerPhone.trim(),
      items: this.publicItems(dto.items),
      paymentMethod: CheckoutPaymentMethod.QPAY,
      payments: undefined,
      // Anonymous customers never choose the warehouse; the default one fulfils web orders for now.
      warehouseId: undefined,
      billType: undefined,
      customerRegNumber: undefined,
    };
    const created = await this.orders.create(safe, actor);
    // Respond with the same narrow shape as the tracking page (no staff names, no internal ids).
    return this.orders.findPublicByToken(created.trackingToken);
  }

  findByToken(token: string) {
    return this.orders.findPublicByToken(token);
  }

  updateTransport(token: string, dto: AssignDriverDto) {
    return this.orders.updateTransportByToken(token, dto);
  }

  private async webshopActor(): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { username: WEBSHOP_USERNAME } });
    if (!user || !user.isActive) {
      throw new InternalServerErrorException('Web order actor is not configured');
    }
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      name: user.fullName,
      fullName: user.fullName,
    };
  }
}
