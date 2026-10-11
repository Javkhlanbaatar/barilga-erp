import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BillType, OrderStatus, PaymentStatus, Prisma, Role, SourceType, TransferStatus } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import { isFallbackPicker, isHiredTransport, isPosActor, isTransportActor, isWarehouseActor } from '../auth/rbac';
import { EbarimtService } from '../ebarimt/ebarimt.service';
import { FeaturesService } from '../features/features.service';
import { InventoryService } from '../inventory/inventory.service';
import { assertWarehouseAccess, lockedWarehouseId } from '../inventory/warehouse-scope';
import { LogisticsService } from '../logistics/logistics.service';
import { isZeroFeeMethod } from '../logistics/logistics.engine';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { planFulfillment } from './fulfillment-plan';
import { createWithUniqueOrderNumber } from './order-number';
import {
  AssignDriverDto,
  AssignSupplierDto,
  CheckoutPaymentMethod,
  CompleteFulfillmentDto,
  CreateOrderDto,
  OverrideFeesDto,
  QuoteOrderDto,
} from './dto/order.dto';

const DRIVER_PHONE_RE = /^[0-9+\-]{8,15}$/;
/** Order money columns are 32-bit integers; stay well inside them. */
const MAX_ORDER_SUBTOTAL_MNT = 2_000_000_000;

const ORDER_INCLUDE = {
  items: { include: { product: true } },
  zone: true,
  warehouse: { select: { id: true, code: true, name: true } },
  payments: { orderBy: { createdAt: 'asc' as const } },
  createdBy: { select: { id: true, fullName: true, role: true } },
  completedBy: { select: { id: true, fullName: true, role: true } },
  preparedBy: { select: { id: true, fullName: true, role: true } },
  feeOverrides: { orderBy: { createdAt: 'desc' as const }, include: { actor: { select: { fullName: true, role: true } } } },
  returns: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      items: { include: { orderItem: { include: { product: true } } } },
      createdBy: { select: { id: true, fullName: true, role: true } },
    },
  },
  supplierPayables: true,
  stockReconciliations: {
    orderBy: { createdAt: 'desc' as const },
    include: { actor: { select: { id: true, fullName: true, role: true } } },
  },
};

@Injectable()
export class OrdersService {
  private readonly log = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly logistics: LogisticsService,
    private readonly payments: PaymentService,
    private readonly inventory: InventoryService,
    private readonly ebarimt: EbarimtService,
    private readonly features?: FeaturesService,
  ) {}

  async buildSpecs(
    items: { productId: string; quantity: number; sourceType?: SourceType; supplierName?: string }[],
  ) {
    const ids = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: ids }, active: true } });
    if (products.length !== ids.length) {
      throw new BadRequestException('One or more products are invalid or inactive');
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    let subtotalMnt = 0;
    let weightKg = 0;
    let maxLengthM = 0;
    let volumeM3 = 0;
    const lines = items.map((line) => {
      const product = byId.get(line.productId)!;
      const qty = line.quantity;
      const unitPrice = product.priceMnt;
      const lineTotal = Math.round(unitPrice * qty);
      const w = Number(product.weightKg) * qty;
      const v = Number(product.volumeM3) * qty;
      const len = Number(product.lengthM);
      subtotalMnt += lineTotal;
      if (subtotalMnt > MAX_ORDER_SUBTOTAL_MNT) {
        throw new BadRequestException('Order value is too large');
      }
      weightKg += w;
      volumeM3 += v;
      maxLengthM = Math.max(maxLengthM, len);
      const sourceType =
        line.sourceType ?? product.sourceType ?? SourceType.INTERNAL;
      if (sourceType === SourceType.EXTERNAL_SUPPLIER && !line.supplierName?.trim() && !product.sku) {
        throw new BadRequestException('supplierName is required for external supplier items');
      }
      return {
        productId: product.id,
        quantity: new Prisma.Decimal(qty),
        unitPrice,
        weightKg: new Prisma.Decimal(w),
        lengthM: new Prisma.Decimal(len),
        volumeM3: new Prisma.Decimal(v),
        lineTotal,
        sourceType,
        supplierName:
          sourceType === SourceType.EXTERNAL_SUPPLIER
            ? line.supplierName?.trim() || 'Other store'
            : null,
      };
    });
    return {
      lines,
      specs: {
        subtotalMnt,
        weightKg: Number(weightKg.toFixed(3)),
        maxLengthM: Number(maxLengthM.toFixed(2)),
        volumeM3: Number(volumeM3.toFixed(3)),
      },
    };
  }

  /**
   * Which warehouse an order takes its stock from: the one asked for, else the user's own, else the default.
   * Staff locked to a warehouse can only sell from it.
   */
  private async resolveOrderWarehouse(requested: string | undefined, user: AuthUser) {
    const locked = lockedWarehouseId(user);
    if (locked && requested && requested !== locked) {
      throw new ForbiddenException('You can only create orders for your own warehouse');
    }
    return this.inventory.resolveWarehouseId(this.prisma, requested ?? user.warehouseId ?? null);
  }

  async resolveZoneId(zoneId: string | undefined, method: QuoteOrderDto['deliveryMethod']) {
    if (zoneId) return zoneId;
    if (method !== 'SELF_PICKUP' && method !== 'CUSTOMER_DRIVER') {
      throw new BadRequestException('zoneId is required for DELIVERY');
    }
    const fallback = await this.prisma.zone.findFirst({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (!fallback) throw new BadRequestException('No delivery zone configured');
    return fallback.id;
  }

  async quote(dto: QuoteOrderDto) {
    const { specs } = await this.buildSpecs(dto.items);
    const zoneId = await this.resolveZoneId(dto.zoneId, dto.deliveryMethod);
    return this.logistics.quote({
      zoneId,
      method: dto.deliveryMethod,
      time: dto.timeCondition ?? 'STANDARD',
      unloadingRequested: isZeroFeeMethod(dto.deliveryMethod) ? false : dto.unloadingRequested,
      specs,
    });
  }

  /**
   * Staff locked to a warehouse may only act on that warehouse's orders. Must run BEFORE any write.
   * Orders from before warehouses existed (warehouseId null) belong to the default warehouse.
   */
  private async assertOrderAccess(user: AuthUser, warehouseId: string | null) {
    if (!lockedWarehouseId(user)) return;
    const fallback = warehouseId ? undefined : await this.inventory.defaultWarehouseId();
    assertWarehouseAccess(user, warehouseId, fallback);
  }

  /** List filter for a locked user's own warehouse (including pre-warehouse orders when it is the default). */
  private async orderScope(user: AuthUser): Promise<Prisma.OrderWhereInput> {
    const locked = lockedWarehouseId(user);
    if (!locked) return {};
    const isDefault = locked === (await this.inventory.defaultWarehouseId());
    return isDefault ? { OR: [{ warehouseId: locked }, { warehouseId: null }] } : { warehouseId: locked };
  }

  /** A linked customer must exist and be active, and the customer module must be switched on. */
  private async resolveCustomerId(customerId?: string): Promise<string | null> {
    if (!customerId) return null;
    if (!this.features) throw new BadRequestException('Customer linking is not available');
    await this.features.assertEnabled('CUSTOMERS');
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new BadRequestException('Customer not found');
    if (!customer.isActive) throw new BadRequestException('Customer is deactivated');
    return customer.id;
  }

  async create(dto: CreateOrderDto, user: AuthUser) {
    if (!isPosActor(user.role)) {
      throw new ForbiddenException('Only cashiers, managers, or admin can create orders');
    }
    const zoneId = await this.resolveZoneId(dto.zoneId, dto.deliveryMethod);
    const unloadingRequested = isZeroFeeMethod(dto.deliveryMethod) ? false : dto.unloadingRequested;
    const { lines, specs } = await this.buildSpecs(dto.items);
    const { breakdown } = await this.logistics.quote({
      zoneId,
      method: dto.deliveryMethod,
      time: dto.timeCondition ?? 'STANDARD',
      unloadingRequested,
      specs,
    });

    const billType = dto.billType ?? BillType.CITIZEN;
    const customerRegNumber = dto.customerRegNumber?.trim() || null;
    if (billType === BillType.COMPANY) {
      if (!customerRegNumber || !/^[0-9A-Za-z]{7,12}$/.test(customerRegNumber)) {
        throw new BadRequestException('Company E-Barimt requires a valid registration number (РД, 7–12 characters)');
      }
    }

    const customerId = await this.resolveCustomerId(dto.customerId);
    const hiredOnCreate = this.optionalHiredOnCreate(dto);
    const warehouseId = await this.resolveOrderWarehouse(dto.warehouseId, user);
    const trackingToken = randomBytes(24).toString('base64url');
    const order = await createWithUniqueOrderNumber(this.prisma, (orderNumber) =>
      this.prisma.order.create({
      data: {
        orderNumber,
        status: OrderStatus.PENDING_PAYMENT,
        customerName: dto.customerName,
        customerPhone: dto.customerPhone,
        customerId,
        deliveryAddress: dto.deliveryAddress,
        notes: dto.notes,
        billType,
        customerRegNumber: billType === BillType.COMPANY ? customerRegNumber : null,
        warehouseId,
        zoneId,
        deliveryMethod: dto.deliveryMethod,
        timeCondition: dto.timeCondition ?? 'STANDARD',
        unloadingRequested,
        totalWeightKg: specs.weightKg,
        maxLengthM: specs.maxLengthM,
        totalVolumeM3: specs.volumeM3,
        assignedVehicle: breakdown.assignedVehicle,
        subtotalMnt: breakdown.subtotalMnt,
        deliveryFeeMnt: breakdown.deliveryFeeMnt,
        unloadingFeeMnt: breakdown.unloadingFeeMnt,
        timeAdjustmentMnt: breakdown.timeAdjustmentMnt,
        totalMnt: breakdown.totalMnt,
        createdById: user.id,
        trackingToken,
        ...(hiredOnCreate
          ? {
              vehicleNumber: hiredOnCreate.vehicleNumber,
              driverPhone: hiredOnCreate.driverPhone,
              driverName: hiredOnCreate.driverName,
            }
          : {}),
        items: { create: lines },
      },
      include: ORDER_INCLUDE,
      }),
    );

    const splits =
      dto.payments && dto.payments.length > 0
        ? dto.payments.map((p) => ({ method: p.method, amount: p.amount }))
        : [{ method: dto.paymentMethod ?? CheckoutPaymentMethod.QPAY, amount: order.totalMnt }];
    try {
      const recorded = await this.payments.settleSplits(order.id, splits);
      this.log.log(
        `Order ${order.orderNumber} created; ${recorded.length} payment split(s)`,
      );
    } catch (err) {
      // Cancel only if no money was recorded. If a split is already PAID (e.g. the failure came after the
      // payments were written), leave the order as it is so the cash is not hidden behind a CANCELLED order.
      await this.prisma.$transaction(async (tx) => {
        const paid = await tx.payment.count({ where: { orderId: order.id, status: PaymentStatus.PAID } });
        if (paid > 0) {
          this.log.error(`Order ${order.orderNumber}: payment setup failed after money was recorded; left for manual review`);
          return;
        }
        await tx.payment.updateMany({
          where: { orderId: order.id, status: PaymentStatus.UNPAID },
          data: { status: PaymentStatus.EXPIRED, nextPollAt: null },
        });
        await tx.order.updateMany({
          where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
          data: { status: OrderStatus.CANCELLED, notes: `${dto.notes ?? ''}\nPayment setup failed`.trim() },
        });
      });
      throw err;
    }
    const created = await this.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
    return this.presentOrder(created, user.role);
  }

  /**
   * Fees may change only while NOTHING has been paid. The order total and the QPay invoice amount move
   * together in one transaction: the old invoice is expired and a new one for the new total is issued,
   * so the amount the customer is asked to pay always equals the order total. Orders with any paid split
   * (e.g. cash already taken) are refused; this system has no rule for re-pricing paid money.
   */
  async overrideFees(orderId: string, dto: OverrideFeesDto, user: AuthUser) {
    if (user.role !== Role.BORLUULAGCH) {
      throw new ForbiddenException('Only cashiers (BORLUULAGCH) can override fees');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Fees can only be overridden before payment');
    }
    if (order.payments.some((p) => p.status === PaymentStatus.PAID)) {
      throw new BadRequestException('Fees cannot be changed once any payment has been received');
    }
    if (isZeroFeeMethod(order.deliveryMethod) && (dto.deliveryFeeMnt !== 0 || dto.unloadingFeeMnt !== 0)) {
      throw new BadRequestException(
        'SELF_PICKUP and CUSTOMER_DRIVER must keep delivery and unloading fees at 0₮',
      );
    }
    if (
      dto.deliveryFeeMnt === order.deliveryFeeMnt &&
      dto.unloadingFeeMnt === order.unloadingFeeMnt &&
      dto.timeAdjustmentMnt === order.timeAdjustmentMnt
    ) {
      throw new BadRequestException('Fees are unchanged');
    }

    const newTotal = order.subtotalMnt + dto.deliveryFeeMnt + dto.unloadingFeeMnt + dto.timeAdjustmentMnt;
    if (newTotal <= 0) {
      throw new BadRequestException('Order total must stay above 0₮');
    }

    await this.payments.replaceSoleQpayInvoice(orderId, newTotal, async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING_PAYMENT, totalMnt: order.totalMnt },
        data: {
          deliveryFeeMnt: dto.deliveryFeeMnt,
          unloadingFeeMnt: dto.unloadingFeeMnt,
          timeAdjustmentMnt: dto.timeAdjustmentMnt,
          totalMnt: newTotal,
          feesOverridden: true,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('The order changed while updating fees; nothing was changed');
      }
      await tx.feeOverrideAudit.create({
        data: {
          orderId,
          actorId: user.id,
          reason: dto.reason,
          previousDeliveryFee: order.deliveryFeeMnt,
          previousUnloadingFee: order.unloadingFeeMnt,
          previousTimeAdj: order.timeAdjustmentMnt,
          previousTotal: order.totalMnt,
          newDeliveryFee: dto.deliveryFeeMnt,
          newUnloadingFee: dto.unloadingFeeMnt,
          newTimeAdj: dto.timeAdjustmentMnt,
          newTotal,
        },
      });
    });

    this.log.log(`Fee override on ${order.orderNumber} by ${user.email}: ${dto.reason}`);
    return this.findOne(orderId, user);
  }

  /** Staff cancel of an order that has no recorded payment (see PaymentService.cancelUnpaidOrder). */
  async cancel(orderId: string, user: AuthUser, reason?: string) {
    if (!isPosActor(user.role)) {
      throw new ForbiddenException('Only cashiers, managers, or admin can cancel orders');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    const who = user.fullName ?? user.name ?? user.email ?? user.id;
    await this.payments.cancelUnpaidOrder(orderId, reason?.trim() ? `${reason.trim()} (by ${who})` : `Cancelled by ${who}`);
    return this.findOne(orderId, user);
  }

  private optionalHiredOnCreate(dto: CreateOrderDto) {
    if (!isHiredTransport(dto.deliveryMethod)) return null;
    const vehicleNumber = dto.vehicleNumber?.trim() ?? '';
    const driverPhone = (dto.driverPhone?.trim() ?? '').replace(/\s+/g, '');
    if (!vehicleNumber && !driverPhone) return null;
    if (vehicleNumber.length < 2 || !DRIVER_PHONE_RE.test(driverPhone)) {
      throw new BadRequestException(
        'Provide both truck plate and driver phone, or leave both empty to enter later via the tracking link',
      );
    }
    return { vehicleNumber, driverPhone, driverName: null };
  }

  async findPublicByToken(token: string) {
    const order = await this.prisma.order.findUnique({
      where: { trackingToken: token },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.presentPublic(order);
  }

  async updateTransportByToken(token: string, dto: AssignDriverDto) {
    const order = await this.prisma.order.findUnique({ where: { trackingToken: token } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.COMPLETED) {
      throw new BadRequestException('Transport can no longer be changed after fulfillment or cancellation');
    }
    if (!isHiredTransport(order.deliveryMethod)) {
      throw new BadRequestException(
        'Hired transport notes apply only to company delivery (not self-pickup or customer driver)',
      );
    }
    const hired = this.hiredTransportNotes(order.deliveryMethod, order, dto);
    if (!hired) {
      throw new BadRequestException(
        'Hired transport notes apply only to company delivery (not self-pickup or customer driver)',
      );
    }
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        vehicleNumber: hired.vehicleNumber,
        driverPhone: hired.driverPhone,
        driverName: hired.driverName,
      },
    });
    this.log.log(`Public tracking ${order.orderNumber} hired ${hired.vehicleNumber} / ${hired.driverPhone}`);
    return this.findPublicByToken(token);
  }

  private presentPublic(order: Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>) {
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      deliveryAddress: order.deliveryAddress,
      deliveryMethod: order.deliveryMethod,
      zone: { nameMn: order.zone.nameMn, code: order.zone.code },
      assignedVehicle: order.assignedVehicle,
      vehicleNumber: order.vehicleNumber,
      driverPhone: order.driverPhone,
      totalMnt: order.totalMnt,
      subtotalMnt: order.subtotalMnt,
      deliveryFeeMnt: order.deliveryFeeMnt,
      unloadingFeeMnt: order.unloadingFeeMnt,
      timeAdjustmentMnt: order.timeAdjustmentMnt,
      items: order.items.map((item) => ({
        nameMn: item.product.nameMn,
        quantity: item.quantity,
        unit: item.product.unit,
        lineTotal: item.lineTotal,
      })),
      payments: order.payments.map((p) => ({
        method: p.method,
        status: p.status,
        amountMnt: p.amountMnt,
        qpayQrImage: p.qpayQrImage,
        qpayQrText: p.qpayQrText,
      })),
      trackingToken: order.trackingToken,
    };
  }

  private hiredTransportNotes(
    method: string,
    existing: { vehicleNumber: string | null; driverPhone: string | null; driverName: string | null },
    dto?: CompleteFulfillmentDto | AssignDriverDto,
  ) {
    if (!isHiredTransport(method)) return null;
    const vehicleNumber = (dto?.vehicleNumber?.trim() || existing.vehicleNumber || '').trim();
    const driverPhone = (dto?.driverPhone?.trim() || existing.driverPhone || '').trim().replace(/\s+/g, '');
    const driverName = (dto?.driverName?.trim() || existing.driverName || '').trim() || null;
    if (vehicleNumber.length < 2 || !DRIVER_PHONE_RE.test(driverPhone)) {
      throw new BadRequestException(
        'Hired delivery requires truck plate (vehicleNumber) and driver phone before fulfillment can be completed',
      );
    }
    return { vehicleNumber, driverPhone, driverName };
  }

  async complete(orderId: string, user: AuthUser, dto: CompleteFulfillmentDto = {}) {
    if (!isWarehouseActor(user.role)) {
      throw new ForbiddenException(
        'Warehouse staff, cashiers, managers, or admin can complete fulfillment',
      );
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (order.status !== OrderStatus.READY_FOR_LOADING) {
      throw new BadRequestException(
        `Illegal transition ${order.status} → COMPLETED. Order must be PAID (READY_FOR_LOADING).`,
      );
    }
    // Stock being collected for this order has not reached the dispatch warehouse yet: loading now would
    // ship goods that are not there (and push its balance negative). Receive or cancel those transfers first.
    const gathering = await this.prisma.stockTransfer.count({
      where: { orderId, status: TransferStatus.IN_TRANSIT },
    });
    if (gathering > 0) {
      throw new ConflictException(
        `${gathering} transfer(s) collecting stock for this order are still in transit; receive them first`,
      );
    }
    const hired = this.hiredTransportNotes(order.deliveryMethod, order, dto);
    const completedAt = new Date();
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const updated = await this.prisma.$transaction(
          async (tx) => {
            const claimed = await tx.order.updateMany({
              where: { id: orderId, status: OrderStatus.READY_FOR_LOADING },
              data: {
                status: OrderStatus.COMPLETED,
                completedById: user.id,
                completedAt,
                preparedById: user.id,
                preparedAt: completedAt,
                ...(hired
                  ? {
                      vehicleNumber: hired.vehicleNumber,
                      driverPhone: hired.driverPhone,
                      driverName: hired.driverName,
                    }
                  : {}),
              },
            });
            if (claimed.count !== 1) {
              const current = await tx.order.findUnique({ where: { id: orderId } });
              throw new BadRequestException(
                `Illegal transition ${current?.status ?? 'UNKNOWN'} → COMPLETED. Order must be PAID (READY_FOR_LOADING).`,
              );
            }
            const withItems = await tx.order.findUniqueOrThrow({
              where: { id: orderId },
              include: { items: true },
            });
            // Anything already returned while the order was waiting for loading never left stock,
            // so only the net quantity is deducted (and only the net amount is owed to suppliers).
            const returned = await tx.returnItem.findMany({
              where: { orderItem: { orderId } },
            });
            const plan = planFulfillment(withItems.items, returned);
            await this.inventory.deductForOrder(tx, plan.deductions, {
              warehouseId: withItems.warehouseId,
              refType: 'ORDER',
              refId: orderId,
              reason: `Order ${withItems.orderNumber} completed`,
              actorId: user.id,
            });
            // A manager may already have assigned a supplier before completion (assignSupplier creates
            // the OPEN payable then); never owe the supplier twice for the same line.
            const open = await tx.supplierPayable.findMany({ where: { orderId, status: 'OPEN' } });
            const alreadyOwed = new Set(open.map((p) => p.orderItemId));
            for (const payable of plan.payables) {
              if (alreadyOwed.has(payable.orderItemId)) continue;
              await tx.supplierPayable.create({ data: { orderId, ...payable } });
            }
            return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        this.log.log(
          `Order ${order.orderNumber} COMPLETED at ${completedAt.toISOString()} preparedBy=${user.id} ${user.fullName ?? user.name} (${user.role})${isFallbackPicker(user.role) ? ' fallbackPicker=true' : ''}; stock deducted`,
        );
        return this.presentOrder(updated, user.role);
      } catch (err) {
        lastError = err;
        const code = (err as { code?: string }).code;
        if (code === 'P2034' && attempt < maxAttempts) {
          this.log.warn(`Stock completion retry ${attempt} for ${order.orderNumber} (serialization conflict)`);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async list(user: AuthUser, status?: OrderStatus) {
    if (user.role === Role.ACHIGCH_BELTGEGCH) {
      throw new ForbiddenException('Warehouse staff must use /orders/tickets');
    }
    const where: Prisma.OrderWhereInput = {};
    if (status) where.status = status;
    const scope = await this.orderScope(user);
    Object.assign(where, scope);
    const rows = await this.prisma.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.presentOrders(rows, user.role);
  }

  async listReleaseTickets(user: AuthUser) {
    if (!isWarehouseActor(user.role)) {
      throw new ForbiddenException('Warehouse staff, cashiers, managers, or admin can view release tickets');
    }
    const scope = await this.orderScope(user);
    const rows = await this.prisma.order.findMany({
      where: { status: OrderStatus.READY_FOR_LOADING, ...scope },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return this.presentOrders(rows, user.role);
  }

  async listRecentlyPrepared(user: AuthUser) {
    if (!isWarehouseActor(user.role)) {
      throw new ForbiddenException('Warehouse staff, cashiers, managers, or admin can view release tickets');
    }
    const scope = await this.orderScope(user);
    const rows = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.COMPLETED,
        preparedById: { not: null },
        ...scope,
      },
      include: ORDER_INCLUDE,
      orderBy: { preparedAt: 'desc' },
      take: 200,
    });
    return this.presentOrders(rows, user.role);
  }

  async assignDriver(orderId: string, dto: AssignDriverDto, user: AuthUser) {
    if (!isTransportActor(user.role)) {
      throw new ForbiddenException('Only warehouse staff, managers, or admin can record hired transport notes');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (!isHiredTransport(order.deliveryMethod)) {
      throw new BadRequestException('Hired transport notes apply only to company delivery (not self-pickup or customer driver)');
    }
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('Cannot update transport on a cancelled order');
    }
    const hired = this.hiredTransportNotes(order.deliveryMethod, order, dto);
    if (!hired) {
      throw new BadRequestException('Hired transport notes apply only to company delivery (not self-pickup or customer driver)');
    }
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        vehicleNumber: hired.vehicleNumber,
        driverPhone: hired.driverPhone,
        driverName: hired.driverName,
      },
    });
    this.log.log(
      `Hired transport ${hired.vehicleNumber} / ${hired.driverPhone} on ${order.orderNumber} by ${user.fullName ?? user.name} (${user.id})`,
    );
    return this.findOne(orderId, user);
  }

  async assignSupplier(orderId: string, itemId: string, dto: AssignSupplierDto, user: AuthUser) {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) {
      throw new ForbiddenException('Only managers or admin can assign an external supplier');
    }
    const supplierName = dto.supplierName.trim();
    if (supplierName.length < 2) {
      throw new BadRequestException('supplierName is required');
    }

    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const updated = await this.prisma.$transaction(
          async (tx) => {
            const item = await tx.orderItem.findFirst({
              where: { id: itemId, orderId },
              include: { product: true, returnItems: true, payables: true, order: true },
            });
            if (!item) throw new NotFoundException('Order item not found');
            if (item.order.status === OrderStatus.CANCELLED) {
              throw new BadRequestException('Cannot reconcile a cancelled order');
            }
            if (item.sourceType === SourceType.EXTERNAL_SUPPLIER) {
              throw new BadRequestException('Line is already marked as external supplier');
            }

            const returned = item.returnItems.reduce(
              (sum, row) => sum.plus(row.quantity),
              new Prisma.Decimal(0),
            );
            const remaining = new Prisma.Decimal(item.quantity.toString()).minus(returned);
            if (remaining.lte(0)) {
              throw new BadRequestException('No remaining quantity to assign to a supplier');
            }

            // The stock was taken from the order's warehouse, so it is given back there (and ledgered).
            let restored = new Prisma.Decimal(0);
            let stockBefore: Prisma.Decimal;
            let stockAfter: Prisma.Decimal;
            if (item.order.status === OrderStatus.COMPLETED) {
              restored = remaining;
              const moved = await this.inventory.reconcileRestore(tx, item.productId, remaining, {
                warehouseId: item.order.warehouseId,
                refType: 'ORDER',
                refId: orderId,
                reason: `Supplier "${supplierName}" delivered ${item.order.orderNumber}`,
                actorId: user.id,
              });
              stockBefore = moved.before;
              stockAfter = moved.after;
            } else {
              const warehouseId = item.order.warehouseId ?? (await this.inventory.defaultWarehouseId(tx));
              const balance = await tx.stockBalance.findUnique({
                where: { warehouseId_productId: { warehouseId, productId: item.productId } },
              });
              stockBefore = new Prisma.Decimal((balance?.quantity ?? 0).toString());
              stockAfter = stockBefore;
            }

            await tx.orderItem.update({
              where: { id: itemId },
              data: { sourceType: SourceType.EXTERNAL_SUPPLIER, supplierName },
            });

            const amountMnt = Math.round(item.unitPrice * Number(remaining));
            const openPayable = item.payables.find((p) => p.status === 'OPEN');
            if (openPayable) {
              await tx.supplierPayable.update({
                where: { id: openPayable.id },
                data: { supplierName, quantity: remaining, amountMnt },
              });
            } else {
              await tx.supplierPayable.create({
                data: {
                  orderId,
                  orderItemId: itemId,
                  supplierName,
                  quantity: remaining,
                  amountMnt,
                },
              });
            }

            await tx.stockReconciliationAudit.create({
              data: {
                orderId,
                orderItemId: itemId,
                productId: item.productId,
                actorId: user.id,
                previousSourceType: SourceType.INTERNAL,
                supplierName,
                quantityRestored: restored,
                stockBefore,
                stockAfter,
                amountMnt,
                reason: dto.reason?.trim() || null,
              },
            });

            this.log.log(
              `Reconcile ${item.order.orderNumber} item ${itemId} ${item.product.sku} qty=${remaining.toString()} stock ${stockBefore.toString()}→${stockAfter.toString()} supplier="${supplierName}" by ${user.name} (${user.id})`,
            );
            return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        return this.presentOrder(updated, user.role);
      } catch (err) {
        lastError = err;
        const code = (err as { code?: string }).code;
        if (code === 'P2034' && attempt < maxAttempts) {
          this.log.warn(`Supplier assign retry ${attempt} for order ${orderId} (serialization conflict)`);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async findOne(id: string, user: AuthUser) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    if (user.role === Role.ACHIGCH_BELTGEGCH && order.status === OrderStatus.PENDING_PAYMENT) {
      throw new ForbiddenException();
    }
    return this.presentOrder(order, user.role);
  }

  async issueEbarimt(orderId: string, user: AuthUser) {
    if (user.role !== Role.BORLUULAGCH && user.role !== Role.ADMIN && user.role !== Role.MANAGER) {
      throw new ForbiddenException('Only cashiers, managers, or admin can issue E-Barimt');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.assertOrderAccess(user, order.warehouseId);
    await this.ebarimt.issueForOrder(orderId, { quiet: false });
    return this.findOne(orderId, user);
  }

  private presentOrder<T extends { lottery?: string | null; qrCode?: string | null; ebarimtStatus?: string | null; ebarimtError?: string | null }>(
    order: T,
    role: Role,
  ): T {
    if (role !== Role.BORLUULAGCH) return order;
    return {
      ...order,
      lottery: null,
      qrCode: null,
      ebarimtPayload: null,
      ebarimtError: order.ebarimtStatus === 'FAILED' ? 'И-Баримт олгоход алдаа гарлаа' : null,
    } as T;
  }

  private presentOrders<T extends { lottery?: string | null; qrCode?: string | null; ebarimtStatus?: string | null; ebarimtError?: string | null }>(
    rows: T[],
    role: Role,
  ) {
    return rows.map((row) => this.presentOrder(row, role));
  }

}
